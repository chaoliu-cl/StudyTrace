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

class ESMViewController: UIViewController {

    @IBOutlet weak var surveyButton: UIButton!

    private let emptyStateStack = UIStackView()
    private let promptStack = UIStackView()
    private var promptButtons: [UsageScreenshotKind: UIButton] = [:]
    private var activeScreenshotSchedules: [UsageScreenshotKind: EntityESMSchedule] = [:]
    private let screenshotCoordinator = UsageScreenshotCoordinator()

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
        if UIDevice.current.userInterfaceIdiom == .pad {
            surveyButton.constraints.first(where: { $0.firstAttribute == .width })?.constant = 520
            surveyButton.constraints.first(where: { $0.firstAttribute == .height })?.constant = 72
        }
        navigationController?.navigationBar.prefersLargeTitles = true

        setupEmptyState()
        setupScreenshotPrompts()

        if OnboardingManager.needsOnboarding() {
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

    /// One button per screenshot prompt type, shown while a prompt is open.
    private func setupScreenshotPrompts() {
        promptStack.axis = .vertical
        promptStack.alignment = .center
        promptStack.spacing = 14
        promptStack.translatesAutoresizingMaskIntoConstraints = false
        for kind in [UsageScreenshotKind.battery, .screenTimeActivity] {
            let button = UIButton(type: .system)
            button.backgroundColor = AWARETheme.warmAccent
            button.setTitleColor(.white, for: .normal)
            button.setTitle(kind.promptButtonTitle, for: .normal)
            button.setImage(UIImage(systemName: kind.heroSymbol), for: .normal)
            button.tintColor = .white
            button.titleLabel?.font = UIFont.preferredFont(forTextStyle: .headline)
            button.titleLabel?.adjustsFontForContentSizeCategory = true
            button.titleLabel?.numberOfLines = 2
            button.layer.cornerRadius = 16
            button.layer.shadowColor = AWARETheme.warmAccent.cgColor
            button.layer.shadowOpacity = 0.25
            button.layer.shadowRadius = 12
            button.layer.shadowOffset = CGSize(width: 0, height: 6)
            button.imageEdgeInsets = UIEdgeInsets(top: 0, left: -8, bottom: 0, right: 8)
            button.widthAnchor.constraint(equalToConstant: UIDevice.current.userInterfaceIdiom == .pad ? 520 : 280).isActive = true
            button.heightAnchor.constraint(greaterThanOrEqualToConstant: 72).isActive = true
            button.addAction(UIAction { [weak self] _ in
                AWARETheme.mediumImpact()
                self?.startScreenshot(kind)
            }, for: .touchUpInside)
            button.isHidden = true
            promptButtons[kind] = button
            promptStack.addArrangedSubview(button)
        }
        view.addSubview(promptStack)
        NSLayoutConstraint.activate([
            promptStack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            promptStack.topAnchor.constraint(equalTo: surveyButton.bottomAnchor, constant: 18)
        ])
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
        if AppStoreDemo.isEnabled {
            surveyButton.setTitle(" Daily check-in • 3 questions", for: .normal)
            surveyButton.setImage(UIImage(systemName: "checklist"), for: .normal)
            surveyButton.backgroundColor = AWARETheme.accent
            surveyButton.isEnabled = true
            surveyButton.isHidden = false
            for button in promptButtons.values {
                button.isHidden = false
                button.isEnabled = true
            }
            emptyStateStack.isHidden = true
            let tabHost: UIViewController = navigationController ?? self
            tabHost.tabBarItem.badgeValue = "3"
            tabHost.tabBarItem.badgeColor = AWARETheme.warmAccent
            return
        }

        self.tabBarController?.tabBar.isHidden = false
        let esmManager = ESMScheduleManager.shared()
        let schedules = esmManager.getValidSchedules() as? [EntityESMSchedule] ?? []
        let regularSchedules = schedules.filter { screenshotKind(for: $0) == nil }
        activeScreenshotSchedules = [:]
        for schedule in schedules {
            if let kind = screenshotKind(for: schedule), activeScreenshotSchedules[kind] == nil {
                activeScreenshotSchedules[kind] = schedule
            }
        }

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

        for (kind, button) in promptButtons {
            let open = activeScreenshotSchedules[kind] != nil
            button.isHidden = !open
            button.isEnabled = open
        }

        let totalCount = regularSchedules.count + activeScreenshotSchedules.count
        emptyStateStack.isHidden = totalCount > 0
        // The tab bar item belongs to this screen's navigation controller, so
        // the badge lands on the Surveys tab regardless of tab order.
        let tabHost: UIViewController = navigationController ?? self
        tabHost.tabBarItem.badgeValue = totalCount > 0 ? "\(totalCount)" : nil
        tabHost.tabBarItem.badgeColor = AWARETheme.warmAccent
        IOSESM.setESMAppearedState(true)
    }

    @IBAction func didPushSurveyButton(_ sender: UIButton) {
        let esmManager = ESMScheduleManager.shared()
        let schedules = (esmManager.getValidSchedules() as? [EntityESMSchedule] ?? []).filter { screenshotKind(for: $0) == nil }
        if(schedules.count > 0){
            self.performSegue(withIdentifier: "toESMScrollView", sender: self)
            self.tabBarController?.tabBar.isHidden = true
        }
    }

    /// Which screenshot a schedule asks for, or nil for an ordinary survey.
    private func screenshotKind(for schedule: EntityESMSchedule) -> UsageScreenshotKind? {
        let scheduleId = schedule.schedule_id?.lowercased() ?? ""
        if scheduleId.contains("screen_time_activity") { return .screenTimeActivity }
        var isBattery = scheduleId.contains("battery")
        if let esms = schedule.esms {
            for item in esms {
                let trigger = item.esm_trigger?.lowercased() ?? ""
                if trigger == UsageScreenshotKind.screenTimeActivity.promptTrigger { return .screenTimeActivity }
                let title = item.esm_title?.lowercased() ?? ""
                let instructions = item.esm_instructions?.lowercased() ?? ""
                if trigger == UsageScreenshotKind.battery.promptTrigger ||
                    title.contains("battery") ||
                    instructions.contains("battery usage screenshot") {
                    isBattery = true
                }
            }
        }
        return isBattery ? .battery : nil
    }

    private func startScreenshot(_ kind: UsageScreenshotKind) {
        screenshotCoordinator.start(kind: kind, from: self) { [weak self] kind, outcome in
            self?.handleScreenshotOutcome(kind, outcome)
        }
    }

    func presentDemoInstructions(for kind: UsageScreenshotKind) {
        screenshotCoordinator.start(kind: kind, from: self) { _, _ in }
    }

    private func handleScreenshotOutcome(_ kind: UsageScreenshotKind, _ outcome: UsageScreenshotUploader.Outcome) {
        switch outcome {
        case .uploaded(let feedback):
            if feedback?.needsReview == true {
                let alert = UIAlertController(title: "Please Retake Screenshot",
                                              message: feedback?.message ?? "Your screenshot uploaded, but StudyTrace could not read it clearly. Please retake it and upload it again.",
                                              preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "Retake / Choose Again", style: .default) { [weak self] _ in
                    self?.startScreenshot(kind)
                })
                // Keeping the upload still counts as answering the prompt.
                alert.addAction(UIAlertAction(title: "Keep Uploaded Screenshot", style: .cancel) { [weak self] _ in
                    self?.completeScreenshotSchedule(kind)
                })
                present(alert, animated: true)
                return
            }
            completeScreenshotSchedule(kind)
            showScreenshotResult(title: "Screenshot Uploaded",
                                 message: feedback?.message ?? "Your screenshot was uploaded to the study server.")
        case .queued:
            // The screenshot is safely stored and will upload on its own,
            // so the participant has done their part for this prompt.
            completeScreenshotSchedule(kind)
            showScreenshotResult(title: "Screenshot Saved",
                                 message: "StudyTrace could not reach the study server right now. Your screenshot is saved on this iPhone and will upload automatically when a connection is available.")
        case .failed(let title, let message):
            showScreenshotResult(title: title, message: message)
        }
    }

    private func completeScreenshotSchedule(_ kind: UsageScreenshotKind) {
        if let schedule = activeScreenshotSchedules[kind] {
            markScheduleCompleted(schedule)
        }
        checkESMSchedules()
    }

    private func markScheduleCompleted(_ schedule: EntityESMSchedule) {
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

    private func showScreenshotResult(title: String, message: String) {
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
