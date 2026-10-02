//
//  OnboardingManager.swift
//  StudyTrace
//
//  Created by Yuuki Nishiyama on 2019/11/13.
//  Copyright © 2019 Yuuki Nishiyama. All rights reserved.
//

import UIKit
import AWAREFramework

/// Deterministic, privacy-safe content used only by the App Store asset
/// capture tests. Normal launches never enter this mode.
enum AppStoreDemo {
    static var isEnabled: Bool {
        return ProcessInfo.processInfo.arguments.contains("-AppStoreDemo") || isOnboardingEnabled
    }

    static var isOnboardingEnabled: Bool {
        return ProcessInfo.processInfo.arguments.contains("-AppStoreDemoOnboarding")
    }

    static var onboardingPage: Int {
        return Int(value(after: "-AppStorePage") ?? "0") ?? 0
    }

    static var captureScene: String? {
        return value(after: "-AppStoreScene")
    }

    static var previewFlow: String? {
        return value(after: "-AppStorePreview")
    }

    private static func value(after flag: String) -> String? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
        return arguments[index + 1]
    }
}

class OnboardingManager: NSObject {

    private var onboardingNav: UINavigationController?

    private static let consentDecisionKey = "com.studytrace.onboarding.consent-decision-recorded"

    /// Onboarding is shown until the participant has actually agreed to or
    /// declined the consent page. (Marking it done before it was shown meant
    /// an app kill mid-flow skipped consent forever and nothing was collected.)
    public static func needsOnboarding() -> Bool {
        if AppStoreDemo.isOnboardingEnabled { return true }
        if AppStoreDemo.isEnabled { return false }
        if StudyParticipationController.hasConsent() { return false }
        return !UserDefaults.standard.bool(forKey: consentDecisionKey)
    }

    static func recordConsentDecision() {
        UserDefaults.standard.set(true, forKey: consentDecisionKey)
    }

    func startOnboarding(with viewController: UIViewController) {
        let pages = buildPages(presenter: viewController)
        let pageVC = OnboardingPageViewController(
            pages: pages,
            startIndex: AppStoreDemo.isOnboardingEnabled ? AppStoreDemo.onboardingPage : 0
        )
        pageVC.modalPresentationStyle = .fullScreen
        viewController.present(pageVC, animated: true)
    }

    private func buildPages(presenter: UIViewController) -> [OnboardingPage] {
        return [
            OnboardingPage(
                sfSymbol: "waveform.path.ecg",
                title: NSLocalizedString("onbording_overview_title", comment: ""),
                body: NSLocalizedString("onbording_overview_body", comment: ""),
                buttonTitle: NSLocalizedString("Next", comment: ""),
                action: nil
            ),
            OnboardingPage(
                sfSymbol: "person.fill.checkmark",
                title: NSLocalizedString("onbording_data_title", comment: ""),
                body: NSLocalizedString("onbording_data_body", comment: ""),
                buttonTitle: NSLocalizedString("Next", comment: ""),
                action: nil
            ),
            OnboardingPage(
                sfSymbol: "graduationcap.fill",
                title: NSLocalizedString("onbording_study_title", comment: ""),
                body: NSLocalizedString("onbording_study_body", comment: ""),
                buttonTitle: NSLocalizedString("Next", comment: ""),
                action: nil
            ),
            OnboardingPage(
                sfSymbol: "signature",
                title: NSLocalizedString("onboarding_consent_title", comment: ""),
                body: NSLocalizedString("onboarding_consent_body", comment: ""),
                buttonTitle: NSLocalizedString("onboarding_consent_agree", comment: ""),
                action: {
                    StudyParticipationController.recordConsentGranted()
                    OnboardingManager.recordConsentDecision()
                },
                isConsent: true,
                declineTitle: NSLocalizedString("onboarding_consent_decline", comment: "")
            ),
            OnboardingPage(
                sfSymbol: "location.fill",
                title: NSLocalizedString("onboarding_permission_loc_title", comment: ""),
                body: NSLocalizedString("onboarding_permission_loc_body", comment: ""),
                buttonTitle: NSLocalizedString("Allow", comment: ""),
                action: {
                    AWARECore.shared().requestPermissionForBackgroundSensing { _ in }
                }
            ),
            OnboardingPage(
                sfSymbol: "bell.fill",
                title: NSLocalizedString("onboarding_permission_notif_title", comment: ""),
                body: NSLocalizedString("onboarding_permission_notif_body", comment: ""),
                buttonTitle: NSLocalizedString("Allow", comment: ""),
                action: {
                    AWARECore.shared().requestPermissionForPushNotification { _, _ in }
                }
            ),
            OnboardingPage(
                sfSymbol: "checkmark.seal.fill",
                title: NSLocalizedString("onboarding_welcome_title", comment: ""),
                body: NSLocalizedString("onboarding_welcome_body", comment: ""),
                buttonTitle: "Get Started",
                action: nil,
                isFinal: true
            )
        ]
    }
}

struct OnboardingPage {
    let sfSymbol: String
    let title: String
    let body: String
    let buttonTitle: String
    let action: (() -> Void)?
    var isFinal: Bool = false
    var isConsent: Bool = false
    var declineTitle: String? = nil
}

class OnboardingPageViewController: UIViewController {
    private let pages: [OnboardingPage]
    private var currentIndex: Int
    private let pageControl = UIPageControl()

    private let iconView = UIImageView()
    private let titleLabel = UILabel()
    private let bodyLabel = UILabel()
    private let actionButton = UIButton(type: .system)
    private let declineButton = UIButton(type: .system)
    private let skipButton = UIButton(type: .system)

    init(pages: [OnboardingPage], startIndex: Int = 0) {
        self.pages = pages
        self.currentIndex = min(max(0, startIndex), max(0, pages.count - 1))
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = AWARETheme.canvas
        setupUI()
        displayPage(at: currentIndex, animated: false)
    }

    private func setupUI() {
        iconView.contentMode = .scaleAspectFit
        iconView.tintColor = AWARETheme.accent
        iconView.translatesAutoresizingMaskIntoConstraints = false

        titleLabel.font = UIFont.preferredFont(forTextStyle: .title1).withTraits(.traitBold)
        titleLabel.textColor = AWARETheme.ink
        titleLabel.textAlignment = .center
        titleLabel.numberOfLines = 0
        titleLabel.adjustsFontForContentSizeCategory = true
        titleLabel.translatesAutoresizingMaskIntoConstraints = false

        bodyLabel.font = UIFont.preferredFont(forTextStyle: .body)
        bodyLabel.textColor = AWARETheme.secondaryInk
        bodyLabel.textAlignment = .center
        bodyLabel.numberOfLines = 0
        bodyLabel.adjustsFontForContentSizeCategory = true
        bodyLabel.translatesAutoresizingMaskIntoConstraints = false

        actionButton.titleLabel?.font = UIFont.preferredFont(forTextStyle: .headline)
        actionButton.setTitleColor(.white, for: .normal)
        actionButton.backgroundColor = AWARETheme.accent
        actionButton.layer.cornerRadius = 16
        actionButton.translatesAutoresizingMaskIntoConstraints = false
        actionButton.addTarget(self, action: #selector(didTapAction), for: .touchUpInside)

        declineButton.titleLabel?.font = UIFont.preferredFont(forTextStyle: .subheadline)
        declineButton.setTitleColor(AWARETheme.destructive, for: .normal)
        declineButton.translatesAutoresizingMaskIntoConstraints = false
        declineButton.addTarget(self, action: #selector(didTapDecline), for: .touchUpInside)
        declineButton.isHidden = true

        skipButton.setTitle("Skip", for: .normal)
        skipButton.setTitleColor(AWARETheme.secondaryInk, for: .normal)
        skipButton.translatesAutoresizingMaskIntoConstraints = false
        skipButton.addTarget(self, action: #selector(didTapSkip), for: .touchUpInside)

        pageControl.numberOfPages = pages.count
        pageControl.currentPageIndicatorTintColor = AWARETheme.accent
        pageControl.pageIndicatorTintColor = AWARETheme.accent.withAlphaComponent(0.2)
        pageControl.translatesAutoresizingMaskIntoConstraints = false
        pageControl.isUserInteractionEnabled = false

        view.addSubview(iconView)
        view.addSubview(titleLabel)
        view.addSubview(bodyLabel)
        view.addSubview(actionButton)
        view.addSubview(declineButton)
        view.addSubview(skipButton)
        view.addSubview(pageControl)

        NSLayoutConstraint.activate([
            iconView.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            iconView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 80),
            iconView.widthAnchor.constraint(equalToConstant: 80),
            iconView.heightAnchor.constraint(equalToConstant: 80),

            titleLabel.topAnchor.constraint(equalTo: iconView.bottomAnchor, constant: 32),
            titleLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32),
            titleLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32),

            bodyLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 16),
            bodyLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32),
            bodyLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32),

            actionButton.bottomAnchor.constraint(equalTo: declineButton.topAnchor, constant: -12),
            actionButton.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 40),
            actionButton.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -40),
            actionButton.heightAnchor.constraint(equalToConstant: 54),

            declineButton.bottomAnchor.constraint(equalTo: pageControl.topAnchor, constant: -16),
            declineButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            declineButton.heightAnchor.constraint(equalToConstant: 36),

            pageControl.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
            pageControl.centerXAnchor.constraint(equalTo: view.centerXAnchor),

            skipButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
            skipButton.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20)
        ])
    }

    private func displayPage(at index: Int, animated: Bool) {
        let page = pages[index]
        pageControl.currentPage = index

        let config = UIImage.SymbolConfiguration(pointSize: 48, weight: .medium)
        iconView.image = UIImage(systemName: page.sfSymbol, withConfiguration: config)
        titleLabel.text = page.title
        bodyLabel.text = page.body
        actionButton.setTitle("  \(page.buttonTitle)  ", for: .normal)
        skipButton.isHidden = page.isFinal || page.isConsent

        if page.isConsent, let declineTitle = page.declineTitle {
            declineButton.setTitle(declineTitle, for: .normal)
            declineButton.isHidden = false
        } else {
            declineButton.isHidden = true
        }

        if animated {
            iconView.alpha = 0
            titleLabel.alpha = 0
            bodyLabel.alpha = 0
            UIView.animate(withDuration: 0.3) {
                self.iconView.alpha = 1
                self.titleLabel.alpha = 1
                self.bodyLabel.alpha = 1
            }
        }

        AWAREEventLogger.shared().logEvent(["class": "OnboardingManager", "event": "display", "page": index])
    }

    @objc private func didTapAction() {
        AWARETheme.lightImpact()
        let page = pages[currentIndex]
        page.action?()

        if page.isFinal {
            // Capture the presenter before dismissing: inside the completion
            // handler presentingViewController is already nil, and falling
            // back to self (no storyboard) crashed LocationPermissionManager.
            guard let presenter = presentingViewController else {
                dismiss(animated: true)
                return
            }
            dismiss(animated: true) {
                if StudyParticipationController.hasConsent() {
                    StudyParticipationController.refreshCollectionState(
                        fitbitPresenter: presenter,
                        createRemoteTables: !(AWAREStudy.shared().getURL() ?? "").isEmpty
                    )
                    _ = LocationPermissionManager().isAuthorizedAlways(with: presenter)
                }
            }
            return
        }

        currentIndex += 1
        if currentIndex < pages.count {
            displayPage(at: currentIndex, animated: true)
        }
    }

    func advanceForAppPreview() {
        didTapAction()
    }

    @objc private func didTapSkip() {
        AWAREEventLogger.shared().logEvent(["class": "OnboardingManager", "event": "skip", "page": currentIndex])
        currentIndex += 1
        if currentIndex < pages.count {
            displayPage(at: currentIndex, animated: true)
        } else {
            dismiss(animated: true)
        }
    }

    @objc private func didTapDecline() {
        let alert = UIAlertController(
            title: "Decline Participation?",
            message: "If you decline, the app will not collect any data. You can change your mind later in Settings.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Go Back", style: .cancel))
        alert.addAction(UIAlertAction(title: "Decline", style: .destructive) { _ in
            StudyParticipationController.revokeParticipation(clearStudySettings: false)
            AWAREEventLogger.shared().logEvent(["class": "OnboardingManager", "event": "consent_declined"])
            self.dismiss(animated: true)
        })
        present(alert, animated: true)
    }
}

extension UIFont {
    func withTraits(_ traits: UIFontDescriptor.SymbolicTraits) -> UIFont {
        guard let descriptor = fontDescriptor.withSymbolicTraits(traits) else { return self }
        return UIFont(descriptor: descriptor, size: 0)
    }
}

extension UIImage {
    func resized(toWidth width: CGFloat) -> UIImage? {
        let canvasSize = CGSize(width: width, height: CGFloat(ceil(width/size.width * size.height)))
        UIGraphicsBeginImageContextWithOptions(canvasSize, false, scale)
        defer { UIGraphicsEndImageContext() }
        draw(in: CGRect(origin: .zero, size: canvasSize))
        return UIGraphicsGetImageFromCurrentImageContext()
    }
}
