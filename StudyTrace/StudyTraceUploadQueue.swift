//
//  StudyTraceUploadQueue.swift
//  StudyTrace
//
//  Persistent, retrying uploads for StudyTrace's own requests (telemetry
//  batches and Battery screenshots). AWARE's sensor sync is separate.
//
//  Request bodies are written to disk and sent with a background URLSession,
//  so uploads survive network loss, app suspension, and relaunch. Every item
//  carries an idempotency key the server uses to drop duplicates, which makes
//  retrying always safe.
//

import UIKit
import CryptoKit
import AWAREFramework

final class StudyTraceUploadQueue: NSObject {

    static let shared = StudyTraceUploadQueue()
    static let sessionIdentifier = "edu.studytrace.uploads"

    /// Set by AppDelegate when iOS relaunches the app to deliver background
    /// session events; called once those events have been handled.
    var backgroundEventsCompletionHandler: (() -> Void)?

    private struct Item: Codable {
        let id: String
        let studyId: String
        /// Path below /api/v1/studies/{studyId}/
        let path: String
        let kind: String
        let createdAt: Date
        var attempts: Int
        var nextAttemptAt: Date
    }

    private static let maxAttempts = 30
    private static let telemetryBatchSize = 25

    private let queue = DispatchQueue(label: "edu.studytrace.upload-queue")
    private var items: [Item] = []
    private var started = Set<String>()
    private var telemetryBuffer: [String: [[String: Any]]] = [:]
    private var loaded = false

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    // MARK: - Public API

    /// Reconnects to the background session (so results of uploads that
    /// finished while the app was not running are delivered) and sends
    /// anything that is due.
    func activate() {
        queue.async {
            self.loadIfNeeded()
            _ = self.session
            self.drainLocked()
        }
    }

    /// Queues a request body. `id` is sent as the idempotency key and must be
    /// stable for one logical upload (e.g. a hash of the screenshot).
    func enqueue(kind: String, path: String, body: Data, id: String) {
        guard let context = StudyTraceTelemetry.studyContext() else { return }
        queue.async {
            self.loadIfNeeded()
            self.enqueueLocked(kind: kind, path: path, body: body, id: id, studyId: context.studyId)
            self.drainLocked()
        }
    }

    /// Buffers a telemetry row; rows are sent in batches.
    func addTelemetry(sensor: String, row: [String: Any]) {
        queue.async {
            self.loadIfNeeded()
            self.telemetryBuffer[sensor, default: []].append(row)
            self.persistTelemetryBuffer()
            let buffered = self.telemetryBuffer.values.reduce(0) { $0 + $1.count }
            if buffered >= Self.telemetryBatchSize {
                self.flushTelemetryLocked()
            }
        }
    }

    /// Moves buffered telemetry into the upload queue and starts sending.
    func flushTelemetry() {
        queue.async {
            self.loadIfNeeded()
            self.flushTelemetryLocked()
        }
    }

    /// Sends anything that is due (e.g. after a backoff delay has passed).
    func drain() {
        queue.async {
            self.loadIfNeeded()
            self.drainLocked()
        }
    }

    /// Deletes everything queued or buffered. Used on withdrawal: nothing
    /// collected on this iPhone may be uploaded afterwards.
    func purge() {
        queue.async {
            self.loadIfNeeded()
            self.session.getAllTasks { tasks in tasks.forEach { $0.cancel() } }
            for item in self.items {
                try? FileManager.default.removeItem(at: self.bodyURL(item.id))
            }
            self.items.removeAll()
            self.started.removeAll()
            self.telemetryBuffer.removeAll()
            self.persist()
            self.persistTelemetryBuffer()
        }
    }

    /// Number of uploads waiting to be sent (reported in heartbeats).
    var pendingCount: Int {
        return queue.sync {
            loadIfNeeded()
            return items.count + telemetryBuffer.values.reduce(0) { $0 + $1.count }
        }
    }

    // MARK: - Queue internals (always on `queue`)

    private func enqueueLocked(kind: String, path: String, body: Data, id: String, studyId: String) {
        guard !items.contains(where: { $0.id == id }) else { return }
        do {
            try body.write(to: bodyURL(id), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            NSLog("[StudyTraceUploadQueue] Could not store %@ upload: %@", kind, error.localizedDescription)
            return
        }
        items.append(Item(id: id, studyId: studyId, path: path, kind: kind,
                          createdAt: Date(), attempts: 0, nextAttemptAt: Date()))
        persist()
    }

    private func flushTelemetryLocked() {
        guard !telemetryBuffer.isEmpty else { return }
        guard let context = StudyTraceTelemetry.studyContext() else {
            // Not joined to a study (or withdrawn): nowhere to send these.
            telemetryBuffer.removeAll()
            persistTelemetryBuffer()
            return
        }
        for (sensor, rows) in telemetryBuffer where !rows.isEmpty {
            let payload: [String: Any] = ["device_id": context.deviceId, "rows": rows]
            guard JSONSerialization.isValidJSONObject(payload),
                  let body = try? JSONSerialization.data(withJSONObject: payload, options: []) else {
                continue
            }
            enqueueLocked(kind: "telemetry", path: "sensors/\(sensor)/data", body: body,
                          id: UUID().uuidString, studyId: context.studyId)
        }
        telemetryBuffer.removeAll()
        persistTelemetryBuffer()
        drainLocked()
    }

    private func drainLocked() {
        guard !items.isEmpty, let context = StudyTraceTelemetry.studyContext() else { return }
        session.getAllTasks { tasks in
            let inFlight = Set(tasks.compactMap { $0.taskDescription })
            self.queue.async {
                let now = Date()
                // Items queued for a different study must never be sent to
                // the server of the study joined now.
                let stale = self.items.filter { $0.studyId != context.studyId }
                if !stale.isEmpty {
                    stale.forEach { try? FileManager.default.removeItem(at: self.bodyURL($0.id)) }
                    self.items.removeAll { $0.studyId != context.studyId }
                    self.persist()
                }
                for item in self.items where item.nextAttemptAt <= now
                    && !inFlight.contains(item.id) && !self.started.contains(item.id) {
                    let url = context.baseURL
                        .appendingPathComponent("api/v1/studies")
                        .appendingPathComponent(item.studyId)
                        .appendingPathComponent(item.path)
                    var request = URLRequest(url: url)
                    request.httpMethod = "POST"
                    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    request.setValue("Bearer \(context.password)", forHTTPHeaderField: "Authorization")
                    request.setValue(item.id, forHTTPHeaderField: "Idempotency-Key")
                    let task = self.session.uploadTask(with: request, fromFile: self.bodyURL(item.id))
                    task.taskDescription = item.id
                    self.started.insert(item.id)
                    task.resume()
                }
            }
        }
    }

    private func complete(id: String, status: Int, error: Error?) {
        loadIfNeeded()
        started.remove(id)
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        let succeeded = (200..<300).contains(status)
        let retryable = error != nil || status == 0 || status == 408 || status == 429 || status >= 500
        if succeeded || !retryable || items[index].attempts + 1 >= Self.maxAttempts {
            let item = items.remove(at: index)
            try? FileManager.default.removeItem(at: bodyURL(item.id))
            if !succeeded {
                NSLog("[StudyTraceUploadQueue] Dropped %@ upload after HTTP %d (%d attempts)",
                      item.kind, status, item.attempts + 1)
            }
        } else {
            items[index].attempts += 1
            // Exponential backoff: 1 min, 2 min, 4 min ... capped at 6 hours.
            let delay = min(6 * 3600, 60 * pow(2, Double(items[index].attempts - 1)))
            items[index].nextAttemptAt = Date().addingTimeInterval(delay)
        }
        persist()
    }

    // MARK: - Persistence

    private var directory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        var dir = base.appendingPathComponent("StudyTraceUploads", isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.createDirectory(
                at: dir,
                withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
            )
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? dir.setResourceValues(values)
        }
        return dir
    }

    private var indexURL: URL { directory.appendingPathComponent("queue.json") }
    private var telemetryBufferURL: URL { directory.appendingPathComponent("telemetry-buffer.json") }

    private func bodyURL(_ id: String) -> URL {
        let safe = id.replacingOccurrences(of: "[^A-Za-z0-9_-]", with: "_", options: .regularExpression)
        return directory.appendingPathComponent("\(safe).body")
    }

    private func loadIfNeeded() {
        guard !loaded else { return }
        loaded = true
        if let data = try? Data(contentsOf: indexURL),
           let decoded = try? JSONDecoder().decode([Item].self, from: data) {
            items = decoded
        }
        if let data = try? Data(contentsOf: telemetryBufferURL),
           // Parenthesized: the app builds in Swift 4.2 mode, where try? does
           // not flatten the optional produced by as?.
           let decoded = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: [[String: Any]]] {
            telemetryBuffer = decoded
        }
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(items) else { return }
        try? data.write(to: indexURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private func persistTelemetryBuffer() {
        guard JSONSerialization.isValidJSONObject(telemetryBuffer),
              let data = try? JSONSerialization.data(withJSONObject: telemetryBuffer, options: []) else { return }
        try? data.write(to: telemetryBufferURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}

extension StudyTraceUploadQueue: URLSessionDataDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let id = task.taskDescription else { return }
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        queue.async {
            self.complete(id: id, status: status, error: error)
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async {
            self.backgroundEventsCompletionHandler?()
            self.backgroundEventsCompletionHandler = nil
        }
    }
}

// MARK: - Usage screenshot uploads

/// Uploads a Battery or Screen Time screenshot together with the text the
/// phone recognized in it; the server extracts the values from that text
/// and flags unclear screenshots for review. Tries a foreground upload
/// first so the participant gets immediate feedback; if the network or
/// server is unavailable, the upload is saved to the queue and sent later.
enum UsageScreenshotUploader {

    struct Feedback {
        let appRowsDetected: Int
        let needsReview: Bool
        let qaReason: String
        let message: String
    }

    enum Outcome {
        /// Uploaded now; feedback is nil if the server sent none.
        case uploaded(Feedback?)
        /// Saved on the phone and queued for automatic upload.
        case queued
        /// Could not be uploaded or queued; message is participant-facing.
        case failed(title: String, message: String)
    }

    static func upload(_ image: UIImage, submission: UsageScreenshotSubmission, completion: @escaping (Outcome) -> Void) {
        guard StudyParticipationController.hasConsent(),
              let context = StudyTraceTelemetry.studyContext() else {
            completion(.failed(title: "Study Not Configured",
                               message: "Join a study before uploading a screenshot."))
            return
        }
        // Re-encoding drops the original file's metadata (location, device).
        // Screenshots are PNGs; keep them lossless (sharper text) unless huge.
        guard let imageData = encodedScreenshot(image) else {
            completion(.failed(title: "Upload Failed",
                               message: "StudyTrace could not prepare the selected screenshot."))
            return
        }
        let uploadId = SHA256.hash(data: imageData).map { String(format: "%02x", $0) }.joined()
        var payload: [String: Any] = [
            "device_id": context.deviceId,
            "timestamp": Date().timeIntervalSince1970 * 1000,
            "upload_id": uploadId,
            "screenshot_kind": submission.kind.rawValue,
            "screenshot_base64": imageData.base64EncodedString(),
            "timezone": TimeZone.current.identifier
        ]
        // No confirmed_rows: the participant does not review the values, so
        // the server parses this text (and OCRs the image if it is empty).
        if !submission.ocrText.isEmpty {
            payload["ocr_text"] = submission.ocrText
        }
        if let capturedAt = submission.capturedAt {
            payload["captured_at"] = capturedAt.timeIntervalSince1970 * 1000
        }
        switch submission.kind {
        case .battery:
            payload["usage_window"] = submission.usageWindow
        case .screenTimeActivity:
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.dateFormat = "yyyy-MM-dd"
            payload["activity_date"] = formatter.string(from: submission.activityDate)
        }
        guard JSONSerialization.isValidJSONObject(payload),
              let body = try? JSONSerialization.data(withJSONObject: payload, options: []) else {
            completion(.failed(title: "Upload Failed",
                               message: "StudyTrace could not prepare the selected screenshot."))
            return
        }
        let kind = submission.kind.rawValue
        StudyTraceTelemetry.recordEvent("usage_screenshot_upload_started", metadata: [
            "kind": kind,
            "image_bytes": imageData.count,
            "ocr_characters": submission.ocrText.count
        ])

        var request = URLRequest(url: context.baseURL
            .appendingPathComponent("api/v1/studies")
            .appendingPathComponent(context.studyId)
            .appendingPathComponent("usage-screenshots"))
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(context.password)", forHTTPHeaderField: "Authorization")
        request.setValue(uploadId, forHTTPHeaderField: "Idempotency-Key")

        URLSession.shared.uploadTask(with: request, from: body) { data, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let outcome: Outcome
            if error == nil, (200..<300).contains(status) {
                let feedback = parseFeedback(data)
                StudyTraceTelemetry.recordEvent("usage_screenshot_upload_succeeded", metadata: [
                    "kind": kind,
                    "http_status": status,
                    "app_rows_detected": feedback?.appRowsDetected ?? 0,
                    "needs_review": feedback?.needsReview ?? false
                ])
                outcome = .uploaded(feedback)
            } else if error != nil || status == 0 || status == 408 || status == 429 || status >= 500 {
                StudyTraceUploadQueue.shared.enqueue(kind: "usage_screenshot", path: "usage-screenshots",
                                                     body: body, id: uploadId)
                StudyTraceTelemetry.recordEvent("usage_screenshot_upload_queued", metadata: [
                    "kind": kind,
                    "http_status": status,
                    "transport_error": error?.localizedDescription ?? ""
                ])
                outcome = .queued
            } else {
                // The response body is not logged: it can echo request data.
                StudyTraceTelemetry.recordEvent("usage_screenshot_upload_failed", metadata: [
                    "kind": kind,
                    "http_status": status
                ])
                outcome = .failed(title: "Upload Failed",
                                  message: "The study server returned HTTP \(status). Please contact your research team if this keeps happening.")
            }
            DispatchQueue.main.async { completion(outcome) }
        }.resume()
    }

    private static func encodedScreenshot(_ image: UIImage) -> Data? {
        if let png = image.pngData(), png.count <= 8 * 1024 * 1024 {
            return png
        }
        return image.jpegData(compressionQuality: 0.9)
    }

    private static func parseFeedback(_ data: Data?) -> Feedback? {
        guard let data = data,
              let json = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any],
              let feedback = json["feedback"] as? [String: Any] else {
            return nil
        }
        return Feedback(
            appRowsDetected: feedback["app_rows_detected"] as? Int ?? 0,
            needsReview: feedback["needs_review"] as? Bool ?? false,
            qaReason: feedback["qa_reason"] as? String ?? "",
            message: feedback["message"] as? String ?? "Your screenshot was uploaded to the study server."
        )
    }
}
