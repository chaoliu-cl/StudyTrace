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

struct SurveyNotificationTarget: Equatable {
    let scheduleId: String
    let occurrenceId: String

    init?(identifier: String, userInfo: [AnyHashable: Any]) {
        guard let scheduleId = userInfo["schedule_id"] as? String,
              !scheduleId.isEmpty, !identifier.isEmpty else { return nil }
        self.scheduleId = scheduleId
        self.occurrenceId = identifier
    }
}

class ESMViewController: UIViewController {

    @IBOutlet weak var surveyButton: UIButton!

    private let emptyStateStack = UIStackView()
    private let promptStack = UIStackView()
    private var promptButtons: [UsageScreenshotKind: UIButton] = [:]
    private var activeScreenshotSchedules: [UsageScreenshotKind: EntityESMSchedule] = [:]
    private let screenshotCoordinator = UsageScreenshotCoordinator()
    private var pendingNotification: SurveyNotificationTarget?

    /// Keep the target until this screen is visible, including a cold launch
    /// or a tap while another questionnaire/photo picker is still open.
    func openNotification(_ target: SurveyNotificationTarget) {
        if let form = navigationController?.topViewController as? ESMScrollViewController,
           form.studytraceTargetOccurrenceId == target.occurrenceId { return }
        pendingNotification = target
        openPendingNotificationIfReady()
    }

    private func openPendingNotificationIfReady() {
        guard let target = pendingNotification, viewIfLoaded?.window != nil,
              presentedViewController == nil, !screenshotCoordinator.isBusy,
              navigationController?.topViewController == self else { return }
        pendingNotification = nil
        guard StudyParticipationController.hasConsent() else { return }
        let manager = ESMScheduleManager.shared()
        let schedules = manager.getValidSchedules() as? [EntityESMSchedule] ?? []
        guard let schedule = schedules.first(where: { $0.schedule_id == target.scheduleId }),
              let occurrence = manager.studytraceOccurrence(identifier: target.occurrenceId, at: Date()),
              occurrence["schedule_id"] as? String == target.scheduleId else {
            showScreenshotResult(title: "Request no longer available",
                                 message: "This request has been completed, removed, or its response window has ended. Check Surveys for your current requests.")
            return
        }
        if let kind = screenshotKind(for: schedule) {
            startScreenshot(kind, schedule: schedule, occurrence: occurrence)
        } else {
            performSegue(withIdentifier: "toESMScrollView", sender: target)
        }
    }

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
        screenshotCoordinator.onReturnToPresenter = { [weak self] in self?.openPendingNotificationIfReady() }

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
        for kind in [UsageScreenshotKind.battery, .screenTimeActivity, .appUsageToday] {
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
        super.viewDidAppear(animated)
        self.tabBarController?.tabBar.isHidden = false
        NotificationCenter.default.addObserver(self, selector: #selector(willEnterForegroundNotification(notification:)), name: UIApplication.willEnterForegroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(surveyTimingUpdated), name: Notification.Name("StudyTraceSurveyTimingUpdated"), object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(surveyTimingUpdated), name: Notification.Name("StudyTraceESMConfigurationUpdated"), object: nil)
        self.checkESMSchedules()
        self.hideContextViewIfNeeded()
        if StudyParticipationController.hasConsent() {
            _ = LocationPermissionManager().isAuthorizedAlways(with: self)
        }
        openPendingNotificationIfReady()
    }
    
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        NotificationCenter.default.removeObserver(self, name: UIApplication.willEnterForegroundNotification, object: nil)
        NotificationCenter.default.removeObserver(self, name: Notification.Name("StudyTraceSurveyTimingUpdated"), object: nil)
        NotificationCenter.default.removeObserver(self, name: Notification.Name("StudyTraceESMConfigurationUpdated"), object: nil)
    }

    @objc private func surveyTimingUpdated() {
        checkESMSchedules()
        openPendingNotificationIfReady()
    }
    
    @objc func willEnterForegroundNotification(notification: NSNotification) {
        self.checkESMSchedules()
        if StudyParticipationController.hasConsent() {
            _ = LocationPermissionManager().isAuthorizedAlways(with: self)
        }
        openPendingNotificationIfReady()
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
        if scheduleId.contains("app_usage_screenshot") { return .appUsageToday }
        if scheduleId.contains("screen_time_activity") { return .screenTimeActivity }
        var isBattery = scheduleId.contains("battery")
        if let esms = schedule.esms {
            for item in esms {
                let trigger = item.esm_trigger?.lowercased() ?? ""
                if trigger == UsageScreenshotKind.appUsageToday.promptTrigger { return .appUsageToday }
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
        if AppStoreDemo.isEnabled {
            presentDemoInstructions(for: kind)
            return
        }
        guard let schedule = activeScreenshotSchedules[kind],
              let occurrence = ESMScheduleManager.shared().studytraceOccurrence(for: schedule, at: Date()) else {
            checkESMSchedules()
            showScreenshotResult(title: "Screenshot request closed", message: "There is no open request. Please wait for the next notification.")
            return
        }
        startScreenshot(kind, schedule: schedule, occurrence: occurrence)
    }

    private func startScreenshot(_ kind: UsageScreenshotKind, schedule: EntityESMSchedule, occurrence: [AnyHashable: Any]) {
        guard let identifier = occurrence["id"] as? String,
              let delivered = occurrence["delivered_at"] as? NSNumber,
              let expires = occurrence["expires_at"] as? NSNumber else { return }
        let scheduleId = schedule.schedule_id ?? ""
        let period = ["morning", "afternoon", "evening"].first { scheduleId.contains("_\($0)_") } ?? "test"
        let prompt = UsageScreenshotPrompt(identifier: identifier, scheduleId: scheduleId, period: period,
            scheduledAt: Date(timeIntervalSince1970: (occurrence["planned_at"] as? NSNumber)?.doubleValue ?? delivered.doubleValue),
            deliveredAt: Date(timeIntervalSince1970: delivered.doubleValue),
            expiresAt: Date(timeIntervalSince1970: expires.doubleValue))
        screenshotCoordinator.start(kind: kind, from: self, prompt: prompt, validatePrompt: {
            ESMScheduleManager.shared().studytraceOccurrenceIsOpen(identifier, at: Date())
        }) { [weak self] kind, outcome in
            self?.handleScreenshotOutcome(kind, outcome, schedule: schedule)
        }
    }

    func presentDemoInstructions(for kind: UsageScreenshotKind) {
        screenshotCoordinator.start(kind: kind, from: self) { _, _ in }
    }

    private func handleScreenshotOutcome(_ kind: UsageScreenshotKind, _ outcome: UsageScreenshotUploader.Outcome, schedule: EntityESMSchedule) {
        switch outcome {
        case .uploaded(let feedback):
            completeScreenshotSchedule(schedule)
            showScreenshotResult(title: "Screenshot Uploaded",
                                 message: feedback?.participantMessage ?? "Your screenshot was uploaded to the study server.")
        case .queued:
            // The screenshot is safely stored and will upload on its own,
            // so the participant has done their part for this prompt.
            completeScreenshotSchedule(schedule)
            showScreenshotResult(title: "Screenshot Saved",
                                 message: "StudyTrace could not reach the study server right now. Your screenshot is saved on this iPhone and will upload automatically when a connection is available.")
        case .failed(let title, let message):
            showScreenshotResult(title: title, message: message)
        }
    }

    private func completeScreenshotSchedule(_ schedule: EntityESMSchedule) {
        markScheduleCompleted(schedule)
        checkESMSchedules()
    }

    private func markScheduleCompleted(_ schedule: EntityESMSchedule) {
        let manager = ESMScheduleManager.shared()
        if let occurrence = manager.studytraceOccurrence(for: schedule, at: Date()),
           let identifier = occurrence["id"] as? String {
            manager.studytraceCompleteOccurrence(identifier)
        }
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
        alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self, weak alert] _ in
            alert?.dismiss(animated: true) { self?.openPendingNotificationIfReady() }
        })
        present(alert, animated: true)
    }

    // MARK: - Navigation

    // In a storyboard-based application, you will often want to do a little preparation before navigation
    override func prepare(for segue: UIStoryboardSegue, sender: Any?) {
        if segue.identifier == "toESMScrollView",
           let target = sender as? SurveyNotificationTarget,
           let form = segue.destination as? ESMScrollViewController {
            form.studytraceTargetScheduleId = target.scheduleId
            form.studytraceTargetOccurrenceId = target.occurrenceId
        }
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
