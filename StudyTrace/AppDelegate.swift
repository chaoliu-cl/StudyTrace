//
//  AppDelegate.swift
//  StudyTrace
//
//  Created by Yuuki Nishiyama on 2019/02/27.
//  Copyright © 2019 Yuuki Nishiyama. All rights reserved.
//

import UIKit
import CoreData
import AWAREFramework
import BackgroundTasks
import CoreLocation

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    static let bgSyncTaskIdentifier = "com.awareframework.client.sync"
    static let bgRefreshTaskIdentifier = "com.awareframework.client.refresh"

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Read before anything below records telemetry for this launch.
        let launchInfo = StudyTraceSessionTracker.launchMetadata(launchOptions: launchOptions)
        StudyTraceTelemetry.updateCachedAppState()
        StudyTraceUploadQueue.shared.activate()
        LegacyScreenTimeCleanup.purgeIfNeeded()
        let study = AWAREStudy.shared()
        StudyParticipationController.refreshCollectionState(
            fitbitPresenter: window?.rootViewController,
            createRemoteTables: false
        )
        if StudyParticipationController.hasConsent() {
            AWARECore.shared().requestPermissionForPushNotification { (_, _) in }
        }

        IOSESM.setESMAppearedState(false)

        let key = "studytrace.setting.key.is-not-first-time"
        if(!UserDefaults.standard.bool(forKey:key)){
            study.setCleanOldDataType(cleanOldDataTypeNever)
            UserDefaults.standard.set(true, forKey: key)
        }

        UserDefaults.standard.set(false, forKey: AdvancedSettingsIdentifiers.statusMonitor.rawValue)

        UNUserNotificationCenter.current().delegate = self

        registerBackgroundTasks()
        StudyParticipationController.retryPendingWithdrawal()

        AWAREEventLogger.shared().logEvent(["class":"AppDelegate",
                                            "event":"application:didFinishLaunchingWithOptions:launchOptions:"]);
        StudyTraceTelemetry.recordEvent("app_launch", metadata: launchInfo)
        StudyTraceTelemetry.uploadDeviceState(reason: "app_launch")
        StudyTraceHeartbeat.start()
        StudyTraceNotificationAudit.reportDeliveredNotifications()

        return true
    }

    /// iOS relaunches the app to report background uploads that finished
    /// while it was suspended or terminated.
    func application(_ application: UIApplication,
                     handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        guard identifier == StudyTraceUploadQueue.sessionIdentifier else {
            completionHandler()
            return
        }
        StudyTraceUploadQueue.shared.backgroundEventsCompletionHandler = completionHandler
        StudyTraceUploadQueue.shared.activate()
    }

    private func registerBackgroundTasks() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.bgSyncTaskIdentifier, using: nil) { task in
            self.handleBackgroundSync(task: task as! BGProcessingTask)
        }
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.bgRefreshTaskIdentifier, using: nil) { task in
            self.handleBackgroundRefresh(task: task as! BGAppRefreshTask)
        }
    }

    func scheduleBackgroundSync() {
        guard StudyParticipationController.hasConsent() else { return }
        StudyTraceTelemetry.recordEvent("background_sync_scheduled")
        let request = BGProcessingTaskRequest(identifier: Self.bgSyncTaskIdentifier)
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = false
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    func scheduleBackgroundRefresh() {
        guard StudyParticipationController.hasConsent() else { return }
        StudyTraceTelemetry.recordEvent("background_refresh_scheduled")
        let request = BGAppRefreshTaskRequest(identifier: Self.bgRefreshTaskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 30 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    private func handleBackgroundSync(task: BGProcessingTask) {
        guard StudyParticipationController.hasConsent() else {
            task.setTaskCompleted(success: true)
            return
        }
        StudyTraceTelemetry.recordEvent("background_sync_started")
        scheduleBackgroundSync()

        let manager = AWARESensorManager.shared()
        manager.syncAllSensorsForcefully()
        StudyTraceHeartbeat.beatIfDue()
        StudyTraceTelemetry.flush()

        task.expirationHandler = {
            task.setTaskCompleted(success: false)
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 25) {
            StudyTraceTelemetry.recordEvent("background_sync_completed")
            task.setTaskCompleted(success: true)
        }
    }

    private func handleBackgroundRefresh(task: BGAppRefreshTask) {
        StudyTraceTelemetry.recordEvent("background_refresh_started")
        refreshRemoteESMScheduleIfNeeded(force: false)
        StudyTraceHeartbeat.beatIfDue()
        StudyTraceNotificationAudit.reportDeliveredNotifications()
        scheduleBackgroundRefresh()
        StudyTraceTelemetry.recordEvent("background_refresh_completed")
        StudyTraceTelemetry.flush()
        task.setTaskCompleted(success: true)
    }

    func applicationWillResignActive(_ application: UIApplication) {
        StudyTraceTelemetry.updateCachedAppState()
        StudyTraceTelemetry.recordEvent("app_will_resign_active")
        AWAREEventLogger.shared().logEvent(["class":"AppDelegate",
                                            "event":"applicationWillResignActive:"]);
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        StudyTraceTelemetry.updateCachedAppState()
        StudyTraceTelemetry.recordEvent("app_enter_background")
        StudyTraceTelemetry.uploadDeviceState(reason: "app_enter_background")
        StudyTraceTelemetry.flush()
        IOSESM.setESMAppearedState(false)
        UIApplication.shared.applicationIconBadgeNumber = 0
        if StudyParticipationController.hasConsent() {
            scheduleBackgroundSync()
            scheduleBackgroundRefresh()
        }
        AWAREEventLogger.shared().logEvent(["class":"AppDelegate",
                                            "event":"applicationDidEnterBackground:"]);
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        StudyParticipationController.retryPendingWithdrawal()
        StudyTraceTelemetry.updateCachedAppState()
        StudyTraceTelemetry.recordEvent("app_will_enter_foreground")
        StudyTraceNotificationAudit.reportDeliveredNotifications()
        StudyTraceUploadQueue.shared.drain()
        refreshRemoteESMScheduleIfNeeded(force: true)
        AWAREEventLogger.shared().logEvent(["class":"AppDelegate",
                                            "event":"applicationWillEnterForeground:"]);
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        StudyTraceTelemetry.updateCachedAppState()
        StudyTraceTelemetry.recordEvent("app_did_become_active")
        StudyTraceHeartbeat.beatIfDue()
        StudyTraceTelemetry.uploadDeviceState(reason: "app_did_become_active")
        refreshRemoteESMScheduleIfNeeded(force: true)
        AWAREEventLogger.shared().logEvent(["class":"AppDelegate",
                                            "event":"applicationDidBecomeActive:"]);
        AppStoreCaptureDriver.runIfNeeded(window: window)
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Only nudge active participants to reopen the app; someone who has
        // withdrawn must not be asked to resume data collection.
        if StudyParticipationController.hasConsent() {
            AWAREUtils.sendLocalPushNotification(withTitle: NSLocalizedString("terminate_title" , comment: ""),
                                                 body: NSLocalizedString("terminate_msg" , comment: ""),
                                                 timeInterval: 1,
                                                 repeats: false)
        }
        AWAREEventLogger.shared().logEvent(["class":"AppDelegate",
                                            "event":"applicationWillTerminate:"]);
        self.saveContext()
    }

    private func refreshRemoteESMScheduleIfNeeded(force: Bool) {
        guard StudyParticipationController.hasConsent() else { return }
        let key = "studytrace.lastRemoteESMScheduleRefresh"
        let now = Date()
        let lastRefresh = UserDefaults.standard.object(forKey: key) as? Date ?? .distantPast
        guard force || now.timeIntervalSince(lastRefresh) > 10 * 60 else { return }

        let url = AWAREStudy.shared().getSetting(AWARE_PREFERENCES_PLUGIN_IOS_ESM_CONFIG_URL)
        guard !url.isEmpty,
              let esm = AWARESensorManager.shared().getSensor(SENSOR_PLUGIN_IOS_ESM) as? IOSESM else {
            return
        }

        UserDefaults.standard.set(now, forKey: key)
        StudyTraceTelemetry.recordEvent("esm_schedule_refresh_started", metadata: ["force": force])
        _ = esm.startSensor(withURL: url)
        StudyTraceTelemetry.recordEvent("esm_schedule_refresh_requested", metadata: ["force": force])
    }
    
    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey : Any] = [:]) -> Bool {
        
        AWAREEventLogger.shared().logEvent(["class":"AppDelegate",
                                            "event":"application:open:options"]);
        
        if url.scheme == "fitbit" {
            let manager = AWARESensorManager.shared()
            if let fitbit = manager.getSensor(SENSOR_PLUGIN_FITBIT) as? Fitbit {
                fitbit.handle(url, sourceApplication: nil, annotation: options)
            }
        } else if url.scheme == "aware-ssl" || url.scheme == "aware" {
            var studyURL = url.absoluteString
            if studyURL.prefix(9) == "aware-ssl" {
                let range = studyURL.range(of: "aware-ssl")
                if let range = range {
                    studyURL = studyURL.replacingCharacters(in: range, with: "https")
                }
            } else if studyURL.prefix(5) == "aware" {
                let range = studyURL.range(of: "aware")
                if let range = range {
                    // Enforce HTTPS: the plain "aware" scheme is mapped to https,
                    // never http, so study joins always use a secure connection.
                    studyURL = studyURL.replacingCharacters(in: range, with: "https")
                }
            }
            let study = AWAREStudy.shared()
            study.join(withURL: studyURL) { (settings, status, error) in
                if status == AwareStudyStateUpdate || status == AwareStudyStateNew {
                    StudyTraceTelemetry.recordEvent("study_joined", metadata: ["status": "\(status)"])
                    let core = AWARECore.shared()
                    guard StudyParticipationController.hasConsent() else { return }
                    core.requestPermissionForPushNotification { (_, _) in
                        core.requestPermissionForBackgroundSensing { _ in
                            StudyParticipationController.refreshCollectionState(
                                fitbitPresenter: self.window?.rootViewController,
                                createRemoteTables: true
                            )
                            self.refreshRemoteESMScheduleIfNeeded(force: true)
                            StudyTraceTelemetry.uploadDeviceState(reason: "study_joined")
                        }
                    }
                }else {
                    StudyTraceTelemetry.recordEvent("study_join_failed", metadata: [
                        "status": "\(status)",
                        "error": error?.localizedDescription ?? ""
                    ])
                    // print("Error: ")
                }
            }
        }
        
        return true
    }

    // MARK: - Core Data stack

    lazy var persistentContainer: NSPersistentContainer = {
        /*
         The persistent container for the application. This implementation
         creates and returns a container, having loaded the store for the
         application to it. This property is optional since there are legitimate
         error conditions that could cause the creation of the store to fail.
        */
        let container = NSPersistentContainer(name: "StudyTrace")
        container.loadPersistentStores(completionHandler: { (storeDescription, error) in
            if let error = error as NSError? {
                // Replace this implementation with code to handle the error appropriately.
                // fatalError() causes the application to generate a crash log and terminate. You should not use this function in a shipping application, although it may be useful during development.
                 
                /*
                 Typical reasons for an error here include:
                 * The parent directory does not exist, cannot be created, or disallows writing.
                 * The persistent store is not accessible, due to permissions or data protection when the device is locked.
                 * The device is out of space.
                 * The store could not be migrated to the current model version.
                 Check the error message to determine what the actual problem was.
                 */
                fatalError("Unresolved error \(error), \(error.userInfo)")
            }
        })
        return container
    }()

    // MARK: - Core Data Saving support

    func saveContext () {
        let context = persistentContainer.viewContext
        if context.hasChanges {
            do {
                try context.save()
            } catch {
                // Replace this implementation with code to handle the error appropriately.
                // fatalError() causes the application to generate a crash log and terminate. You should not use this function in a shipping application, although it may be useful during development.
                let nserror = error as NSError
                fatalError("Unresolved error \(nserror), \(nserror.userInfo)")
            }
        }
    }

}

private enum AppStoreCaptureDriver {
    private static var hasRun = false

    static func runIfNeeded(window: UIWindow?) {
        guard AppStoreDemo.isEnabled, !hasRun else { return }
        hasRun = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            guard let tabBar = window?.rootViewController as? UITabBarController else { return }
            if let scene = AppStoreDemo.captureScene {
                show(scene: scene, in: tabBar)
            }
            if let preview = AppStoreDemo.previewFlow {
                run(preview: preview, in: tabBar)
            }
        }
    }

    private static func selectTab(_ title: String, in tabBar: UITabBarController) {
        guard let index = tabBar.viewControllers?.firstIndex(where: {
            $0.tabBarItem.title?.localizedCaseInsensitiveCompare(title) == .orderedSame
        }) else { return }
        tabBar.selectedIndex = index
    }

    private static func topController(in tabBar: UITabBarController) -> UIViewController? {
        if let nav = tabBar.selectedViewController as? UINavigationController {
            return nav.topViewController
        }
        return tabBar.selectedViewController
    }

    private static func selectStudyTab(in tabBar: UITabBarController) {
        if let controllers = tabBar.viewControllers, !controllers.isEmpty {
            tabBar.selectedIndex = controllers.count - 1
        }
    }

    private static func show(scene: String, in tabBar: UITabBarController) {
        switch scene {
        case "study":
            selectStudyTab(in: tabBar)
        case "dashboard":
            selectTab("Dashboard", in: tabBar)
        case "surveys":
            selectTab("Surveys", in: tabBar)
        case "battery", "screen-time":
            selectTab("Surveys", in: tabBar)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) {
                guard let controller = topController(in: tabBar) as? ESMViewController else { return }
                controller.presentDemoInstructions(for: scene == "battery" ? .battery : .screenTimeActivity)
            }
        case "privacy":
            selectStudyTab(in: tabBar)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                guard let controller = topController(in: tabBar) as? ViewController else { return }
                controller.performSegue(withIdentifier: "toAdvancedSettings", sender: controller)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                    guard let settings = topController(in: tabBar) as? AdvancedSettingsViewController else { return }
                    settings.presentDemoPrivacyInfo()
                }
            }
        default:
            break
        }
    }

    private static func run(preview: String, in tabBar: UITabBarController) {
        switch preview {
        case "onboarding":
            let steps: [TimeInterval] = [3, 9, 15]
            for delay in steps {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                    (tabBar.presentedViewController as? OnboardingPageViewController)?.advanceForAppPreview()
                }
            }
        case "dashboard":
            selectTab("Surveys", in: tabBar)
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                selectTab("Dashboard", in: tabBar)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 12) {
                guard let dashboard = topController(in: tabBar) as? ContextCardViewController,
                      let scrollView = dashboard.view.subviews.compactMap({ $0 as? UIScrollView }).first else { return }
                scrollView.setContentOffset(CGPoint(x: 0, y: min(260, max(0, scrollView.contentSize.height - scrollView.bounds.height))), animated: true)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 17) {
                selectStudyTab(in: tabBar)
            }
        case "surveys":
            selectTab("Surveys", in: tabBar)
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                (topController(in: tabBar) as? ESMViewController)?.presentDemoInstructions(for: .battery)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 12) {
                tabBar.presentedViewController?.dismiss(animated: true)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 14) {
                (topController(in: tabBar) as? ESMViewController)?.presentDemoInstructions(for: .screenTimeActivity)
            }
        default:
            break
        }
    }
}

/// Older builds shipped Screen Time extensions that stored app selections,
/// resolved app names, and pending usage events in the shared app group.
/// Those extensions are gone; remove what they left on existing installs.
enum LegacyScreenTimeCleanup {
    private static let appGroupID = "group.com.liuchao.studytrace"
    private static let purgedKey = "com.studytrace.legacy-screen-time-purged"

    static func purgeIfNeeded() {
        guard !UserDefaults.standard.bool(forKey: purgedKey) else { return }
        UserDefaults(suiteName: appGroupID)?.removePersistentDomain(forName: appGroupID)
        UserDefaults.standard.set(true, forKey: purgedKey)
    }
}

enum StudyParticipationController {

    static let consentKey = "com.studytrace.user-consented"
    static let consentTimestampKey = "com.studytrace.consent-timestamp"

    static func hasConsent() -> Bool {
        UserDefaults.standard.bool(forKey: consentKey)
    }

    static func recordConsentGranted() {
        UserDefaults.standard.set(true, forKey: consentKey)
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: consentTimestampKey)
        StudyTraceTelemetry.recordEvent("consent_granted")
        StudyTraceTelemetry.uploadDeviceState(reason: "consent_granted")
    }

    /// Outcome of telling the study server about a withdrawal.
    enum WithdrawalServerResult {
        /// No study server was configured, so there was nothing to notify.
        case notApplicable
        /// The server recorded the withdrawal (and deleted data if asked).
        case recorded
        /// The server was unreachable. The request is queued and retried on
        /// the next launch/foreground; the device ID lets the participant ask
        /// the research team directly.
        case pending(deviceId: String)
    }

    private static let pendingWithdrawalKey = "com.studytrace.pending-withdrawal"

    /// Stops collection, cancels study notifications, and deletes the study
    /// data stored on this iPhone. When `notifyServer` is true (the
    /// participant quit from Settings), the study server logs the withdrawal
    /// and, if `deleteUploadedData` is true, deletes what this device uploaded.
    static func revokeParticipation(clearStudySettings: Bool,
                                    notifyServer: Bool = false,
                                    deleteUploadedData: Bool = false,
                                    completion: ((WithdrawalServerResult) -> Void)? = nil) {
        // Read the server context before settings are cleared below.
        let context = notifyServer ? StudyTraceTelemetry.studyContext() : nil
        UserDefaults.standard.set(false, forKey: consentKey)
        UserDefaults.standard.removeObject(forKey: consentTimestampKey)
        OnboardingManager.recordConsentDecision()

        let manager = AWARESensorManager.shared()
        manager.stopAutoSyncTimer()
        manager.stopAndRemoveAllSensors()
        AWARECore.shared().deactivate()

        cancelStudyNotifications()
        deleteLocalStudyDatabase()
        // Queued telemetry/screenshots are study data stored on this iPhone
        // too; the server's withdrawal log is the record of the withdrawal.
        StudyTraceUploadQueue.shared.purge()
        // Removes exported/CSV/JSON files; the AWARE.sqlite store itself is
        // skipped by the framework, so its rows are cleared above.
        manager.removeAllFilesFromDocumentRoot()
        if clearStudySettings {
            AWAREStudy.shared().clearSettings()
        }

        guard let context = context else {
            completion?(.notApplicable)
            return
        }
        let request: [String: Any] = [
            "base_url": context.baseURL.absoluteString,
            "study_id": context.studyId,
            "password": context.password,
            "device_id": context.deviceId,
            "delete_data": deleteUploadedData,
            "withdrawn_at": Date().timeIntervalSince1970 * 1000
        ]
        UserDefaults.standard.set(request, forKey: pendingWithdrawalKey)
        sendWithdrawal(request) { success in
            DispatchQueue.main.async {
                completion?(success ? .recorded : .pending(deviceId: context.deviceId))
            }
        }
    }

    /// Re-sends a withdrawal that could not reach the server earlier. Safe to
    /// repeat: the server only deletes rows received before `withdrawn_at`.
    static func retryPendingWithdrawal() {
        guard let request = UserDefaults.standard.dictionary(forKey: pendingWithdrawalKey) else { return }
        sendWithdrawal(request) { _ in }
    }

    private static func sendWithdrawal(_ request: [String: Any], completion: @escaping (Bool) -> Void) {
        guard let base = (request["base_url"] as? String).flatMap(URL.init(string:)),
              let studyId = request["study_id"] as? String,
              let password = request["password"] as? String,
              let deviceId = request["device_id"] as? String else {
            UserDefaults.standard.removeObject(forKey: pendingWithdrawalKey)
            completion(false)
            return
        }
        let payload: [String: Any] = [
            "device_id": deviceId,
            "delete_data": request["delete_data"] as? Bool ?? false,
            "withdrawn_at": request["withdrawn_at"] as? Double ?? Date().timeIntervalSince1970 * 1000
        ]
        var urlRequest = URLRequest(url: base
            .appendingPathComponent("api/v1/studies")
            .appendingPathComponent(studyId)
            .appendingPathComponent("withdrawal"))
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 30
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue("Bearer \(password)", forHTTPHeaderField: "Authorization")
        urlRequest.httpBody = try? JSONSerialization.data(withJSONObject: payload, options: [])
        URLSession.shared.dataTask(with: urlRequest) { _, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let success = error == nil && (200..<300).contains(status)
            if success {
                UserDefaults.standard.removeObject(forKey: pendingWithdrawalKey)
            }
            completion(success)
        }.resume()
    }

    /// Removes scheduled survey prompts and reminders so a withdrawn
    /// participant is not notified again.
    private static func cancelStudyNotifications() {
        let center = UNUserNotificationCenter.current()
        center.removeAllPendingNotificationRequests()
        center.removeAllDeliveredNotifications()
        UIApplication.shared.applicationIconBadgeNumber = 0
    }

    /// Deletes every row in the local AWARE Core Data store (sensor data not
    /// yet uploaded, ESM schedules, and survey answers).
    private static func deleteLocalStudyDatabase() {
        let handler = CoreDataHandler.shared()
        guard let coordinator = handler.persistentStoreCoordinator else { return }
        let context = NSManagedObjectContext(concurrencyType: .privateQueueConcurrencyType)
        context.persistentStoreCoordinator = coordinator
        context.performAndWait {
            for entity in coordinator.managedObjectModel.entities where entity.superentity == nil {
                guard let name = entity.name else { continue }
                let request = NSBatchDeleteRequest(fetchRequest: NSFetchRequest<NSFetchRequestResult>(entityName: name))
                do {
                    try context.execute(request)
                } catch {
                    NSLog("[StudyTrace] Could not delete local %@ rows: %@", name, error.localizedDescription)
                }
            }
        }
        // Batch deletes bypass contexts; drop any objects still cached.
        handler.managedObjectContext?.reset()
    }

    static func refreshCollectionState(fitbitPresenter: UIViewController?, createRemoteTables: Bool) {
        let manager = AWARESensorManager.shared()
        let study = AWAREStudy.shared()
        let core = AWARECore.shared()

        manager.stopAutoSyncTimer()
        manager.stopAndRemoveAllSensors()
        core.deactivate()

        guard hasConsent() else { return }

        AWARESlimConfiguration.apply()
        manager.addSensors(with: study)
        guard manager.getAllSensors().count > 0 else { return }

        core.setAnchor()
        if let fitbit = manager.getSensor(SENSOR_PLUGIN_FITBIT) as? Fitbit {
            fitbit.viewController = fitbitPresenter
        }
        manager.add(AWAREEventLogger.shared())
        core.activate()
        manager.startAllSensors()

        if createRemoteTables, let studyURL = study.getURL(), !studyURL.isEmpty {
            manager.createDBTablesOnAwareServer()
        }
    }
}

extension AppDelegate : UNUserNotificationCenterDelegate {
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                openSettingsFor notification: UNNotification?) {
        
    }
    
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        DispatchQueue.main.async {
            let tabBar = (self.window?.rootViewController as? UITabBarController)
                ?? self.window?.rootViewController?.tabBarController
            if let tabBar = tabBar, let surveysIndex = tabBar.surveysTabIndex {
                tabBar.selectedIndex = surveysIndex
            }
        }
        StudyTraceNotificationAudit.markReported(response.notification)
        StudyTraceTelemetry.recordEvent("notification_tapped",
                                        metadata: StudyTraceNotificationAudit.metadata(for: response.notification))
        completionHandler()
    }
    
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        StudyTraceNotificationAudit.markReported(notification)
        StudyTraceTelemetry.recordEvent("notification_presented",
                                        metadata: StudyTraceNotificationAudit.metadata(for: notification))
        if #available(iOS 14.0, *) {
            completionHandler([.banner, .list, .sound, .badge])
        } else {
            completionHandler([.alert, .sound, .badge])
        }
    }
    

    func application(_ application: UIApplication,
                     didReceiveRemoteNotification userInfo: [AnyHashable : Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        StudyTraceTelemetry.recordEvent("remote_notification_received")
        if let userInfo = userInfo as? [String:Any]{
            // SilentPushManager().executeOperations(userInfo)
            PushNotificationResponder().response(withPayload: userInfo)
        }
        
        if AWAREStudy.shared().isDebug(){ print("didReceiveRemoteNotification:start") }
        
        let dispatchTime = DispatchTime.now() + 20
        DispatchQueue.main.asyncAfter( deadline: dispatchTime ) {
            
            if AWAREStudy.shared().isDebug(){ print("didReceiveRemoteNotification:end") }
            
            completionHandler(.noData)
        }
    }

    
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        StudyTraceTelemetry.recordEvent("remote_notification_registered")
        let push = PushNotification(awareStudy: AWAREStudy.shared())
        push.saveDeviceToken(with: deviceToken)
        push.startSyncDB()
    }
    
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        StudyTraceTelemetry.recordEvent("remote_notification_registration_failed", metadata: [
            "error": error.localizedDescription
        ])
    }
}

enum StudyTraceTelemetry {
    private static let clientEventsSensor = "client_events"
    private static let deviceStateSensor = "device_state"
    private static let sequenceKey = "com.studytrace.telemetry.sequence"
    private static let lastEventAtKey = "com.studytrace.telemetry.last-event-at"
    private static let permissionSnapshotKey = "com.studytrace.telemetry.permission-snapshot"
    private static let permissionKeys = [
        "notification_authorization",
        "location_authorization",
        "location_accuracy_authorization",
        "background_refresh_status"
    ]
    private static let lock = NSLock()
    private static var cachedAppState = "unknown"

    /// UIApplication may only be read on the main thread, but telemetry is
    /// also recorded from background tasks and network callbacks. Lifecycle
    /// callbacks refresh this cached value on the main thread.
    static func updateCachedAppState() {
        guard Thread.isMainThread else { return }
        let state = UIApplication.shared.applicationState.studytraceTelemetryValue
        lock.lock()
        cachedAppState = state
        lock.unlock()
    }

    private static func currentAppState() -> String {
        updateCachedAppState()
        lock.lock()
        defer { lock.unlock() }
        return cachedAppState
    }

    /// Fields on every telemetry row: a unique event_id (server dedupe of
    /// retries), a per-device sequence number (so the server can count rows
    /// lost in transit), and the local time zone (local-day boundaries).
    private static func commonFields() -> [String: Any] {
        lock.lock()
        let seq = UserDefaults.standard.integer(forKey: sequenceKey) + 1
        UserDefaults.standard.set(seq, forKey: sequenceKey)
        lock.unlock()
        let zone = TimeZone.current
        return [
            "timestamp": Date().timeIntervalSince1970 * 1000,
            "event_id": UUID().uuidString,
            "seq": seq,
            "timezone": zone.identifier,
            "utc_offset_minutes": zone.secondsFromGMT() / 60,
            "app_version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
            "build_number": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
        ]
    }

    static func recordEvent(_ name: String, metadata: [String: Any] = [:]) {
        guard StudyParticipationController.hasConsent() else { return }
        var row = commonFields()
        row["event_name"] = name
        row["app_state"] = currentAppState()
        if !metadata.isEmpty {
            row["metadata"] = sanitize(metadata)
        }
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: lastEventAtKey)
        StudyTraceUploadQueue.shared.addTelemetry(sensor: clientEventsSensor, row: row)
    }

    /// Epoch seconds of the most recent telemetry event (from any run).
    static func lastEventAt() -> TimeInterval? {
        let value = UserDefaults.standard.double(forKey: lastEventAtKey)
        return value > 0 ? value : nil
    }

    /// Sends buffered telemetry now instead of waiting for a full batch.
    static func flush() {
        StudyTraceUploadQueue.shared.flushTelemetry()
    }

    static func uploadDeviceState(reason: String) {
        guard StudyParticipationController.hasConsent() else { return }
        guard Thread.isMainThread else {
            DispatchQueue.main.async { uploadDeviceState(reason: reason) }
            return
        }
        // Read UIKit/CoreLocation state here on the main thread; the
        // notification-settings callback below runs on a background queue.
        UIDevice.current.isBatteryMonitoringEnabled = true
        let locationManager = CLLocationManager()
        var row = commonFields()
        row["reason"] = reason
        row["battery_level"] = UIDevice.current.batteryLevel >= 0 ? Double(UIDevice.current.batteryLevel) as Any : NSNull()
        row["battery_state"] = UIDevice.current.batteryState.studytraceTelemetryValue
        row["low_power_mode_enabled"] = ProcessInfo.processInfo.isLowPowerModeEnabled
        row["system_name"] = UIDevice.current.systemName
        row["system_version"] = UIDevice.current.systemVersion
        row["device_model"] = UIDevice.current.model
        row["app_state"] = currentAppState()
        row["location_authorization"] = locationManager.authorizationStatus.studytraceTelemetryValue
        row["location_accuracy_authorization"] = locationManager.accuracyAuthorization.studytraceTelemetryValue
        row["background_refresh_status"] = UIApplication.shared.backgroundRefreshStatus.studytraceTelemetryValue
        if let freeDisk = freeDiskMegabytes() {
            row["free_disk_mb"] = freeDisk
        }
        let baseRow = row
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            var row = baseRow
            row["notification_authorization"] = settings.authorizationStatus.studytraceTelemetryValue
            row["notification_alert"] = settings.alertSetting.studytraceTelemetryValue
            row["notification_sound"] = settings.soundSetting.studytraceTelemetryValue
            row["notification_badge"] = settings.badgeSetting.studytraceTelemetryValue
            recordPermissionChanges(row)
            StudyTraceUploadQueue.shared.addTelemetry(sensor: deviceStateSensor, row: row)
        }
    }

    /// Emits a permission_changed event for each permission that differs
    /// from the last device-state snapshot (e.g. Always → While Using).
    private static func recordPermissionChanges(_ row: [String: Any]) {
        var current: [String: String] = [:]
        for key in permissionKeys {
            if let value = row[key] as? String { current[key] = value }
        }
        lock.lock()
        let previous = UserDefaults.standard.dictionary(forKey: permissionSnapshotKey) as? [String: String]
        UserDefaults.standard.set(current, forKey: permissionSnapshotKey)
        lock.unlock()
        guard let previous = previous else { return }
        for key in permissionKeys {
            guard let old = previous[key], let updated = current[key], old != updated else { continue }
            recordEvent("permission_changed", metadata: ["permission": key, "from": old, "to": updated])
        }
    }

    private static func freeDiskMegabytes() -> Int? {
        let home = URL(fileURLWithPath: NSHomeDirectory())
        guard let values = try? home.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
              let bytes = values.volumeAvailableCapacityForImportantUsage else {
            return nil
        }
        return Int(bytes / 1_048_576)
    }

    static func studyContext() -> (baseURL: URL, studyId: String, password: String, deviceId: String)? {
        guard let studyURL = AWAREStudy.shared().getURL(),
              let components = URLComponents(string: studyURL),
              components.scheme?.lowercased() == "https",
              let host = components.host,
              !host.isEmpty else {
            return nil
        }
        let parts = components.path.split(separator: "/").map(String.init)
        guard let indexPosition = parts.lastIndex(of: "index"),
              parts.count > indexPosition + 2 else {
            return nil
        }
        var base = URLComponents()
        base.scheme = components.scheme
        base.host = host
        base.port = components.port
        guard let baseURL = base.url else { return nil }
        return (
            baseURL: baseURL,
            studyId: parts[indexPosition + 1],
            password: parts[indexPosition + 2],
            deviceId: AWAREStudy.shared().getDeviceId()
        )
    }

    private static func sanitize(_ value: Any) -> Any {
        if let dict = value as? [String: Any] {
            return dict.mapValues { sanitize($0) }
        }
        if let array = value as? [Any] {
            return array.map { sanitize($0) }
        }
        if value is String || value is NSNumber || value is NSNull {
            return value
        }
        return String(describing: value)
    }
}

private extension UIApplication.State {
    var studytraceTelemetryValue: String {
        switch self {
        case .active: return "active"
        case .inactive: return "inactive"
        case .background: return "background"
        @unknown default: return "unknown"
        }
    }
}

private extension UIDevice.BatteryState {
    var studytraceTelemetryValue: String {
        switch self {
        case .unknown: return "unknown"
        case .unplugged: return "unplugged"
        case .charging: return "charging"
        case .full: return "full"
        @unknown default: return "unknown"
        }
    }
}

private extension UNAuthorizationStatus {
    var studytraceTelemetryValue: String {
        switch self {
        case .notDetermined: return "not_determined"
        case .denied: return "denied"
        case .authorized: return "authorized"
        case .provisional: return "provisional"
        case .ephemeral: return "ephemeral"
        @unknown default: return "unknown"
        }
    }
}

private extension UNNotificationSetting {
    var studytraceTelemetryValue: String {
        switch self {
        case .notSupported: return "not_supported"
        case .disabled: return "disabled"
        case .enabled: return "enabled"
        @unknown default: return "unknown"
        }
    }
}

private extension CLAccuracyAuthorization {
    var studytraceTelemetryValue: String {
        switch self {
        case .fullAccuracy: return "full"
        case .reducedAccuracy: return "reduced"
        @unknown default: return "unknown"
        }
    }
}

private extension UIBackgroundRefreshStatus {
    var studytraceTelemetryValue: String {
        switch self {
        case .available: return "available"
        case .denied: return "denied"
        case .restricted: return "restricted"
        @unknown default: return "unknown"
        }
    }
}

private extension CLAuthorizationStatus {
    var studytraceTelemetryValue: String {
        switch self {
        case .notDetermined: return "not_determined"
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .authorizedAlways: return "authorized_always"
        case .authorizedWhenInUse: return "authorized_when_in_use"
        @unknown default: return "unknown"
        }
    }
}

enum AWARESlimConfiguration {
    static let specificAppUsageIdentifier = "studytrace_specific_app_usage"

    static let supportedSensorIdentifiers: Set<String> = [
        SENSOR_LOCATIONS,
        SENSOR_PLUGIN_IOS_ESM,
        SENSOR_IOS_ESM,
        SENSOR_PLUGIN_DEVICE_USAGE,
        specificAppUsageIdentifier
    ]

    private static let enabledStatusKeys = [
        AWARE_PREFERENCES_STATUS_LOCATION_GPS,
        AWARE_PREFERENCES_STATUS_PLUGIN_IOS_ESM,
        AWARE_PREFERENCES_STATUS_DEVICE_USAGE
    ]

    private static let disabledStatusKeys = [
        AWARE_PREFERENCES_STATUS_ACCELEROMETER,
        AWARE_PREFERENCES_STATUS_GYROSCOPE,
        AWARE_PREFERENCES_STATUS_MAGNETOMETER,
        AWARE_PREFERENCES_STATUS_ROTATION,
        AWARE_PREFERENCES_STATUS_LINEAR_ACCELEROMETER,
        AWARE_PREFERENCES_STATUS_BAROMETER,
        AWARE_PREFERENCES_STATUS_BATTERY,
        AWARE_PREFERENCES_STATUS_NETWORK_EVENTS,
        AWARE_PREFERENCES_STATUS_CALLS,
        AWARE_PREFERENCES_STATUS_PROCESSOR,
        AWARE_PREFERENCES_STATUS_TIMEZONE,
        AWARE_PREFERENCES_STATUS_WIFI,
        AWARE_PREFERENCES_STATUS_SCREEN,
        AWARE_PREFERENCES_STATUS_FITBIT,
        STATUS_SENSOR_PLUGIN_GOOGLE_LOGIN,
        AWARE_PREFERENCES_STATUS_NTPTIME,
        AWARE_PREFERENCES_STATUS_OPENWEATHER,
        AWARE_PREFERENCES_STATUS_GOOGLE_FUSED_LOCATION,
        STATUS_SENSOR_HEALTH_KIT,
        AWARE_PREFERENCES_STATUS_SIGNIFICANT_MOTION,
        AWARE_PREFERENCES_STATUS_PUSH_NOTIFICATION,
        "status_plugin_calendar"
    ]

    static func apply() {
        let study = AWAREStudy.shared()

        for key in disabledStatusKeys {
            study.setSetting(key, value: false as NSObject)
        }

        for key in enabledStatusKeys {
            study.setSetting(key, value: true as NSObject)
        }

        study.setSetting(AWARE_PREFERENCES_FREQUENCY_GPS, value: "180" as NSObject)
        study.setSetting(AWARE_PREFERENCES_MIN_GPS_ACCURACY, value: "300" as NSObject)
    }

    static func isSupportedSensor(_ identifier: String) -> Bool {
        return supportedSensorIdentifiers.contains(identifier)
    }
}

extension UITabBarController {
    /// Index of the tab hosting the survey list, looked up by view controller
    /// type so it stays correct if the storyboard tab order changes.
    var surveysTabIndex: Int? {
        return viewControllers?.firstIndex { tab in
            if tab is ESMViewController { return true }
            return (tab as? UINavigationController)?.viewControllers.first is ESMViewController
        }
    }
}
