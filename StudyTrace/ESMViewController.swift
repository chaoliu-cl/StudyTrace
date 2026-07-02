//
//  ESMViewController.swift
//  StudyTrace
//
//  Created by Yuuki Nishiyama on 2019/02/27.
//  Copyright © 2019 Yuuki Nishiyama. All rights reserved.
//

import UIKit
import CoreData
import AWAREFramework
import PhotosUI
import Vision

class ESMViewController: UIViewController, PHPickerViewControllerDelegate {

    @IBOutlet weak var surveyButton: UIButton!

    private let emptyStateStack = UIStackView()
    private let batteryPromptButton = UIButton(type: .system)
    private let batteryInstructionStack = UIStackView()
    private let batteryUploadButton = UIButton(type: .system)
    private var activeBatterySchedule: EntityESMSchedule?
    private var isUploadingBatteryScreenshot = false

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Surveys"
        view.backgroundColor = AWARETheme.canvas
        surveyButton.backgroundColor = AWARETheme.accent
        surveyButton.setTitleColor(.white, for: .normal)
        surveyButton.setImage(UIImage(systemName: "doc.text.fill"), for: .normal)
        surveyButton.tintColor = .white
        surveyButton.titleLabel?.font = UIFont.preferredFont(forTextStyle: .headline)
        surveyButton.titleLabel?.adjustsFontForContentSizeCategory = true
        surveyButton.layer.cornerRadius = 16
        surveyButton.layer.shadowColor = AWARETheme.accent.cgColor
        surveyButton.layer.shadowOpacity = 0.3
        surveyButton.layer.shadowRadius = 12
        surveyButton.layer.shadowOffset = CGSize(width: 0, height: 6)
        surveyButton.imageEdgeInsets = UIEdgeInsets(top: 0, left: -8, bottom: 0, right: 8)
        navigationController?.navigationBar.prefersLargeTitles = true

        setupEmptyState()
        setupBatteryScreenshotPrompt()

        if OnboardingManager.isFirstTime() {
            OnboardingManager().startOnboarding(with: self)
        }
    }

    private func setupEmptyState() {
        emptyStateStack.axis = .vertical
        emptyStateStack.alignment = .center
        emptyStateStack.spacing = 12
        emptyStateStack.translatesAutoresizingMaskIntoConstraints = false

        let iconView = UIImageView(image: UIImage(systemName: "doc.text.fill"))
        iconView.tintColor = AWARETheme.secondaryInk
        iconView.contentMode = .scaleAspectFit
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.heightAnchor.constraint(equalToConstant: 48).isActive = true
        iconView.widthAnchor.constraint(equalToConstant: 48).isActive = true

        let label = UILabel()
        label.text = "No surveys scheduled"
        label.font = UIFont.preferredFont(forTextStyle: .subheadline)
        label.textColor = AWARETheme.secondaryInk
        label.textAlignment = .center

        emptyStateStack.addArrangedSubview(iconView)
        emptyStateStack.addArrangedSubview(label)
        view.addSubview(emptyStateStack)
        NSLayoutConstraint.activate([
            emptyStateStack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            emptyStateStack.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: 60)
        ])
    }

    private func setupBatteryScreenshotPrompt() {
        batteryPromptButton.translatesAutoresizingMaskIntoConstraints = false
        batteryPromptButton.backgroundColor = AWARETheme.warmAccent
        batteryPromptButton.setTitleColor(.white, for: .normal)
        batteryPromptButton.setImage(UIImage(systemName: "battery.100.bolt"), for: .normal)
        batteryPromptButton.tintColor = .white
        batteryPromptButton.titleLabel?.font = UIFont.preferredFont(forTextStyle: .headline)
        batteryPromptButton.titleLabel?.adjustsFontForContentSizeCategory = true
        batteryPromptButton.titleLabel?.numberOfLines = 2
        batteryPromptButton.layer.cornerRadius = 16
        batteryPromptButton.layer.shadowColor = AWARETheme.warmAccent.cgColor
        batteryPromptButton.layer.shadowOpacity = 0.25
        batteryPromptButton.layer.shadowRadius = 12
        batteryPromptButton.layer.shadowOffset = CGSize(width: 0, height: 6)
        batteryPromptButton.imageEdgeInsets = UIEdgeInsets(top: 0, left: -8, bottom: 0, right: 8)
        batteryPromptButton.addTarget(self, action: #selector(didPushBatteryPromptButton), for: .touchUpInside)

        batteryInstructionStack.axis = .vertical
        batteryInstructionStack.spacing = 12
        batteryInstructionStack.translatesAutoresizingMaskIntoConstraints = false
        batteryInstructionStack.isLayoutMarginsRelativeArrangement = true
        batteryInstructionStack.layoutMargins = UIEdgeInsets(top: 18, left: 18, bottom: 18, right: 18)
        batteryInstructionStack.backgroundColor = AWARETheme.card
        batteryInstructionStack.layer.cornerRadius = 18
        batteryInstructionStack.layer.borderWidth = 1
        batteryInstructionStack.layer.borderColor = UIColor.separator.cgColor

        let titleLabel = UILabel()
        titleLabel.text = "Battery usage screenshot survey"
        titleLabel.font = UIFont.preferredFont(forTextStyle: .headline)
        titleLabel.textColor = AWARETheme.ink
        titleLabel.adjustsFontForContentSizeCategory = true

        let instructionLabel = UILabel()
        instructionLabel.text = """
        1. Open iPhone Settings.
        2. Tap Battery, then View All Battery Usage.
        3. Take a screenshot showing Battery Usage by App.
        4. Return to StudyTrace and upload that screenshot below.
        """
        instructionLabel.font = UIFont.preferredFont(forTextStyle: .subheadline)
        instructionLabel.textColor = AWARETheme.secondaryInk
        instructionLabel.numberOfLines = 0
        instructionLabel.adjustsFontForContentSizeCategory = true

        batteryUploadButton.backgroundColor = AWARETheme.accent
        batteryUploadButton.setTitle(" Upload Battery screenshot", for: .normal)
        batteryUploadButton.setTitleColor(.white, for: .normal)
        batteryUploadButton.setImage(UIImage(systemName: "photo.badge.plus"), for: .normal)
        batteryUploadButton.tintColor = .white
        batteryUploadButton.titleLabel?.font = UIFont.preferredFont(forTextStyle: .headline)
        batteryUploadButton.layer.cornerRadius = 14
        batteryUploadButton.heightAnchor.constraint(equalToConstant: 54).isActive = true
        batteryUploadButton.addTarget(self, action: #selector(didPushBatteryUploadButton), for: .touchUpInside)

        batteryInstructionStack.addArrangedSubview(titleLabel)
        batteryInstructionStack.addArrangedSubview(instructionLabel)
        batteryInstructionStack.addArrangedSubview(batteryUploadButton)

        view.addSubview(batteryPromptButton)
        view.addSubview(batteryInstructionStack)
        NSLayoutConstraint.activate([
            batteryPromptButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            batteryPromptButton.topAnchor.constraint(equalTo: surveyButton.bottomAnchor, constant: 18),
            batteryPromptButton.widthAnchor.constraint(equalToConstant: 260),
            batteryPromptButton.heightAnchor.constraint(equalToConstant: 72),
            batteryInstructionStack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
            batteryInstructionStack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20),
            batteryInstructionStack.topAnchor.constraint(equalTo: batteryPromptButton.bottomAnchor, constant: 18)
        ])
        batteryPromptButton.isHidden = true
        batteryInstructionStack.isHidden = true
    }
    
    override func viewDidAppear(_ animated: Bool) {
        self.tabBarController?.tabBar.isHidden = false
        NotificationCenter.default.addObserver(self, selector: #selector(willEnterForegroundNotification(notification:)), name: UIApplication.willEnterForegroundNotification, object: nil)
        self.checkESMSchedules()
        self.hideContextViewIfNeeded()
        if StudyParticipationController.hasConsent() {
            _ = LocationPermissionManager().isAuthorizedAlways(with: self)
        }
    }
    
    override func viewDidDisappear(_ animated: Bool) {
        NotificationCenter.default.removeObserver(self, name: UIApplication.willEnterForegroundNotification, object: nil)
    }
    
    @objc func willEnterForegroundNotification(notification: NSNotification) {
        self.checkESMSchedules()
        if StudyParticipationController.hasConsent() {
            _ = LocationPermissionManager().isAuthorizedAlways(with: self)
        }
    }
    
    func checkESMSchedules(){
        self.tabBarController?.tabBar.isHidden = false
        let esmManager = ESMScheduleManager.shared()
        let schedules = esmManager.getValidSchedules() as? [EntityESMSchedule] ?? []
        let batterySchedules = schedules.filter { isBatteryScreenshotSchedule($0) }
        let regularSchedules = schedules.filter { !isBatteryScreenshotSchedule($0) }
        activeBatterySchedule = batterySchedules.first

        if(regularSchedules.count > 0){
            self.surveyButton.setTitle(" \(regularSchedules.count) survey\(regularSchedules.count == 1 ? "" : "s") available",
                                  for: .normal)
            self.surveyButton.setImage(UIImage(systemName: "doc.text.fill"), for: .normal)
            self.surveyButton.backgroundColor = AWARETheme.accent
            self.surveyButton.layer.borderColor = UIColor.clear.cgColor
            self.surveyButton.layer.borderWidth = 0
            self.surveyButton.isEnabled = true
            self.surveyButton.isHidden = false
        } else {
            self.surveyButton.isEnabled = false
            self.surveyButton.isHidden = true
        }

        if batterySchedules.count > 0 {
            batteryPromptButton.setTitle(" Battery screenshot upload available", for: .normal)
            batteryPromptButton.isEnabled = true
            batteryPromptButton.isHidden = false
        } else {
            batteryPromptButton.isEnabled = false
            batteryPromptButton.isHidden = true
            batteryInstructionStack.isHidden = true
        }

        let totalCount = regularSchedules.count + batterySchedules.count
        emptyStateStack.isHidden = totalCount > 0
        tabBarController?.tabBar.items?[2].badgeValue = totalCount > 0 ? "\(totalCount)" : nil
        tabBarController?.tabBar.items?[2].badgeColor = AWARETheme.warmAccent
        IOSESM.setESMAppearedState(true)
    }
    
    @IBAction func didPushSurveyButton(_ sender: UIButton) {
        let esmManager = ESMScheduleManager.shared()
        let schedules = (esmManager.getValidSchedules() as? [EntityESMSchedule] ?? []).filter { !isBatteryScreenshotSchedule($0) }
        if(schedules.count > 0){
            self.performSegue(withIdentifier: "toESMScrollView", sender: self)
            self.tabBarController?.tabBar.isHidden = true
        }
    }

    @objc private func didPushBatteryPromptButton() {
        presentBatteryScreenshotWizard()
        AWARETheme.mediumImpact()
    }

    @objc private func didPushBatteryUploadButton() {
        presentBatteryScreenshotPicker()
    }

    private func isBatteryScreenshotSchedule(_ schedule: EntityESMSchedule) -> Bool {
        if schedule.schedule_id?.lowercased().contains("battery") == true {
            return true
        }
        guard let esms = schedule.esms else { return false }
        for item in esms {
            let trigger = item.esm_trigger?.lowercased() ?? ""
            let title = item.esm_title?.lowercased() ?? ""
            let instructions = item.esm_instructions?.lowercased() ?? ""
            if trigger == "battery_usage_screenshot" ||
                title.contains("battery") ||
                instructions.contains("battery usage screenshot") {
                return true
            }
        }
        return false
    }

    private func presentBatteryScreenshotWizard() {
        batteryInstructionStack.isHidden = false

        let wizard = UIViewController()
        wizard.view.backgroundColor = AWARETheme.canvas
        wizard.title = "Upload Battery screenshot"

        let scrollView = UIScrollView()
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 18
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.isLayoutMarginsRelativeArrangement = true
        stack.layoutMargins = UIEdgeInsets(top: 24, left: 22, bottom: 28, right: 22)

        let hero = UIImageView(image: UIImage(systemName: "battery.100.bolt"))
        hero.tintColor = AWARETheme.warmAccent
        hero.contentMode = .scaleAspectFit
        hero.heightAnchor.constraint(equalToConstant: 58).isActive = true

        let titleLabel = UILabel()
        titleLabel.text = "Take one Battery Usage screenshot"
        titleLabel.font = UIFont.preferredFont(forTextStyle: .title2)
        titleLabel.textColor = AWARETheme.ink
        titleLabel.numberOfLines = 0
        titleLabel.adjustsFontForContentSizeCategory = true

        let detailLabel = UILabel()
        detailLabel.text = "StudyTrace needs the iOS Battery screen because Apple does not allow apps to export Screen Time directly. Please upload only the Settings > Battery screenshot for this study."
        detailLabel.font = UIFont.preferredFont(forTextStyle: .body)
        detailLabel.textColor = AWARETheme.secondaryInk
        detailLabel.numberOfLines = 0
        detailLabel.adjustsFontForContentSizeCategory = true

        let steps = [
            "1. Leave StudyTrace and open iPhone Settings.",
            "2. Tap Battery.",
            "3. Tap View All Battery Usage so app rows are visible.",
            "4. Take a screenshot.",
            "5. Return here and choose that screenshot."
        ]
        let stepsLabel = UILabel()
        stepsLabel.text = steps.joined(separator: "\n")
        stepsLabel.font = UIFont.preferredFont(forTextStyle: .body)
        stepsLabel.textColor = AWARETheme.ink
        stepsLabel.numberOfLines = 0
        stepsLabel.adjustsFontForContentSizeCategory = true

        let tipLabel = UILabel()
        tipLabel.text = "Tip: the best screenshot includes app names, percentages, and on-screen time values."
        tipLabel.font = UIFont.preferredFont(forTextStyle: .subheadline)
        tipLabel.textColor = AWARETheme.secondaryInk
        tipLabel.numberOfLines = 0
        tipLabel.adjustsFontForContentSizeCategory = true

        let chooseButton = UIButton(type: .system)
        chooseButton.setTitle("Choose Battery screenshot", for: .normal)
        chooseButton.setImage(UIImage(systemName: "photo.on.rectangle.angled"), for: .normal)
        chooseButton.tintColor = .white
        chooseButton.backgroundColor = AWARETheme.accent
        chooseButton.setTitleColor(.white, for: .normal)
        chooseButton.titleLabel?.font = UIFont.preferredFont(forTextStyle: .headline)
        chooseButton.layer.cornerRadius = 14
        chooseButton.heightAnchor.constraint(equalToConstant: 54).isActive = true
        chooseButton.addAction(UIAction { [weak self, weak wizard] _ in
            wizard?.dismiss(animated: true) {
                self?.presentBatteryScreenshotPicker()
            }
        }, for: .touchUpInside)

        let laterButton = UIButton(type: .system)
        laterButton.setTitle("I will upload later", for: .normal)
        laterButton.titleLabel?.font = UIFont.preferredFont(forTextStyle: .body)
        laterButton.addAction(UIAction { [weak wizard] _ in
            wizard?.dismiss(animated: true)
        }, for: .touchUpInside)

        [hero, titleLabel, detailLabel, stepsLabel, tipLabel, chooseButton, laterButton].forEach {
            stack.addArrangedSubview($0)
        }

        wizard.view.addSubview(scrollView)
        scrollView.addSubview(stack)
        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: wizard.view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: wizard.view.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: wizard.view.safeAreaLayoutGuide.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: wizard.view.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor),
            stack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            stack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            stack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor)
        ])

        let nav = UINavigationController(rootViewController: wizard)
        nav.navigationBar.prefersLargeTitles = false
        wizard.navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .close,
                                                                   target: self,
                                                                   action: #selector(dismissPresentedController))
        present(nav, animated: true)
    }

    @objc private func dismissPresentedController() {
        presentedViewController?.dismiss(animated: true)
    }

    private func presentBatteryScreenshotUploader() {
        presentBatteryScreenshotPicker()
    }

    private func presentBatteryScreenshotPicker() {
        var configuration = PHPickerConfiguration(photoLibrary: .shared())
        configuration.filter = .images
        configuration.selectionLimit = 1
        configuration.preferredAssetRepresentationMode = .current

        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = self
        present(picker, animated: true)
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let provider = results.first?.itemProvider else { return }
        guard provider.canLoadObject(ofClass: UIImage.self) else {
            showBatteryScreenshotUploadResult(title: "Upload Failed",
                                              message: "StudyTrace could not read the selected screenshot.")
            return
        }
        provider.loadObject(ofClass: UIImage.self) { [weak self] object, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let error = error {
                    self.showBatteryScreenshotUploadResult(title: "Upload Failed",
                                                           message: error.localizedDescription)
                    return
                }
                guard let image = object as? UIImage else {
                    self.showBatteryScreenshotUploadResult(title: "Upload Failed",
                                                           message: "StudyTrace could not read the selected screenshot.")
                    return
                }
                self.validateBatteryScreenshot(image) { validation in
                    self.presentBatteryScreenshotPreview(image: image, validation: validation)
                }
            }
        }
    }

    private struct BatteryScreenshotValidation {
        let isLikelyBatteryScreenshot: Bool
        let recognizedText: String
        let message: String
    }

    private func validateBatteryScreenshot(_ image: UIImage, completion: @escaping (BatteryScreenshotValidation) -> Void) {
        guard let cgImage = image.cgImage else {
            completion(BatteryScreenshotValidation(
                isLikelyBatteryScreenshot: false,
                recognizedText: "",
                message: "StudyTrace could not inspect this image before upload."
            ))
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            let request = VNRecognizeTextRequest { request, _ in
                let text = (request.results as? [VNRecognizedTextObservation] ?? [])
                    .compactMap { $0.topCandidates(1).first?.string }
                    .joined(separator: "\n")
                let validation = self.batteryScreenshotValidation(from: text)
                DispatchQueue.main.async {
                    completion(validation)
                }
            }
            request.recognitionLevel = .fast
            request.usesLanguageCorrection = true
            let handler = VNImageRequestHandler(cgImage: cgImage, orientation: CGImagePropertyOrientation(image.imageOrientation), options: [:])
            do {
                try handler.perform([request])
            } catch {
                DispatchQueue.main.async {
                    completion(BatteryScreenshotValidation(
                        isLikelyBatteryScreenshot: false,
                        recognizedText: "",
                        message: "StudyTrace could not inspect this image before upload."
                    ))
                }
            }
        }
    }

    private func batteryScreenshotValidation(from recognizedText: String) -> BatteryScreenshotValidation {
        let text = recognizedText.lowercased()
        let hasBatteryContext = text.contains("battery") ||
            text.contains("usage by app") ||
            text.contains("battery usage") ||
            text.contains("last 24 hours") ||
            text.contains("last 10 days")
        let hasAppUsageSignals = text.contains("%") ||
            text.contains("on screen") ||
            text.contains("screen on") ||
            text.range(of: #"(\d+\s*h)|(\d+\s*m)|(\d{1,2}:\d{2})"#, options: .regularExpression) != nil
        let likely = hasBatteryContext && hasAppUsageSignals
        let message = likely
            ? "This looks like an iOS Battery usage screenshot. Please confirm before upload."
            : "This may not be the right screenshot. The best screenshot shows Settings > Battery > View All Battery Usage with app names, percentages, and on-screen time."
        return BatteryScreenshotValidation(isLikelyBatteryScreenshot: likely,
                                           recognizedText: recognizedText,
                                           message: message)
    }

    private func presentBatteryScreenshotPreview(image: UIImage, validation: BatteryScreenshotValidation) {
        let preview = UIViewController()
        preview.view.backgroundColor = AWARETheme.canvas
        preview.title = "Review screenshot"

        let scrollView = UIScrollView()
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.isLayoutMarginsRelativeArrangement = true
        stack.layoutMargins = UIEdgeInsets(top: 18, left: 18, bottom: 26, right: 18)

        let imageView = UIImageView(image: image)
        imageView.contentMode = .scaleAspectFit
        imageView.backgroundColor = .black.withAlphaComponent(0.04)
        imageView.layer.cornerRadius = 14
        imageView.clipsToBounds = true
        imageView.heightAnchor.constraint(equalToConstant: 360).isActive = true

        let statusLabel = UILabel()
        statusLabel.text = validation.isLikelyBatteryScreenshot ? "Looks ready to upload" : "Please check this screenshot"
        statusLabel.font = UIFont.preferredFont(forTextStyle: .headline)
        statusLabel.textColor = validation.isLikelyBatteryScreenshot ? AWARETheme.accent : AWARETheme.warmAccent
        statusLabel.numberOfLines = 0

        let messageLabel = UILabel()
        messageLabel.text = validation.message
        messageLabel.font = UIFont.preferredFont(forTextStyle: .body)
        messageLabel.textColor = AWARETheme.secondaryInk
        messageLabel.numberOfLines = 0

        let uploadButton = UIButton(type: .system)
        uploadButton.setTitle(validation.isLikelyBatteryScreenshot ? "Use this screenshot" : "Upload anyway", for: .normal)
        uploadButton.backgroundColor = validation.isLikelyBatteryScreenshot ? AWARETheme.accent : AWARETheme.warmAccent
        uploadButton.setTitleColor(.white, for: .normal)
        uploadButton.titleLabel?.font = UIFont.preferredFont(forTextStyle: .headline)
        uploadButton.layer.cornerRadius = 14
        uploadButton.heightAnchor.constraint(equalToConstant: 54).isActive = true
        uploadButton.addAction(UIAction { [weak self, weak preview] _ in
            preview?.dismiss(animated: true) {
                self?.uploadBatteryScreenshot(image)
            }
        }, for: .touchUpInside)

        let chooseAgainButton = UIButton(type: .system)
        chooseAgainButton.setTitle("Choose another screenshot", for: .normal)
        chooseAgainButton.titleLabel?.font = UIFont.preferredFont(forTextStyle: .body)
        chooseAgainButton.addAction(UIAction { [weak self, weak preview] _ in
            preview?.dismiss(animated: true) {
                self?.presentBatteryScreenshotPicker()
            }
        }, for: .touchUpInside)

        [imageView, statusLabel, messageLabel, uploadButton, chooseAgainButton].forEach {
            stack.addArrangedSubview($0)
        }

        preview.view.addSubview(scrollView)
        scrollView.addSubview(stack)
        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: preview.view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: preview.view.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: preview.view.safeAreaLayoutGuide.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: preview.view.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor),
            stack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            stack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            stack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor)
        ])

        let nav = UINavigationController(rootViewController: preview)
        preview.navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .cancel,
                                                                    target: self,
                                                                    action: #selector(dismissPresentedController))
        present(nav, animated: true)
    }

    private func uploadBatteryScreenshot(_ image: UIImage) {
        guard !isUploadingBatteryScreenshot else { return }
        guard let studyURL = AWAREStudy.shared().getURL(), !studyURL.isEmpty else {
            showBatteryScreenshotUploadResult(title: "Study Not Configured",
                                              message: "Join a study before uploading a Battery screenshot.")
            return
        }
        guard let imageData = image.jpegData(compressionQuality: 0.85) else {
            showBatteryScreenshotUploadResult(title: "Upload Failed",
                                              message: "StudyTrace could not prepare the selected screenshot.")
            return
        }

        isUploadingBatteryScreenshot = true
        StudyTraceTelemetry.recordEvent("battery_screenshot_upload_started", metadata: [
            "image_bytes": imageData.count
        ])
        let timestamp = Date().timeIntervalSince1970 * 1000
        let deviceId = AWAREStudy.shared().getDeviceId()
        guard let request = batteryScreenshotUploadRequest(studyURL: studyURL,
                                                           deviceId: deviceId,
                                                           timestamp: timestamp,
                                                           screenshotBase64: imageData.base64EncodedString()) else {
            isUploadingBatteryScreenshot = false
            StudyTraceTelemetry.recordEvent("battery_screenshot_upload_failed", metadata: [
                "reason": "invalid_upload_url"
            ])
            showBatteryScreenshotUploadResult(title: "Study Not Configured",
                                              message: "StudyTrace could not prepare the Battery screenshot upload URL. Please rejoin the study, then try again.")
            return
        }

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.isUploadingBatteryScreenshot = false
                if let error = error {
                    StudyTraceTelemetry.recordEvent("battery_screenshot_upload_failed", metadata: [
                        "transport_error": error.localizedDescription
                    ])
                    self.showBatteryScreenshotUploadResult(title: "Upload Failed", message: error.localizedDescription)
                    return
                }
                let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
                if (200..<300).contains(statusCode) {
                    let feedback = self.batteryScreenshotUploadFeedback(from: data)
                    StudyTraceTelemetry.recordEvent("battery_screenshot_upload_succeeded", metadata: [
                        "http_status": statusCode,
                        "app_rows_detected": feedback?.appRowsDetected ?? 0,
                        "needs_review": feedback?.needsReview ?? false
                    ])
                    if feedback?.needsReview == true {
                        self.showBatteryScreenshotRetakeResult(
                            title: "Please Retake Battery Screenshot",
                            message: feedback?.message ?? "Your screenshot uploaded, but StudyTrace could not read the app usage rows clearly. Please retake the Settings > Battery > View All Battery Usage screenshot and upload it again."
                        )
                        return
                    }
                    if let schedule = self.activeBatterySchedule {
                        self.markBatteryScheduleCompleted(schedule)
                    }
                    self.batteryInstructionStack.isHidden = true
                    self.checkESMSchedules()
                    self.showBatteryScreenshotUploadResult(title: "Battery Screenshot Uploaded",
                                                           message: feedback?.message ?? "Your screenshot was uploaded to the study server.")
                } else {
                    let serverMessage = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                    StudyTraceTelemetry.recordEvent("battery_screenshot_upload_failed", metadata: [
                        "http_status": statusCode,
                        "server_response": serverMessage
                    ])
                    let detail = serverMessage.isEmpty ? "" : "\n\nServer response: \(serverMessage)"
                    self.showBatteryScreenshotUploadResult(title: "Upload Failed",
                                                           message: "The study server returned HTTP \(statusCode).\(detail)")
                }
            }
        }.resume()
    }

    private struct BatteryScreenshotUploadFeedback {
        let appRowsDetected: Int
        let needsReview: Bool
        let qaReason: String
        let message: String
    }

    private func batteryScreenshotUploadFeedback(from data: Data?) -> BatteryScreenshotUploadFeedback? {
        guard let data = data,
              let object = try? JSONSerialization.jsonObject(with: data, options: []),
              let json = object as? [String: Any],
              let feedback = json["feedback"] as? [String: Any] else {
            return nil
        }
        return BatteryScreenshotUploadFeedback(
            appRowsDetected: feedback["app_rows_detected"] as? Int ?? 0,
            needsReview: feedback["needs_review"] as? Bool ?? false,
            qaReason: feedback["qa_reason"] as? String ?? "",
            message: feedback["message"] as? String ?? "Your screenshot was uploaded to the study server."
        )
    }

    private func batteryScreenshotUploadRequest(studyURL: String,
                                                deviceId: String,
                                                timestamp: Double,
                                                screenshotBase64: String) -> URLRequest? {
        guard let target = batteryScreenshotUploadTarget(from: studyURL) else { return nil }
        let payload: [String: Any] = [
            "device_id": deviceId,
            "timestamp": timestamp,
            "screenshot_base64": screenshotBase64,
            "esm_json": jsonString([
                "esm_type": 14,
                "esm_title": "Battery usage screenshot",
                "esm_instructions": "Open Settings > Battery > View All Battery Usage, then upload the screenshot.",
                "esm_trigger": "battery_usage_screenshot",
                "esm_submit": "Submit",
                "esm_na": true
            ])
        ]
        guard JSONSerialization.isValidJSONObject(payload),
              let body = try? JSONSerialization.data(withJSONObject: payload, options: []) else {
            StudyTraceTelemetry.recordEvent("battery_screenshot_upload_failed", metadata: [
                "reason": "invalid_payload"
            ])
            return nil
        }

        var request = URLRequest(url: target)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        return request
    }

    private func batteryScreenshotUploadTarget(from studyURL: String) -> URL? {
        guard var components = URLComponents(string: studyURL),
              components.scheme?.lowercased() == "https",
              components.host?.isEmpty == false else {
            return nil
        }
        let path = components.percentEncodedPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard path.contains("index.php/webservice/index") else { return nil }
        components.percentEncodedPath = "/\(path)/battery-screenshots"
        components.query = nil
        components.fragment = nil
        return components.url
    }

    private func jsonString(_ value: Any) -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: []),
              let string = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return string
    }

    private func markBatteryScheduleCompleted(_ schedule: EntityESMSchedule) {
        guard let context = CoreDataHandler.shared().managedObjectContext else {
            return
        }
        let entity = NSEntityDescription.insertNewObject(forEntityName: "EntityESMAnswerHistory", into: context)
        context.persistentStoreCoordinator = CoreDataHandler.shared().persistentStoreCoordinator
        entity.setValue(Date().timeIntervalSince1970, forKey: "timestamp")
        entity.setValue(schedule.fire_hour, forKey: "fire_hour")
        entity.setValue(schedule.schedule_id, forKey: "schedule_id")
        try? context.save()
    }

    private func showBatteryScreenshotUploadResult(title: String, message: String) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }

    private func showBatteryScreenshotRetakeResult(title: String, message: String) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Retake / Choose Again", style: .default) { [weak self] _ in
            self?.presentBatteryScreenshotWizard()
        })
        alert.addAction(UIAlertAction(title: "Keep Uploaded Screenshot", style: .cancel))
        present(alert, animated: true)
    }
    
    // MARK: - Navigation

    // In a storyboard-based application, you will often want to do a little preparation before navigation
    override func prepare(for segue: UIStoryboardSegue, sender: Any?) {
        // Get the new view controller using segue.destination.
        // Pass the selected object to the new view controller.
        
//        if let next = segue.destination as? ESMScrollViewController{
//            next.tabBarController?.tabBar.isHidden = true
//        }
//        self.tabBarController?.tabBar.isHidden = true
        
    }

}

extension UIColor {
    static let system = UIColor.tintColor
}

private extension CGImagePropertyOrientation {
    init(_ orientation: UIImage.Orientation) {
        switch orientation {
        case .up: self = .up
        case .upMirrored: self = .upMirrored
        case .down: self = .down
        case .downMirrored: self = .downMirrored
        case .left: self = .left
        case .leftMirrored: self = .leftMirrored
        case .right: self = .right
        case .rightMirrored: self = .rightMirrored
        @unknown default: self = .up
        }
    }
}

extension IOSESM {
    
}
