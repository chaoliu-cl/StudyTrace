//
//  UsageScreenshotFlow.swift
//  StudyTrace
//
//  Participant-submitted usage screenshots: iOS Settings > Battery and
//  Settings > Screen Time > See All Activity. The phone reads the screenshot
//  with on-device OCR and uploads the recognized text with the image; the
//  server extracts the values. Participants cannot view or edit the values.
//

import UIKit
import PhotosUI
import Vision
import ImageIO
import UniformTypeIdentifiers

private func loc(_ key: String, _ english: String) -> String {
    return NSLocalizedString(key, tableName: nil, bundle: .main, value: english, comment: "")
}

// MARK: - Screenshot kinds

enum UsageScreenshotKind: String {
    case battery
    case screenTimeActivity = "screen_time_activity"

    /// esm_trigger of the survey prompt that asks for this screenshot.
    var promptTrigger: String {
        switch self {
        case .battery: return "battery_usage_screenshot"
        case .screenTimeActivity: return "screen_time_activity_screenshot"
        }
    }

    var heroSymbol: String {
        switch self {
        case .battery: return "battery.100.bolt"
        case .screenTimeActivity: return "hourglass"
        }
    }

    var promptButtonTitle: String {
        switch self {
        case .battery: return loc("shot_battery_prompt", " Battery screenshot upload available")
        case .screenTimeActivity: return loc("shot_activity_prompt", " Screen Time screenshot upload available")
        }
    }

    var instructionTitle: String {
        switch self {
        case .battery: return loc("shot_battery_title", "Take one Battery Usage screenshot")
        case .screenTimeActivity: return loc("shot_activity_title", "Take one Screen Time screenshot")
        }
    }

    var instructionDetail: String {
        switch self {
        case .battery:
            return loc("shot_battery_detail", "Apple does not let apps read Screen Time directly, so the study uses the iOS Battery screen. StudyTrace uploads the screenshot you choose to the study server.")
        case .screenTimeActivity:
            return loc("shot_activity_detail", "This screen shows one day of screen time, pickups, and notifications. StudyTrace uploads the screenshot you choose to the study server.")
        }
    }

    var steps: [String] {
        switch self {
        case .battery:
            return [
                loc("shot_battery_step1", "1. Leave StudyTrace and open iPhone Settings."),
                loc("shot_battery_step2", "2. Tap Battery."),
                loc("shot_battery_step3", "3. Keep Last 24 Hours selected and tap View All Battery Usage so app rows are visible."),
                loc("shot_battery_step4", "4. Take a screenshot."),
                loc("shot_battery_step5", "5. Return here and choose that screenshot.")
            ]
        case .screenTimeActivity:
            return [
                loc("shot_activity_step1", "1. Leave StudyTrace and open iPhone Settings."),
                loc("shot_activity_step2", "2. Tap Screen Time, then See All App & Website Activity."),
                loc("shot_activity_step3", "3. Choose Day and tap yesterday's bar."),
                loc("shot_activity_step4", "4. Take a screenshot showing the total, Most Used, Pickups, and Notifications (scroll and take a second one if needed)."),
                loc("shot_activity_step5", "5. Return here and choose that screenshot.")
            ]
        }
    }

    var chooseButtonTitle: String {
        switch self {
        case .battery: return loc("shot_battery_choose", "Choose Battery screenshot")
        case .screenTimeActivity: return loc("shot_activity_choose", "Choose Screen Time screenshot")
        }
    }
}

// MARK: - Parsing (pure; unit tested)

enum UsageScreenshotParser {

    struct AppRow: Equatable {
        var appName: String
        var seconds: Int?
        var percent: Int?
    }

    struct ActivitySummary: Equatable {
        var totalSeconds: Int?
        var pickups: Int?
        var notifications: Int?
    }

    /// iOS section headings and labels that are not app names (English and Japanese).
    private static let headings: Set<String> = [
        "settings", "battery", "battery usage", "battery usage by app", "view all battery usage",
        "last 24 hours", "last 10 days", "screen on", "screen off", "activity", "activity by app",
        "usage by app", "show activity", "show battery usage", "battery level", "insights and suggestions",
        "screen time", "most used", "pickups", "total pickups", "first pickup", "notifications",
        "total notifications", "today", "yesterday", "day", "week", "show categories", "show apps",
        "バッテリー", "バッテリーの使用状況", "アプリごとのバッテリー使用状況", "アプリごとのアクティビティ",
        "過去24時間", "過去10日間", "アクティビティを表示", "バッテリー使用状況を表示", "画面オン", "画面オフ",
        "バッテリー残量", "スクリーンタイム", "よく使われたもの", "持ち上げ", "通知", "今日", "昨日", "日", "週"
    ]

    /// Seconds for "1h 12m", "45m", "1 hr 5 min", "1時間5分", "45分". Clock
    /// times such as the status bar's "9:41" are deliberately not durations.
    static func durationSeconds(in line: String) -> Int? {
        let hourUnits = "hours|hour|hrs|hr|h|時間"
        let minuteUnits = "minutes|minute|mins|min|m|分"
        if let groups = match("(\\d{1,2})\\s*(?:\(hourUnits))(?![a-z])\\s*(?:(\\d{1,2})\\s*(?:\(minuteUnits))(?![a-z]))?", in: line) {
            let hours = Int(groups[0]) ?? 0
            let minutes = groups.count > 1 ? (Int(groups[1]) ?? 0) : 0
            return hours * 3600 + minutes * 60
        }
        if let groups = match("(\\d{1,3})\\s*(?:\(minuteUnits))(?![a-z])", in: line) {
            return (Int(groups[0]) ?? 0) * 60
        }
        return nil
    }

    static func percent(in line: String) -> Int? {
        guard let groups = match("(\\d{1,3})\\s*[%％]", in: line), let value = Int(groups[0]), (0...100).contains(value) else {
            return nil
        }
        return value
    }

    static func isHeading(_ line: String) -> Bool {
        return headings.contains(line.trimmingCharacters(in: .whitespaces).lowercased())
    }

    static func looksLikeAppName(_ line: String) -> Bool {
        let text = line.trimmingCharacters(in: .whitespaces)
        guard (2...60).contains(text.count), !isHeading(text) else { return false }
        guard text.rangeOfCharacter(from: .letters) != nil else { return false }
        return durationSeconds(in: text) == nil && percent(in: text) == nil
    }

    /// App rows from a Settings > Battery screenshot.
    static func batteryRows(from text: String) -> [AppRow] {
        let lines = cleanLines(text)
        var rows: [AppRow] = []
        var seen = Set<String>()
        var i = 0
        while i < lines.count {
            let line = lines[i]
            if let inline = inlineRow(line), !seen.contains(inline.appName.lowercased()) {
                // "Instagram 21%" on one visual line; the duration may follow.
                var row = inline
                if row.seconds == nil, i + 1 < lines.count, !looksLikeAppName(lines[i + 1]) {
                    row.seconds = preferredDuration(in: [lines[i + 1]])
                }
                rows.append(row)
                seen.insert(row.appName.lowercased())
            } else if looksLikeAppName(line), !seen.contains(line.lowercased()) {
                var block: [String] = []
                var j = i + 1
                while j < lines.count, j <= i + 4, !looksLikeAppName(lines[j]) {
                    block.append(lines[j])
                    j += 1
                }
                let seconds = preferredDuration(in: block)
                let pct = block.compactMap { percent(in: $0) }.first
                if seconds != nil || pct != nil {
                    rows.append(AppRow(appName: line, seconds: seconds, percent: pct))
                    seen.insert(line.lowercased())
                }
            }
            i += 1
        }
        return rows
    }

    /// Totals and "Most Used" apps from a Screen Time See All Activity screenshot.
    static func activity(from text: String) -> (summary: ActivitySummary, apps: [AppRow]) {
        let lines = cleanLines(text)
        let lower = lines.map { $0.lowercased() }
        func index(of needles: [String], from start: Int = 0) -> Int? {
            guard start < lower.count else { return nil }
            return (start..<lower.count).first { i in needles.contains { lower[i].contains($0) } }
        }
        func count(near needles: [String]) -> Int? {
            guard let at = index(of: needles) else { return nil }
            for i in at..<min(lines.count, at + 4) {
                let cleaned = lines[i].replacingOccurrences(of: ",", with: "")
                if durationSeconds(in: cleaned) == nil,
                   let groups = match("(?:^|\\s)(\\d{1,5})(?:\\s*(?:回|件))?$", in: cleaned),
                   let value = Int(groups[0]) {
                    return value
                }
            }
            return nil
        }

        let mostUsed = index(of: ["most used", "よく使われた"])
        let pickupsAt = index(of: ["pickup", "持ち上げ"])
        let notificationsAt = index(of: ["notification", "通知"])
        var total: Int?
        for i in 0..<(mostUsed ?? lines.count) {
            if let seconds = durationSeconds(in: lines[i]) {
                total = seconds
                break
            }
        }

        var apps: [AppRow] = []
        if let start = mostUsed {
            let stop = [pickupsAt, notificationsAt].compactMap { $0 }.filter { $0 > start }.min() ?? lines.count
            var i = start + 1
            while i < stop {
                if looksLikeAppName(lines[i]) {
                    let next = [i + 1, i + 2].filter { $0 < stop }.compactMap { durationSeconds(in: lines[$0]) }.first
                    if let seconds = next {
                        apps.append(AppRow(appName: lines[i], seconds: seconds, percent: nil))
                    }
                } else if let inline = inlineRow(lines[i]) {
                    apps.append(AppRow(appName: inline.appName, seconds: inline.seconds, percent: nil))
                }
                i += 1
            }
        }
        let summary = ActivitySummary(
            totalSeconds: total,
            pickups: count(near: ["total pickups", "pickups", "持ち上げ"]),
            notifications: count(near: ["total notifications", "notifications", "通知"])
        )
        return (summary, apps)
    }

    static func isLikelyScreenshot(of kind: UsageScreenshotKind, text: String) -> Bool {
        let lower = text.lowercased()
        switch kind {
        case .battery:
            return (lower.contains("battery") || lower.contains("バッテリー")) && !batteryRows(from: text).isEmpty
        case .screenTimeActivity:
            let markers = ["screen time", "スクリーンタイム", "most used", "よく使われた", "pickups", "持ち上げ"]
            return markers.contains { lower.contains($0) }
        }
    }

    /// Day offset hinted by the screenshot: 0 for today, -1 for yesterday.
    static func dayOffsetHint(in text: String) -> Int? {
        let lower = text.lowercased()
        if lower.contains("yesterday") || lower.contains("昨日") { return -1 }
        if lower.contains("today") || lower.contains("今日") { return 0 }
        return nil
    }

    // MARK: Helpers

    private static func cleanLines(_ text: String) -> [String] {
        return text.components(separatedBy: .newlines)
            .map { $0.replacingOccurrences(of: "|", with: " ").trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    private static func inlineRow(_ line: String) -> AppRow? {
        let seconds = durationSeconds(in: line)
        let pct = percent(in: line)
        guard seconds != nil || pct != nil else { return nil }
        var name = line
        for pattern in ["\\d{1,2}\\s*(?:hours|hour|hrs|hr|h|時間)(?![a-z])\\s*(?:\\d{1,2}\\s*(?:minutes|minute|mins|min|m|分)(?![a-z]))?",
                        "\\d{1,3}\\s*(?:minutes|minute|mins|min|m|分)(?![a-z])",
                        "\\d{1,3}\\s*[%％]",
                        "(?i)on screen|screen on|background|画面オン|バックグラウンド"] {
            name = name.replacingOccurrences(of: pattern, with: " ", options: [.regularExpression, .caseInsensitive])
        }
        name = name.trimmingCharacters(in: CharacterSet.whitespaces.union(.punctuationCharacters))
        guard looksLikeAppName(name) else { return nil }
        return AppRow(appName: name, seconds: seconds, percent: pct)
    }

    /// Prefers the on-screen duration over the background duration.
    private static func preferredDuration(in lines: [String]) -> Int? {
        let candidates = lines.compactMap { line -> (Int, Int)? in
            guard let seconds = durationSeconds(in: line) else { return nil }
            let lower = line.lowercased()
            let priority = lower.contains("background") || lower.contains("バックグラウンド") ? 2
                : (lower.contains("screen") || lower.contains("画面") ? 0 : 1)
            return (priority, seconds)
        }
        return candidates.sorted { $0.0 < $1.0 }.first?.1
    }

    private static func match(_ pattern: String, in text: String) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let result = regex.firstMatch(in: text, options: [], range: NSRange(text.startIndex..., in: text)) else {
            return nil
        }
        var groups: [String] = []
        for index in 1..<max(result.numberOfRanges, 2) {
            guard index < result.numberOfRanges,
                  let range = Range(result.range(at: index), in: text) else { continue }
            groups.append(String(text[range]))
        }
        return groups.isEmpty ? nil : groups
    }
}

// MARK: - On-device OCR

enum UsageScreenshotOCR {
    /// Recognizes text and returns it as visual lines, top to bottom, with
    /// items on the same row (e.g. app name and percentage) joined by spaces.
    static func recognizeLines(in image: UIImage, completion: @escaping (String) -> Void) {
        guard let cgImage = image.cgImage else {
            completion("")
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = false   // app names are not dictionary words
            var languages = ["en-US"]
            if #available(iOS 16.0, *) {
                languages.append("ja-JP")
                request.automaticallyDetectsLanguage = true
            }
            request.recognitionLanguages = languages
            let handler = VNImageRequestHandler(cgImage: cgImage, orientation: exifOrientation(image.imageOrientation), options: [:])
            try? handler.perform([request])
            let observations = (request.results ?? []).compactMap { observation -> (CGRect, String)? in
                guard let text = observation.topCandidates(1).first?.string else { return nil }
                return (observation.boundingBox, text)
            }
            let text = groupIntoLines(observations)
            DispatchQueue.main.async { completion(text) }
        }
    }

    private static func groupIntoLines(_ items: [(CGRect, String)]) -> String {
        // Vision's origin is bottom-left; sort top to bottom.
        let sorted = items.sorted { $0.0.midY > $1.0.midY }
        var lines: [[(CGRect, String)]] = []
        for item in sorted {
            if let last = lines.last?.first, abs(last.0.midY - item.0.midY) < max(last.0.height, item.0.height) * 0.5 {
                lines[lines.count - 1].append(item)
            } else {
                lines.append([item])
            }
        }
        return lines
            .map { $0.sorted { $0.0.minX < $1.0.minX }.map { $0.1 }.joined(separator: " ") }
            .joined(separator: "\n")
    }

    private static func exifOrientation(_ orientation: UIImage.Orientation) -> CGImagePropertyOrientation {
        switch orientation {
        case .up: return .up
        case .upMirrored: return .upMirrored
        case .down: return .down
        case .downMirrored: return .downMirrored
        case .left: return .left
        case .leftMirrored: return .leftMirrored
        case .right: return .right
        case .rightMirrored: return .rightMirrored
        @unknown default: return .up
        }
    }

    /// When the screenshot was taken, from its EXIF/TIFF metadata (local time).
    static func captureDate(from data: Data) -> Date? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else {
            return nil
        }
        let exif = properties[kCGImagePropertyExifDictionary] as? [CFString: Any]
        let tiff = properties[kCGImagePropertyTIFFDictionary] as? [CFString: Any]
        guard let raw = (exif?[kCGImagePropertyExifDateTimeOriginal] ?? tiff?[kCGImagePropertyTIFFDateTime]) as? String else {
            return nil
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone.current
        formatter.dateFormat = "yyyy:MM:dd HH:mm:ss"
        return formatter.date(from: raw)
    }
}

// MARK: - What gets uploaded

/// The screenshot's context sent with the image. App rows and totals are
/// extracted on the server from `ocrText`; the participant never edits them.
struct UsageScreenshotSubmission {
    var kind: UsageScreenshotKind
    /// Battery screenshots: the tab the instructions ask participants to keep selected.
    var usageWindow = "last_24_hours"
    /// Screen Time screenshots: the day shown (yesterday unless the text says otherwise).
    var activityDate = Date()
    var capturedAt: Date?
    var ocrText = ""

    init(kind: UsageScreenshotKind) {
        self.kind = kind
    }
}

// MARK: - Coordinator

/// Drives the whole flow: instructions → photo picker → on-device OCR →
/// upload. Owned by the presenting screen.
final class UsageScreenshotCoordinator: NSObject, PHPickerViewControllerDelegate {

    private weak var presenter: UIViewController?
    private var kind: UsageScreenshotKind = .battery
    private var completion: ((UsageScreenshotKind, UsageScreenshotUploader.Outcome) -> Void)?
    private(set) var isBusy = false
    private var progress: UIViewController?

    func start(kind: UsageScreenshotKind,
               from presenter: UIViewController,
               showInstructions: Bool = true,
               completion: @escaping (UsageScreenshotKind, UsageScreenshotUploader.Outcome) -> Void) {
        guard !isBusy else { return }
        self.kind = kind
        self.presenter = presenter
        self.completion = completion
        if showInstructions {
            presentInstructions()
        } else {
            presentPicker()
        }
    }

    private func presentInstructions() {
        guard let presenter = presenter else { return }
        let wizard = UIViewController()
        wizard.view.backgroundColor = AWARETheme.canvas
        wizard.title = kind.chooseButtonTitle

        let hero = UIImageView(image: UIImage(systemName: kind.heroSymbol))
        hero.tintColor = AWARETheme.warmAccent
        hero.contentMode = .scaleAspectFit
        hero.heightAnchor.constraint(equalToConstant: 58).isActive = true
        hero.isAccessibilityElement = false

        let titleLabel = Self.label(kind.instructionTitle, style: .title2, color: AWARETheme.ink)
        let detailLabel = Self.label(kind.instructionDetail, style: .body, color: AWARETheme.secondaryInk)
        let stepsLabel = Self.label(kind.steps.joined(separator: "\n"), style: .body, color: AWARETheme.ink)

        let chooseButton = Self.primaryButton(kind.chooseButtonTitle, symbol: "photo.on.rectangle.angled")
        chooseButton.addAction(UIAction { [weak self, weak wizard] _ in
            wizard?.dismiss(animated: true) { self?.presentPicker() }
        }, for: .touchUpInside)

        let laterButton = UIButton(type: .system)
        laterButton.setTitle(loc("shot_later", "I will upload later"), for: .normal)
        laterButton.titleLabel?.font = UIFont.preferredFont(forTextStyle: .body)
        laterButton.addAction(UIAction { [weak wizard] _ in wizard?.dismiss(animated: true) }, for: .touchUpInside)

        let nav = UINavigationController(rootViewController: Self.scrollingController(
            wizard, views: [hero, titleLabel, detailLabel, stepsLabel, chooseButton, laterButton]))
        wizard.navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak wizard] _ in
            wizard?.dismiss(animated: true)
        })
        presenter.present(nav, animated: true)
    }

    func presentPicker() {
        guard let presenter = presenter else { return }
        var configuration = PHPickerConfiguration(photoLibrary: .shared())
        configuration.filter = .images
        configuration.selectionLimit = 1
        configuration.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = self
        presenter.present(picker, animated: true)
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        guard let provider = results.first?.itemProvider else {
            // Cancelled, possibly after "Choose another screenshot".
            isBusy = false
            picker.dismiss(animated: true)
            return
        }
        isBusy = true
        picker.dismiss(animated: true) { [weak self] in
            self?.showProgress { self?.read(provider) }
        }
    }

    private func read(_ provider: NSItemProvider) {
        provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { [weak self] data, _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                guard let data = data, let image = UIImage(data: data) else {
                    self.end(.failed(title: loc("shot_failed_title", "Upload Failed"),
                                     message: loc("shot_unreadable", "StudyTrace could not read the selected screenshot.")))
                    return
                }
                let capturedAt = UsageScreenshotOCR.captureDate(from: data)
                UsageScreenshotOCR.recognizeLines(in: image) { text in
                    self.submit(image: image, text: text, capturedAt: capturedAt)
                }
            }
        }
    }

    private func submit(image: UIImage, text: String, capturedAt: Date?) {
        var submission = UsageScreenshotSubmission(kind: kind)
        submission.capturedAt = capturedAt
        submission.ocrText = text
        if kind == .screenTimeActivity {
            // Participants are asked for yesterday; the screenshot may say otherwise.
            let offset = UsageScreenshotParser.dayOffsetHint(in: text) ?? -1
            let base = capturedAt ?? Date()
            submission.activityDate = Calendar.current.date(byAdding: .day, value: offset, to: base) ?? base
        }
        if UsageScreenshotParser.isLikelyScreenshot(of: kind, text: text) {
            upload(image: image, submission: submission)
        } else {
            confirmUnexpectedScreenshot(image: image, submission: submission)
        }
    }

    /// The picked image does not look like the requested Settings screen.
    /// Offers another pick; no values are shown.
    private func confirmUnexpectedScreenshot(image: UIImage, submission: UsageScreenshotSubmission) {
        hideProgress { [weak self] in
            guard let self = self, let presenter = self.presenter else {
                self?.isBusy = false
                return
            }
            let alert = UIAlertController(
                title: loc("shot_unexpected_title", "Is this the right screenshot?"),
                message: self.kind == .battery
                    ? loc("shot_unexpected_battery", "This does not look like the Battery usage screen. Choose another screenshot, or upload this one anyway.")
                    : loc("shot_unexpected_activity", "This does not look like the Screen Time activity screen. Choose another screenshot, or upload this one anyway."),
                preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: loc("shot_choose_again", "Choose another screenshot"), style: .default) { _ in
                self.presentPicker()
            })
            alert.addAction(UIAlertAction(title: loc("shot_upload_anyway", "Upload anyway"), style: .default) { _ in
                self.showProgress { self.upload(image: image, submission: submission) }
            })
            alert.addAction(UIAlertAction(title: loc("shot_cancel", "Cancel"), style: .cancel) { _ in
                self.isBusy = false
            })
            presenter.present(alert, animated: true)
        }
    }

    private func upload(image: UIImage, submission: UsageScreenshotSubmission) {
        UsageScreenshotUploader.upload(image, submission: submission) { [weak self] outcome in
            self?.end(outcome)
        }
    }

    private func end(_ outcome: UsageScreenshotUploader.Outcome) {
        hideProgress { [weak self] in
            guard let self = self else { return }
            self.isBusy = false
            self.completion?(self.kind, outcome)
        }
    }

    // MARK: Progress

    private func showProgress(then next: @escaping () -> Void) {
        guard let presenter = presenter, progress == nil else {
            next()
            return
        }
        let controller = UIViewController()
        controller.modalPresentationStyle = .overFullScreen
        controller.modalTransitionStyle = .crossDissolve
        controller.view.backgroundColor = UIColor.black.withAlphaComponent(0.35)
        let card = UIStackView()
        card.axis = .vertical
        card.alignment = .center
        card.spacing = 12
        card.isLayoutMarginsRelativeArrangement = true
        card.layoutMargins = UIEdgeInsets(top: 22, left: 24, bottom: 22, right: 24)
        card.backgroundColor = AWARETheme.canvas
        card.layer.cornerRadius = 16
        card.translatesAutoresizingMaskIntoConstraints = false
        let spinner = UIActivityIndicatorView(style: .large)
        spinner.startAnimating()
        let label = Self.label(loc("shot_uploading", "Uploading your screenshot…"), style: .body, color: AWARETheme.ink)
        label.textAlignment = .center
        card.addArrangedSubview(spinner)
        card.addArrangedSubview(label)
        controller.view.addSubview(card)
        NSLayoutConstraint.activate([
            card.centerXAnchor.constraint(equalTo: controller.view.centerXAnchor),
            card.centerYAnchor.constraint(equalTo: controller.view.centerYAnchor),
            card.widthAnchor.constraint(lessThanOrEqualTo: controller.view.widthAnchor, constant: -64)
        ])
        controller.view.accessibilityViewIsModal = true
        progress = controller
        presenter.present(controller, animated: true) {
            UIAccessibility.post(notification: .screenChanged, argument: label)
            next()
        }
    }

    private func hideProgress(then next: @escaping () -> Void) {
        guard let controller = progress else {
            next()
            return
        }
        progress = nil
        controller.dismiss(animated: true, completion: next)
    }

    // MARK: Layout helpers

    static func label(_ text: String, style: UIFont.TextStyle, color: UIColor) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = UIFont.preferredFont(forTextStyle: style)
        label.textColor = color
        label.numberOfLines = 0
        label.adjustsFontForContentSizeCategory = true
        return label
    }

    static func primaryButton(_ title: String, symbol: String?) -> UIButton {
        let button = UIButton(type: .system)
        button.setTitle(title, for: .normal)
        if let symbol = symbol {
            button.setImage(UIImage(systemName: symbol), for: .normal)
        }
        button.tintColor = .white
        button.backgroundColor = AWARETheme.accent
        button.setTitleColor(.white, for: .normal)
        button.titleLabel?.font = UIFont.preferredFont(forTextStyle: .headline)
        button.titleLabel?.adjustsFontForContentSizeCategory = true
        button.layer.cornerRadius = 14
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: 54).isActive = true
        return button
    }

    /// Puts `views` in a vertical stack inside a scroll view that stays
    /// above the keyboard.
    @discardableResult
    static func scrollingController(_ controller: UIViewController, views: [UIView]) -> UIViewController {
        let scrollView = UIScrollView()
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.keyboardDismissMode = .interactive
        let stack = UIStackView(arrangedSubviews: views)
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.isLayoutMarginsRelativeArrangement = true
        stack.layoutMargins = UIEdgeInsets(top: 20, left: 20, bottom: 28, right: 20)
        controller.view.addSubview(scrollView)
        scrollView.addSubview(stack)
        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: controller.view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: controller.view.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: controller.view.safeAreaLayoutGuide.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: controller.view.keyboardLayoutGuide.topAnchor),
            stack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor),
            stack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            stack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            stack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor)
        ])
        return controller
    }
}
