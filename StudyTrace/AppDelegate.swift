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

        let core    = AWARECore.shared()
        let manager = AWARESensorManager.shared()
        let study   = AWAREStudy.shared()

        AWARESlimConfiguration.apply()
        manager.addSensors(with: study)
        if manager.getAllSensors().count > 0 {
            core.setAnchor()
            if let fitbit = manager.getSensor(SENSOR_PLUGIN_FITBIT) as? Fitbit {
                fitbit.viewController = window?.rootViewController
            }
            core.activate()
            manager.add(AWAREEventLogger.shared())

            core.requestPermissionForPushNotification { (status, error) in

            }
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
        let request = BGProcessingTaskRequest(identifier: Self.bgSyncTaskIdentifier)
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = false
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    func scheduleBackgroundRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: Self.bgRefreshTaskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 30 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    private func handleBackgroundSync(task: BGProcessingTask) {
        scheduleBackgroundSync()

        let manager = AWARESensorManager.shared()
        manager.syncAllSensorsForcefully()

        task.expirationHandler = {
            task.setTaskCompleted(success: false)
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 25) {
            task.setTaskCompleted(success: true)
        }
    }

    private func handleBackgroundRefresh(task: BGAppRefreshTask) {
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
        scheduleBackgroundSync()
        scheduleBackgroundRefresh()
        AWAREEventLogger.shared().logEvent(["class":"AppDelegate",
                                            "event":"applicationDidEnterBackground:"]);
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        AWAREEventLogger.shared().logEvent(["class":"AppDelegate",
                                            "event":"applicationWillEnterForeground:"]);
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
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
                    core.requestPermissionForPushNotification { (notifState, error) in
                        core.requestPermissionForBackgroundSensing{ (locStatus) in
                            core.activate()
                            let manager = AWARESensorManager.shared()
                            manager.stopAndRemoveAllSensors()
                            AWARESlimConfiguration.apply()
                            manager.addSensors(with: study)
                            if let fitbit = manager.getSensor(SENSOR_PLUGIN_FITBIT) as? Fitbit {
                                fitbit.viewController = self.window?.rootViewController
                            }
                            manager.add(AWAREEventLogger.shared())
                            manager.startAllSensors()
                            manager.createDBTablesOnAwareServer()
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
        AWARE_PREFERENCES_STATUS_IOS_ACTIVITY_RECOGNITION,
        AWARE_PREFERENCES_STATUS_PEDOMETER,
        AWARE_PREFERENCES_STATUS_BAROMETER,
        AWARE_PREFERENCES_STATUS_BATTERY,
        AWARE_PREFERENCES_STATUS_NETWORK_EVENTS,
        AWARE_PREFERENCES_STATUS_CALLS,
        AWARE_PREFERENCES_STATUS_BLUETOOTH,
        AWARE_PREFERENCES_STATUS_PROCESSOR,
        AWARE_PREFERENCES_STATUS_TIMEZONE,
        AWARE_PREFERENCES_STATUS_WIFI,
        AWARE_PREFERENCES_STATUS_SCREEN,
        AWARE_PREFERENCES_STATUS_BLE_HR,
        AWARE_PREFERENCES_STATUS_CONTACTS,
        AWARE_PREFERENCES_STATUS_FITBIT,
        STATUS_SENSOR_PLUGIN_GOOGLE_LOGIN,
        AWARE_PREFERENCES_STATUS_NTPTIME,
        AWARE_PREFERENCES_STATUS_OPENWEATHER,
        AWARE_PREFERENCES_STATUS_GOOGLE_FUSED_LOCATION,
        STATUS_SENSOR_HEALTH_KIT,
        AWARE_PREFERENCES_STATUS_CALENDAR_ESM,
        AWARE_PREFERENCES_STATUS_SIGNIFICANT_MOTION,
        AWARE_PREFERENCES_STATUS_PUSH_NOTIFICATION,
        AWARE_PREFERENCES_STATUS_PLUGIN_HEADPHONE_MOTION,
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
