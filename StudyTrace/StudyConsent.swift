//
//  StudyConsent.swift
//  StudyTrace
//
//  Per-study informed consent. Each research team publishes its
//  ethics-approved consent on the study server; the app shows it when the
//  participant joins (from a QR code, a link, or a typed study URL) and joins
//  only if they agree. Collection is tied to the consent for the study the
//  phone is enrolled in, and a revised consent is shown again to enrolled
//  participants.
//

import UIKit
import AWAREFramework

private func loc(_ key: String, _ english: String) -> String {
    return NSLocalizedString(key, tableName: nil, bundle: .main, value: english, comment: "")
}

extension Notification.Name {
    /// Posted after this iPhone joins or leaves a study, so screens can refresh.
    static let studyTraceParticipationChanged = Notification.Name("StudyTraceParticipationChanged")
}

// MARK: - Model

struct StudyConsent: Decodable {
    struct Section: Decodable {
        let key: String
        let heading: String
        let body: String
    }

    struct Contact: Decodable {
        let name: String
        let email: String
        let phone: String?
    }

    struct Ethics: Decodable {
        let board: String
        let `protocol`: String
    }

    let studyId: String
    let studyName: String?
    let version: Int
    let title: String
    let sections: [Section]
    let contact: Contact
    let ethics: Ethics

    /// Section heading in the app's language; the server's English heading
    /// is the fallback for sections this build does not know.
    static func localizedHeading(for section: Section) -> String {
        switch section.key {
        case "purpose": return loc("consent_purpose", "Purpose of the research")
        case "duration": return loc("consent_duration", "How long participation lasts")
        case "procedures": return loc("consent_procedures", "What you will do and what the app collects")
        case "risks": return loc("consent_risks", "Risks and discomforts")
        case "benefits": return loc("consent_benefits", "Benefits")
        case "data_handling": return loc("consent_data_handling", "Confidentiality, storage, and who can access your data")
        case "withdrawal": return loc("consent_withdrawal", "How to withdraw")
        case "additional": return loc("consent_additional", "Other information")
        default: return section.heading
        }
    }
}

// MARK: - What this iPhone agreed to

enum StudyConsentStore {
    private static let acceptedKey = "com.studytrace.study-consents"

    /// "host/study_id": one study URL can carry different participant labels
    /// (?participant=) but it is the same study and the same consent.
    static func studyKey(for studyURL: String) -> String? {
        guard let components = URLComponents(string: studyURL),
              let host = components.host?.lowercased(), !host.isEmpty else {
            return nil
        }
        let parts = components.path.split(separator: "/").map(String.init)
        guard let index = parts.lastIndex(of: "index"), parts.count > index + 2 else { return nil }
        let port = components.port.map { ":\($0)" } ?? ""
        return "\(host)\(port)/\(parts[index + 1])"
    }

    static func acceptedVersion(studyURL: String) -> Int? {
        guard let key = studyKey(for: studyURL),
              let accepted = UserDefaults.standard.dictionary(forKey: acceptedKey) as? [String: Int] else {
            return nil
        }
        return accepted[key]
    }

    static func recordAcceptance(studyURL: String, version: Int) {
        guard let key = studyKey(for: studyURL) else { return }
        var accepted = UserDefaults.standard.dictionary(forKey: acceptedKey) as? [String: Int] ?? [:]
        accepted[key] = version
        UserDefaults.standard.set(accepted, forKey: acceptedKey)
    }

    static func clear(studyURL: String) {
        guard let key = studyKey(for: studyURL) else { return }
        var accepted = UserDefaults.standard.dictionary(forKey: acceptedKey) as? [String: Int] ?? [:]
        accepted.removeValue(forKey: key)
        UserDefaults.standard.set(accepted, forKey: acceptedKey)
    }
}

// MARK: - Study server

enum StudyConsentAPI {
    enum FetchError: Error {
        /// The research team has not published a consent for this study.
        case notPublished
        /// Wrong study link (the server rejected the study ID or password).
        case rejected
        /// Network or server problem; worth trying again.
        case unavailable
    }

    private static let pendingKey = "com.studytrace.pending-consent-records"

    /// `{study URL}/consent`, keeping any ?participant= query.
    static func consentURL(for studyURL: String) -> URL? {
        guard var components = URLComponents(string: studyURL),
              components.scheme?.lowercased() == "https" else {
            return nil
        }
        components.path = components.path.hasSuffix("/") ? components.path + "consent" : components.path + "/consent"
        return components.url
    }

    static func fetch(studyURL: String, completion: @escaping (Result<StudyConsent, FetchError>) -> Void) {
        guard let url = consentURL(for: studyURL) else {
            completion(.failure(.rejected))
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        request.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: request) { data, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let result: Result<StudyConsent, FetchError>
            if error == nil, status == 200, let data = data,
               let consent = decode(data) {
                result = .success(consent)
            } else if status == 404 {
                result = .failure(.notPublished)
            } else if status == 401 || status == 403 {
                result = .failure(.rejected)
            } else {
                result = .failure(.unavailable)
            }
            DispatchQueue.main.async { completion(result) }
        }.resume()
    }

    static func decode(_ data: Data) -> StudyConsent? {
        struct Envelope: Decodable { let consent: StudyConsent }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        do {
            return try decoder.decode(Envelope.self, from: data).consent
        } catch {
            return nil
        }
    }

    /// Tells the study server this device agreed to `version`, for the
    /// research team's consent records. Kept and retried if offline.
    static func recordAgreement(studyURL: String, version: Int, deviceId: String) {
        let record: [String: Any] = [
            "study_url": studyURL,
            "device_id": deviceId,
            "version": version,
            "accepted_at": Date().timeIntervalSince1970 * 1000
        ]
        var pending = UserDefaults.standard.array(forKey: pendingKey) as? [[String: Any]] ?? []
        pending.append(record)
        UserDefaults.standard.set(pending, forKey: pendingKey)
        send(record)
    }

    /// Re-sends agreements that could not reach the server earlier. The
    /// server stores one row per device and version, so repeats are harmless.
    static func retryPendingAgreements() {
        let pending = UserDefaults.standard.array(forKey: pendingKey) as? [[String: Any]] ?? []
        pending.forEach(send)
    }

    private static func send(_ record: [String: Any]) {
        guard let studyURL = record["study_url"] as? String,
              let url = consentURL(for: studyURL),
              let body = try? JSONSerialization.data(withJSONObject: [
                  "device_id": record["device_id"] ?? "",
                  "version": record["version"] ?? 0,
                  "accepted_at": record["accepted_at"] ?? 0
              ], options: []) else {
            remove(record)
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        URLSession.shared.dataTask(with: request) { _, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            // 2xx: recorded. 4xx: will never succeed (e.g. consent revised
            // since; the participant is asked again). Keep only on 5xx/offline.
            if error == nil, (200..<500).contains(status) {
                DispatchQueue.main.async { remove(record) }
            }
        }.resume()
    }

    private static func remove(_ record: [String: Any]) {
        let pending = UserDefaults.standard.array(forKey: pendingKey) as? [[String: Any]] ?? []
        let remaining = pending.filter { item in
            !((item["study_url"] as? String) == (record["study_url"] as? String)
                && (item["version"] as? Int) == (record["version"] as? Int)
                && (item["device_id"] as? String) == (record["device_id"] as? String))
        }
        UserDefaults.standard.set(remaining, forKey: pendingKey)
    }
}

// MARK: - Joining a study

/// The one way to join a study. Shows the study's consent and joins only if
/// the participant agrees; then asks for the permissions collection needs.
final class StudyJoinCoordinator {
    static let shared = StudyJoinCoordinator()

    private(set) var isBusy = false
    private var progress: ProgressOverlayViewController?

    func join(studyURL: String, from presenter: UIViewController, completion: ((Bool) -> Void)? = nil) {
        guard !isBusy else { return }
        let current = AWAREStudy.shared().getURL() ?? ""
        let enrolled = StudyParticipationController.hasConsent() && !current.isEmpty
        if enrolled, StudyConsentStore.studyKey(for: current) == StudyConsentStore.studyKey(for: studyURL) {
            alert(on: presenter,
                  title: loc("join_already_title", "Already Joined"),
                  message: loc("join_already_message", "This iPhone is already taking part in this study."))
            completion?(false)
            return
        }
        guard enrolled else {
            begin(studyURL: studyURL, replacing: nil, from: presenter, completion: completion)
            return
        }
        // Switching studies ends the current one, so ask first.
        let confirm = UIAlertController(
            title: loc("join_switch_title", "Switch Studies?"),
            message: loc("join_switch_message", "This iPhone is taking part in another study. Joining this one ends your participation in the current study. Data already uploaded is kept; to have it deleted, leave the current study from Settings first."),
            preferredStyle: .alert)
        confirm.addAction(UIAlertAction(title: loc("Cancel", "Cancel"), style: .cancel) { _ in completion?(false) })
        confirm.addAction(UIAlertAction(title: loc("join_switch_continue", "Continue"), style: .default) { [weak self] _ in
            self?.begin(studyURL: studyURL, replacing: current, from: presenter, completion: completion)
        })
        presenter.present(confirm, animated: true)
    }

    private func begin(studyURL: String, replacing previous: String?, from presenter: UIViewController,
                       completion: ((Bool) -> Void)?) {
        isBusy = true
        showProgress(on: presenter, text: loc("join_loading", "Opening the study…")) { [weak self] in
            StudyConsentAPI.fetch(studyURL: studyURL) { result in
                self?.hideProgress {
                    guard let self = self else { return }
                    switch result {
                    case .success(let consent):
                        self.presentConsent(consent, studyURL: studyURL, replacing: previous,
                                            from: presenter, completion: completion)
                    case .failure(let error):
                        self.isBusy = false
                        self.showFetchError(error, on: presenter)
                        completion?(false)
                    }
                }
            }
        }
    }

    private func presentConsent(_ consent: StudyConsent, studyURL: String, replacing previous: String?,
                                from presenter: UIViewController, completion: ((Bool) -> Void)?) {
        let host = URLComponents(string: studyURL)?.host ?? ""
        let consentVC = StudyConsentViewController(consent: consent, serverHost: host, isUpdate: false)
        consentVC.onDecision = { [weak self, weak consentVC] agreed in
            consentVC?.dismiss(animated: true) {
                guard let self = self else { return }
                guard agreed else {
                    self.isBusy = false
                    StudyTraceTelemetry.recordEvent("consent_declined", metadata: ["version": consent.version])
                    completion?(false)
                    return
                }
                if previous != nil {
                    // Ends the old study (logged on its server, data kept).
                    StudyParticipationController.revokeParticipation(clearStudySettings: true, notifyServer: true,
                                                                     deleteUploadedData: false)
                }
                self.joinAfterConsent(consent, studyURL: studyURL, from: presenter, completion: completion)
            }
        }
        presenter.present(consentVC.inNavigationController(), animated: true)
    }

    private func joinAfterConsent(_ consent: StudyConsent, studyURL: String, from presenter: UIViewController,
                                  completion: ((Bool) -> Void)?) {
        showProgress(on: presenter, text: loc("join_joining", "Joining the study…")) { [weak self] in
            let study = AWAREStudy.shared()
            study.setStudyURL(studyURL)
            study.join(withURL: studyURL) { _, status, error in
                DispatchQueue.main.async {
                    self?.hideProgress {
                        guard let self = self else { return }
                        self.isBusy = false
                        guard status == AwareStudyStateNew || status == AwareStudyStateUpdate
                            || status == AwareStudyStateNoChange else {
                            StudyTraceTelemetry.recordEvent("study_join_failed", metadata: [
                                "status": "\(status)",
                                "error": error?.localizedDescription ?? ""
                            ])
                            self.alert(on: presenter,
                                       title: loc("join_failed_title", "Could Not Join"),
                                       message: loc("join_failed_message", "StudyTrace could not reach the study server. Check your internet connection and try the study link again."))
                            completion?(false)
                            return
                        }
                        StudyConsentStore.recordAcceptance(studyURL: studyURL, version: consent.version)
                        StudyConsentAPI.recordAgreement(studyURL: studyURL, version: consent.version,
                                                        deviceId: study.getDeviceId())
                        StudyTraceTelemetry.recordEvent("consent_granted", metadata: ["version": consent.version])
                        StudyTraceTelemetry.recordEvent("study_joined", metadata: ["status": "\(status)"])
                        StudyParticipationController.startCollectingAfterJoin(presenter: presenter)
                        NotificationCenter.default.post(name: .studyTraceParticipationChanged, object: nil)
                        completion?(true)
                    }
                }
            }
        }
    }

    // MARK: Ways to join

    /// Offers the two ways to join: scan the study QR code or paste its link.
    func presentJoinOptions(from presenter: UIViewController, sourceView: UIView?) {
        let sheet = UIAlertController(title: loc("join_link_title", "Join a Study"),
                                      message: loc("join_options_message", "Use the QR code or link your research team gave you."),
                                      preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: loc("join_scan", "Scan QR Code"), style: .default) { _ in
            let storyboard = presenter.storyboard ?? UIStoryboard(name: "Main", bundle: nil)
            presenter.present(storyboard.instantiateViewController(withIdentifier: "QRCodeReader"), animated: true)
        })
        sheet.addAction(UIAlertAction(title: loc("join_enter_link", "Enter Study Link"), style: .default) { [weak self] _ in
            self?.presentLinkEntry(from: presenter)
        })
        sheet.addAction(UIAlertAction(title: loc("Cancel", "Cancel"), style: .cancel))
        sheet.popoverPresentationController?.sourceView = sourceView ?? presenter.view
        presenter.present(sheet, animated: true)
    }

    func presentLinkEntry(from presenter: UIViewController, completion: ((Bool) -> Void)? = nil) {
        let alert = UIAlertController(title: loc("join_link_title", "Join a Study"),
                                      message: loc("join_link_message", "Paste the study link from your research team."),
                                      preferredStyle: .alert)
        alert.addTextField { field in
            field.placeholder = "https://"
            field.clearButtonMode = .whileEditing
            field.keyboardType = .URL
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
        }
        alert.addAction(UIAlertAction(title: loc("Cancel", "Cancel"), style: .cancel) { _ in completion?(false) })
        alert.addAction(UIAlertAction(title: loc("join_link_join", "Join"), style: .default) { [weak self, weak alert] _ in
            let text = alert?.textFields?.first?.text ?? ""
            guard let secureURL = presenter.normalizedSecureStudyURL(
                QRCodeReaderViewController.normalizedURLCandidate(text)) else {
                presenter.showInsecureURLAlert()
                completion?(false)
                return
            }
            self?.join(studyURL: secureURL, from: presenter, completion: completion)
        })
        presenter.present(alert, animated: true)
    }

    // MARK: Revised consent

    private var lastUpdateCheck = Date.distantPast

    /// Shows the study's consent again if the research team revised it since
    /// this participant agreed. Agreeing continues the study; declining
    /// offers to leave it. Offline or unpublished consent changes nothing.
    func checkForRevisedConsent(from presenter: UIViewController) {
        guard !isBusy, Date().timeIntervalSince(lastUpdateCheck) > 15 * 60,
              StudyParticipationController.hasConsent(),
              let studyURL = AWAREStudy.shared().getURL(), !studyURL.isEmpty else {
            return
        }
        lastUpdateCheck = Date()
        StudyConsentAPI.fetch(studyURL: studyURL) { [weak self] result in
            guard let self = self, !self.isBusy, !(presenter is UIAlertController),
                  case .success(let consent) = result,
                  consent.version > (StudyConsentStore.acceptedVersion(studyURL: studyURL) ?? 0),
                  presenter.presentedViewController == nil else {
                return
            }
            self.isBusy = true
            let host = URLComponents(string: studyURL)?.host ?? ""
            let consentVC = StudyConsentViewController(consent: consent, serverHost: host, isUpdate: true)
            consentVC.onDecision = { [weak self, weak consentVC] agreed in
                consentVC?.dismiss(animated: true) {
                    self?.isBusy = false
                    if agreed {
                        StudyConsentStore.recordAcceptance(studyURL: studyURL, version: consent.version)
                        StudyConsentAPI.recordAgreement(studyURL: studyURL, version: consent.version,
                                                        deviceId: AWAREStudy.shared().getDeviceId())
                        StudyTraceTelemetry.recordEvent("consent_granted", metadata: ["version": consent.version])
                    } else {
                        StudyParticipationController.presentLeaveStudy(from: presenter)
                    }
                }
            }
            presenter.present(consentVC.inNavigationController(), animated: true)
        }
    }

    // MARK: Helpers

    private func showFetchError(_ error: StudyConsentAPI.FetchError, on presenter: UIViewController) {
        switch error {
        case .notPublished:
            alert(on: presenter,
                  title: loc("join_not_ready_title", "Study Not Ready"),
                  message: loc("join_not_ready_message", "The research team has not published the consent form for this study yet. Please contact them, then try the study link again."))
        case .rejected:
            alert(on: presenter,
                  title: loc("join_rejected_title", "Study Link Not Recognized"),
                  message: loc("join_rejected_message", "This link did not match a study on the server. Make sure you are using the link or QR code your research team gave you."))
        case .unavailable:
            alert(on: presenter,
                  title: loc("join_failed_title", "Could Not Join"),
                  message: loc("join_failed_message", "StudyTrace could not reach the study server. Check your internet connection and try the study link again."))
        }
    }

    private func alert(on presenter: UIViewController, title: String, message: String) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: loc("OK", "OK"), style: .default))
        presenter.present(alert, animated: true)
    }

    private func showProgress(on presenter: UIViewController, text: String, then next: @escaping () -> Void) {
        let overlay = ProgressOverlayViewController(text: text)
        progress = overlay
        presenter.present(overlay, animated: true, completion: next)
    }

    private func hideProgress(then next: @escaping () -> Void) {
        guard let overlay = progress else {
            next()
            return
        }
        progress = nil
        overlay.dismiss(animated: true, completion: next)
    }
}

// MARK: - Consent screen

final class StudyConsentViewController: UIViewController {

    /// true = agreed, false = declined.
    var onDecision: ((Bool) -> Void)?

    private let consent: StudyConsent
    private let serverHost: String
    private let isUpdate: Bool

    init(consent: StudyConsent, serverHost: String, isUpdate: Bool) {
        self.consent = consent
        self.serverHost = serverHost
        self.isUpdate = isUpdate
        super.init(nibName: nil, bundle: nil)
        // Swiping the sheet away must not count as an answer.
        isModalInPresentation = true
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    func inNavigationController() -> UINavigationController {
        let nav = UINavigationController(rootViewController: self)
        nav.isModalInPresentation = true
        return nav
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = AWARETheme.canvas
        title = loc("consent_screen_title", "Consent to Participate")

        var views: [UIView] = []
        if isUpdate {
            views.append(label(loc("consent_updated_notice", "The research team has updated the consent for this study. Please read it and choose whether to continue."),
                               style: .subheadline, color: AWARETheme.warmAccent))
        }
        views.append(label(consent.title, style: .title2, color: AWARETheme.ink))
        let source = String(format: loc("consent_source", "Study server: %@"), serverHost)
        views.append(label(source, style: .footnote, color: AWARETheme.secondaryInk))

        for section in consent.sections {
            views.append(label(StudyConsent.localizedHeading(for: section), style: .headline, color: AWARETheme.ink))
            views.append(label(section.body, style: .body, color: AWARETheme.ink))
        }

        views.append(label(loc("consent_contact", "Questions about the study"), style: .headline, color: AWARETheme.ink))
        var contactLines = [consent.contact.name, consent.contact.email]
        if let phone = consent.contact.phone, !phone.isEmpty { contactLines.append(phone) }
        let contact = label(contactLines.joined(separator: "\n"), style: .body, color: AWARETheme.ink)
        views.append(contact)
        let emailButton = UIButton(type: .system)
        emailButton.setTitle(String(format: loc("consent_email_button", "Email %@"), consent.contact.email), for: .normal)
        emailButton.contentHorizontalAlignment = .leading
        emailButton.titleLabel?.font = UIFont.preferredFont(forTextStyle: .body)
        emailButton.titleLabel?.adjustsFontForContentSizeCategory = true
        emailButton.addAction(UIAction { [weak self] _ in self?.emailContact() }, for: .touchUpInside)
        views.append(emailButton)

        views.append(label(loc("consent_ethics", "Ethics approval"), style: .headline, color: AWARETheme.ink))
        views.append(label("\(consent.ethics.board)\n\(consent.ethics.protocol)", style: .body, color: AWARETheme.ink))

        views.append(label(isUpdate
                            ? loc("consent_agree_note_update", "Choosing \"I Agree\" continues your participation. If you do not agree, you can leave the study.")
                            : loc("consent_agree_note", "Choosing \"I Agree\" joins the study. iOS will then ask for the permissions the study needs, such as location and notifications. You can stop at any time from Settings."),
                           style: .footnote, color: AWARETheme.secondaryInk))

        let agree = UsageScreenshotCoordinator.primaryButton(loc("consent_agree", "I Agree"), symbol: "checkmark")
        agree.addAction(UIAction { [weak self] _ in self?.onDecision?(true) }, for: .touchUpInside)
        let decline = UIButton(type: .system)
        decline.setTitle(loc("consent_decline", "I Do Not Agree"), for: .normal)
        decline.titleLabel?.font = UIFont.preferredFont(forTextStyle: .body)
        decline.setTitleColor(AWARETheme.destructive, for: .normal)
        decline.addAction(UIAction { [weak self] _ in self?.onDecision?(false) }, for: .touchUpInside)
        views += [agree, decline]

        UsageScreenshotCoordinator.scrollingController(self, views: views)
    }

    private func label(_ text: String, style: UIFont.TextStyle, color: UIColor) -> UILabel {
        return UsageScreenshotCoordinator.label(text, style: style, color: color)
    }

    private func emailContact() {
        var components = URLComponents()
        components.scheme = "mailto"
        components.path = consent.contact.email
        components.queryItems = [URLQueryItem(name: "subject", value: consent.title)]
        guard let url = components.url else { return }
        UIApplication.shared.open(url, options: [:]) { [weak self] opened in
            guard !opened, let self = self else { return }
            UIPasteboard.general.string = self.consent.contact.email
            let alert = UIAlertController(title: loc("consent_email_copied", "Email Address Copied"),
                                          message: self.consent.contact.email, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: loc("OK", "OK"), style: .default))
            self.present(alert, animated: true)
        }
    }
}

// MARK: - Progress overlay

/// A small "working…" card over the current screen.
final class ProgressOverlayViewController: UIViewController {
    private let text: String

    init(text: String) {
        self.text = text
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .crossDissolve
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor.black.withAlphaComponent(0.35)
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
        let label = UsageScreenshotCoordinator.label(text, style: .body, color: AWARETheme.ink)
        label.textAlignment = .center
        card.addArrangedSubview(spinner)
        card.addArrangedSubview(label)
        view.addSubview(card)
        NSLayoutConstraint.activate([
            card.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            card.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -64)
        ])
        view.accessibilityViewIsModal = true
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        UIAccessibility.post(notification: .screenChanged, argument: text)
    }
}

extension UIApplication {
    /// The view controller currently on screen, for presenting from places
    /// without one (app delegate callbacks).
    var studyTraceTopViewController: UIViewController? {
        var top = delegate?.window??.rootViewController
        while let presented = top?.presentedViewController {
            top = presented
        }
        return top
    }
}
