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

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    static let bgSyncTaskIdentifier = "com.awareframework.client.sync"
    static let bgRefreshTaskIdentifier = "com.awareframework.client.refresh"

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let study = AWAREStudy.shared()
        StudyParticipationController.refreshCollectionState(
            fitbitPresenter: window?.rootViewController,
            createRemoteTables: false
        )
        if StudyParticipationController.hasConsent() {
            AWARECore.shared().requestPermissionForPushNotification { (_, _) in }
        }

        IOSESM.setESMAppearedState(false)

        // Pull in any Screen Time usage events recorded by the
        // DeviceActivityMonitor extension while the app was not running.
        SpecificAppUsageManager.shared.drainPendingUsage(syncImmediately: true)

        let key = "studytrace.setting.key.is-not-first-time"
        if(!UserDefaults.standard.bool(forKey:key)){
            study.setCleanOldDataType(cleanOldDataTypeNever)
            UserDefaults.standard.set(true, forKey: key)
        }

        UserDefaults.standard.set(false, forKey: AdvancedSettingsIdentifiers.statusMonitor.rawValue)

        UNUserNotificationCenter.current().delegate = self

        registerBackgroundTasks()

        AWAREEventLogger.shared().logEvent(["class":"AppDelegate",
                                            "event":"application:didFinishLaunchingWithOptions:launchOptions:"]);

        return true
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
        let request = BGProcessingTaskRequest(identifier: Self.bgSyncTaskIdentifier)
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = false
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    func scheduleBackgroundRefresh() {
        guard StudyParticipationController.hasConsent() else { return }
        let request = BGAppRefreshTaskRequest(identifier: Self.bgRefreshTaskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 30 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    private func handleBackgroundSync(task: BGProcessingTask) {
        guard StudyParticipationController.hasConsent() else {
            task.setTaskCompleted(success: true)
            return
        }
        scheduleBackgroundSync()

        let manager = AWARESensorManager.shared()
        SpecificAppUsageManager.shared.drainPendingUsage()
        manager.syncAllSensorsForcefully()

        task.expirationHandler = {
            task.setTaskCompleted(success: false)
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 25) {
            task.setTaskCompleted(success: true)
        }
    }

    private func handleBackgroundRefresh(task: BGAppRefreshTask) {
        refreshRemoteESMScheduleIfNeeded(force: false)
        scheduleBackgroundRefresh()
        task.setTaskCompleted(success: true)
    }

    func applicationWillResignActive(_ application: UIApplication) {
        AWAREEventLogger.shared().logEvent(["class":"AppDelegate",
                                            "event":"applicationWillResignActive:"]);
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        IOSESM.setESMAppearedState(false)
        UIApplication.shared.applicationIconBadgeNumber = 0
        if StudyParticipationController.hasConsent() {
            SpecificAppUsageManager.shared.drainPendingUsage(syncImmediately: true)
            scheduleBackgroundSync()
            scheduleBackgroundRefresh()
        }
        AWAREEventLogger.shared().logEvent(["class":"AppDelegate",
                                            "event":"applicationDidEnterBackground:"]);
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        SpecificAppUsageManager.shared.drainPendingUsage(syncImmediately: true)
        refreshRemoteESMScheduleIfNeeded(force: false)
        AWAREEventLogger.shared().logEvent(["class":"AppDelegate",
                                            "event":"applicationWillEnterForeground:"]);
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        SpecificAppUsageManager.shared.scheduleScreenTimeDrainAndSync()
        refreshRemoteESMScheduleIfNeeded(force: false)
        AWAREEventLogger.shared().logEvent(["class":"AppDelegate",
                                            "event":"applicationDidBecomeActive:"]);
    }

    func applicationWillTerminate(_ application: UIApplication) {
        AWAREUtils.sendLocalPushNotification(withTitle: NSLocalizedString("terminate_title" , comment: ""),
                                             body: NSLocalizedString("terminate_msg" , comment: ""),
                                             timeInterval: 1,
                                             repeats: false)
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
        _ = esm.startSensor(withURL: url)
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
                    let core = AWARECore.shared()
                    guard StudyParticipationController.hasConsent() else { return }
                    core.requestPermissionForPushNotification { (_, _) in
                        core.requestPermissionForBackgroundSensing { _ in
                            StudyParticipationController.refreshCollectionState(
                                fitbitPresenter: self.window?.rootViewController,
                                createRemoteTables: true
                            )
                        }
                    }
                }else {
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

enum StudyParticipationController {

    static let consentKey = "com.studytrace.user-consented"
    static let consentTimestampKey = "com.studytrace.consent-timestamp"

    static func hasConsent() -> Bool {
        UserDefaults.standard.bool(forKey: consentKey)
    }

    static func recordConsentGranted() {
        UserDefaults.standard.set(true, forKey: consentKey)
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: consentTimestampKey)
    }

    static func revokeParticipation(clearStudySettings: Bool) {
        UserDefaults.standard.set(false, forKey: consentKey)
        UserDefaults.standard.removeObject(forKey: consentTimestampKey)

        let manager = AWARESensorManager.shared()
        manager.stopAutoSyncTimer()
        manager.stopAndRemoveAllSensors()
        AWARECore.shared().deactivate()

        SpecificAppUsageManager.shared.resetMonitoringAndSelection()
        ScreenTimeUsageStore.shared.clear()

        manager.removeAllFilesFromDocumentRoot()
        if clearStudySettings {
            AWAREStudy.shared().clearSettings()
        }
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
        
    }
    
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        if let userInfo = notification.request.content.userInfo as? [String:Any]{
            print(userInfo)
        }
        completionHandler([.alert])
    }
    

    func application(_ application: UIApplication,
                     didReceiveRemoteNotification userInfo: [AnyHashable : Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
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
        let push = PushNotification(awareStudy: AWAREStudy.shared())
        push.saveDeviceToken(with: deviceToken)
        push.startSyncDB()
    }
    
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        
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
