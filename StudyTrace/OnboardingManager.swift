//
//  OnboardingManager.swift
//  StudyTrace
//
//  Created by Yuuki Nishiyama on 2019/11/13.
//  Copyright © 2019 Yuuki Nishiyama. All rights reserved.
//

import UIKit
import AWAREFramework

class OnboardingManager: NSObject {

    private var onboardingNav: UINavigationController?

    public static func isFirstTime() -> Bool {
        let key = "com.liuchao.studytrace.onboarding.is-already-done"
        if !UserDefaults.standard.bool(forKey: key) {
            UserDefaults.standard.set(true, forKey: key)
            return true
        } else {
            return false
        }
    }

    func startOnboarding(with viewController: UIViewController) {
        let pages = buildPages(presenter: viewController)
        let pageVC = OnboardingPageViewController(pages: pages)
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
                    UserDefaults.standard.set(true, forKey: "com.studytrace.user-consented")
                    UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: "com.studytrace.consent-timestamp")
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
    private var currentIndex = 0
    private let pageControl = UIPageControl()

    private let iconView = UIImageView()
    private let titleLabel = UILabel()
    private let bodyLabel = UILabel()
    private let actionButton = UIButton(type: .system)
    private let declineButton = UIButton(type: .system)
    private let skipButton = UIButton(type: .system)

    init(pages: [OnboardingPage]) {
        self.pages = pages
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = AWARETheme.canvas
        setupUI()
        displayPage(at: 0, animated: false)
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
            dismiss(animated: true) {
                _ = LocationPermissionManager().isAuthorizedAlways(with: self.presentingViewController ?? self)
            }
            return
        }

        currentIndex += 1
        if currentIndex < pages.count {
            displayPage(at: currentIndex, animated: true)
        }
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
            UserDefaults.standard.set(false, forKey: "com.studytrace.user-consented")
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

