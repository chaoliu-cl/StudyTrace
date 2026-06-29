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

class ESMViewController: UIViewController, UIImagePickerControllerDelegate, UINavigationControllerDelegate {

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
        batteryInstructionStack.isHidden = false
        AWARETheme.mediumImpact()
    }

    @objc private func didPushBatteryUploadButton() {
        presentBatteryScreenshotUploader()
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

    private func presentBatteryScreenshotUploader() {
        guard UIImagePickerController.isSourceTypeAvailable(.photoLibrary) else {
            showBatteryScreenshotUploadResult(title: "Photo Library Unavailable",
                                              message: "StudyTrace could not open the photo library on this device.")
            return
        }

        let picker = UIImagePickerController()
        picker.sourceType = .photoLibrary
        picker.delegate = self
        present(picker, animated: true)
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
    }

    func imagePickerController(_ picker: UIImagePickerController,
                               didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey : Any]) {
        picker.dismiss(animated: true)
        guard let image = info[.originalImage] as? UIImage else {
            showBatteryScreenshotUploadResult(title: "Upload Failed",
                                              message: "StudyTrace could not read the selected screenshot.")
            return
        }
        uploadBatteryScreenshot(image)
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
        let timestamp = Date().timeIntervalSince1970 * 1000
        let deviceId = AWAREStudy.shared().getDeviceId()
        guard let request = batteryScreenshotUploadRequest(studyURL: studyURL,
                                                           deviceId: deviceId,
                                                           timestamp: timestamp,
                                                           screenshotBase64: imageData.base64EncodedString()) else {
            isUploadingBatteryScreenshot = false
            showBatteryScreenshotUploadResult(title: "Study Not Configured",
                                              message: "StudyTrace could not prepare the Battery screenshot upload URL. Please rejoin the study, then try again.")
            return
        }

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.isUploadingBatteryScreenshot = false
                if let error = error {
                    self.showBatteryScreenshotUploadResult(title: "Upload Failed", message: error.localizedDescription)
                    return
                }
                let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
                if (200..<300).contains(statusCode) {
                    if let schedule = self.activeBatterySchedule {
                        self.markBatteryScheduleCompleted(schedule)
                    }
                    self.batteryInstructionStack.isHidden = true
                    self.checkESMSchedules()
                    self.showBatteryScreenshotUploadResult(title: "Battery Screenshot Uploaded",
                                                           message: "Your screenshot was uploaded to the study server.")
                } else {
                    let serverMessage = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                    let detail = serverMessage.isEmpty ? "" : "\n\nServer response: \(serverMessage)"
                    self.showBatteryScreenshotUploadResult(title: "Upload Failed",
                                                           message: "The study server returned HTTP \(statusCode).\(detail)")
                }
            }
        }.resume()
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

extension IOSESM {
    
}
