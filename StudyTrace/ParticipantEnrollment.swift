import Foundation
import Security
import UIKit
import AWAREFramework

/// The personal invitation is the participant's passwordless sign-in credential.
/// A device ID by itself, or the local onboarding choice, never grants access.
struct StudyInvitation {
    let studyURL: String
    let endpoint: URL
    let studyId: String
    let token: String

    init?(_ text: String) {
        guard var url = URLComponents(string: text), url.scheme == "https", url.host != nil,
              url.user == nil, url.password == nil, url.fragment == nil else { return nil }
        let parts = url.path.split(separator: "/").map(String.init)
        guard parts.count >= 5 else { return nil }
        // The suffix is /index.php/webservice/index/{study}/{personal token}.
        guard let index = parts.lastIndex(of: "index.php"), parts.count == index + 5,
              parts[index + 1] == "webservice", parts[index + 2] == "index" else { return nil }
        studyId = parts[index + 3]
        token = parts[index + 4]
        guard token.range(of: "^pi_[a-f0-9]{64}$", options: .regularExpression) != nil else { return nil }
        url.query = nil
        guard let canonical = url.url else { return nil }
        studyURL = canonical.absoluteString
        url.path = "/" + (Array(parts.prefix(index)) + ["api", "v1", "studies", studyId, "enrollment"]).joined(separator: "/")
        guard let endpoint = url.url else { return nil }
        self.endpoint = endpoint
    }
}

struct ParticipantAuthorization: Codable {
    let studyURL: String
    let deviceId: String
    let participant: String
    let consentVersion: String
    let expiresAt: Date

    func permits(studyURL: String, deviceId: String, now: Date = Date()) -> Bool {
        self.studyURL == studyURL && self.deviceId == deviceId && expiresAt > now
    }

    static func parse(_ data: Data, invitation: StudyInvitation, deviceId: String) -> ParticipantAuthorization? {
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let json = object as? [String: Any],
              let participant = json["participant"] as? String, !participant.isEmpty,
              let version = json["consent_version"] as? String, !version.isEmpty,
              let expires = json["expires_at"] as? String else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = formatter.date(from: expires)
        if date == nil {
            formatter.formatOptions = [.withInternetDateTime]
            date = formatter.date(from: expires)
        }
        guard let deadline = date, deadline > Date(), deadline.timeIntervalSinceNow <= 28 * 86400 + 60 else { return nil }
        return ParticipantAuthorization(studyURL: invitation.studyURL, deviceId: deviceId,
                                       participant: participant, consentVersion: version, expiresAt: deadline)
    }
}

enum ParticipantEnrollment {
    static var session: URLSession = .shared
    private static let service = "com.studytrace.participant-authorization"
    private static var timer: Timer?
    private static var expiryTimer: Timer?
    private static var signingIn = false
    private static var checking = false
    private static var lastCheck = Date.distantPast

    private static var keychainQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: "current-study"]
    }

    static func authorization() -> ParticipantAuthorization? {
        var query = keychainQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(ParticipantAuthorization.self, from: data)
    }

    static var isAuthorized: Bool {
        guard let url = AWAREStudy.shared().getURL(), let invitation = StudyInvitation(url),
              let record = authorization() else { return false }
        return record.permits(studyURL: invitation.studyURL, deviceId: AWAREStudy.shared().getDeviceId())
    }

    @discardableResult static func storeAuthorization(_ record: ParticipantAuthorization) -> Bool {
        guard let data = try? JSONEncoder().encode(record) else { return false }
        SecItemDelete(keychainQuery as CFDictionary)
        var query = keychainQuery
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    static func clear() {
        SecItemDelete(keychainQuery as CFDictionary)
        timer?.invalidate()
        timer = nil
        expiryTimer?.invalidate()
        expiryTimer = nil
    }

    static func signIn(_ url: String, completion: @escaping (String?) -> Void) {
        guard !signingIn else { completion("Sign-in is already in progress."); return }
        guard let invitation = StudyInvitation(url) else {
            completion("Use the personal invitation from your research team after completing study consent. Shared study links cannot sign in.")
            return
        }
        signingIn = true
        let deviceId = AWAREStudy.shared().getDeviceId()
        var request = URLRequest(url: invitation.endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(invitation.token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["device_id": deviceId])
        session.dataTask(with: request) { data, response, _ in
            DispatchQueue.main.async {
                let status = (response as? HTTPURLResponse)?.statusCode
                guard status == 200, let data = data,
                      let record = ParticipantAuthorization.parse(data, invitation: invitation, deviceId: deviceId) else {
                    if authorization()?.studyURL == invitation.studyURL,
                       status == 401 || status == 403 || status == 200 { invalidate() }
                    signingIn = false
                    completion("We could not verify this invitation. Check your connection or contact the research team for a current personal invitation.")
                    return
                }
                let alreadySignedIn = isAuthorized && authorization()?.studyURL == record.studyURL
                if !alreadySignedIn {
                    // Clear the previous study's queued/local data before switching accounts.
                    StudyParticipationController.revokeParticipation(clearStudySettings: true)
                }
                AWAREStudy.shared().join(withURL: invitation.studyURL) { settings, status, error in
                    DispatchQueue.main.async {
                        signingIn = false
                        let successful = status == AwareStudyStateNew || status == AwareStudyStateUpdate || status == AwareStudyStateNoChange
                        guard successful, error == nil else {
                            invalidate()
                            completion("Study sign-in could not finish. Please retry your invitation while connected.")
                            return
                        }
                        guard storeAuthorization(record) else {
                            invalidate()
                            completion("Could not save study sign-in securely on this device. Please contact the research team.")
                            return
                        }
                        if !alreadySignedIn { StudyParticipationController.recordConsentGranted() }
                        startMonitoring()
                        completion(nil)
                    }
                }
            }
        }.resume()
    }

    static func startMonitoring() {
        timer?.invalidate()
        expiryTimer?.invalidate()
        guard let record = authorization() else { return }
        // While background location keeps the process running this timer stops
        // sensors at the deadline. A suspended/relaunched app also checks on start.
        let interval = max(0.1, min(60, record.expiresAt.timeIntervalSinceNow))
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { _ in
            if !isAuthorized { invalidate() }
            else { refreshStatus() }
        }
        expiryTimer = Timer(fire: record.expiresAt, interval: 0, repeats: false) { _ in invalidate() }
        RunLoop.main.add(expiryTimer!, forMode: .common)
        refreshStatus(force: true)
    }

    static func refreshStatus(force: Bool = false) {
        guard !checking, let record = authorization(), let invitation = StudyInvitation(record.studyURL) else { return }
        guard isAuthorized else { invalidate(); return }
        guard force || Date().timeIntervalSince(lastCheck) >= 15 * 60 else { return }
        checking = true
        lastCheck = Date()
        var request = URLRequest(url: invitation.endpoint)
        request.timeoutInterval = 20
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("Bearer \(invitation.token)", forHTTPHeaderField: "Authorization")
        request.setValue(record.deviceId, forHTTPHeaderField: "x-device-id")
        session.dataTask(with: request) { _, response, _ in
            DispatchQueue.main.async {
                checking = false
                // Ignore a response for a study that was switched/withdrawn meanwhile.
                guard authorization()?.studyURL == record.studyURL else { return }
                let status = (response as? HTTPURLResponse)?.statusCode
                if status == 401 || status == 403 { invalidate() }
                // Offline access uses the existing verified deadline; it never extends it.
            }
        }.resume()
    }

    static func invalidate() {
        StudyParticipationController.revokeParticipation(clearStudySettings: false)
    }
}
