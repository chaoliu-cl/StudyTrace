//
//  AdvancedSettingsViewController.swift
//  aware-client-ios-v2
//
//  Created by Yuuki Nishiyama on 2019/03/04.
//  Copyright © 2019 Yuuki Nishiyama. All rights reserved.
//

import UIKit
import AWAREFramework
import CoreLocation

class AdvancedSettingsViewController: UIViewController {

    @IBOutlet weak var tableView: UITableView!

    var advancedSettings = Array<TableRowContent>()

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Settings"
        view.backgroundColor = AWARETheme.canvas
        advancedSettings = self.getAdvancedSettings()

        tableView.delegate = self
        tableView.dataSource = self
        tableView.backgroundColor = AWARETheme.canvas
        tableView.separatorInset = UIEdgeInsets(top: 0, left: 16, bottom: 0, right: 16)

        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "cell")
    }

    override func viewDidAppear(_ animated: Bool) {
        advancedSettings = self.getAdvancedSettings()
        self.tableView.reloadData()
        hideContextViewIfNeeded()
    }

}

enum AdvancedSettingsIdentifiers:String {
    case debugMode = "DEBUG_MODE"
    // case autoRefreshTime = "AUTO_REFRESH_TIME"
    case uploadInterval  = "UPLOAD_INTERVAL"
    case wifiOnly        = "WIFI_ONLY"
    case batteryChargingOnly = "BATTERY_CHARGING_ONLY"
    case dbCleanInterval = "DB_CLEAN_INTERVAL"
    case dbFetchCount    = "DB_FETCH_COUNT"
    case autoSync        = "AUTO_SYNC"
    case export          = "EXPORT"
    case version         = "VERSION"
    case quit            = "QUIT"
    case team            = "TEAM"
    case aboutStudyTrace = "ABOUT_STUDYTRACE"
    case uiMode          = "UI_MODE"
    case contextView     = "CONTEXT_VIEW"
    case complianceCheck = "COMPLIANCE_CHECK"
    case statusMonitor   = "STATUS_MONITOR"
    case onboarding      = "ONBOARDING"
    case storage         = "STORAGE"
    case pushNotification = "PUSH_NOTIFICATION"
    case anchorAccuracy   = "ANCHOR_ACCURACY"
    case privacy         = "PRIVACY"
}


extension AdvancedSettingsViewController: UITableViewDataSource {

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        return advancedSettings.count
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = UITableViewCell(style: .value1 , reuseIdentifier: "cell")

        let setting = advancedSettings[indexPath.row]
        cell.textLabel?.text = setting.title
        cell.textLabel?.font = UIFont.preferredFont(forTextStyle: .body)
        cell.detailTextLabel?.text = setting.details
        cell.detailTextLabel?.font = UIFont.preferredFont(forTextStyle: .subheadline)
        cell.detailTextLabel?.textColor = AWARETheme.secondaryInk
        cell.backgroundColor = AWARETheme.card
        cell.accessoryType = .disclosureIndicator
        cell.detailTextLabel?.isHidden = false

        return cell
    }

    func tableView(_ tableView: UITableView, heightForRowAt indexPath: IndexPath) -> CGFloat {
        return 56
    }
}

extension AdvancedSettingsViewController:UITableViewDelegate{
    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        
        let row = self.advancedSettings[indexPath.row]
        
        switch row.identifier {
        // debug mode
        case AdvancedSettingsIdentifiers.debugMode.rawValue:
            let alert = UIAlertController(title: row.title, message: "Turn On or Off the debug mode?", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "On", style: .default, handler: { (action) in
                AWAREStudy.shared().setDebug(true)
                self.refresh()
            }))
            alert.addAction(UIAlertAction(title: "Off", style: .default, handler: { (action) in
                AWAREStudy.shared().setDebug(false)
                self.refresh()
            }))
            alert.addAction(UIAlertAction(title: NSLocalizedString("Cancel", comment: ""), style: .cancel, handler: nil))
            self.present(alert, animated: true, completion: nil)
            break
        // auto sync
        case AdvancedSettingsIdentifiers.storage.rawValue:
            let alert = UIAlertController(title: "Which storage type do you prefer to use?", message: "The default setting is SQLite. NOTE: Some sensors do not support CSV and JSON-based Storage.", preferredStyle: .actionSheet)
            alert.addAction(UIAlertAction(title: "SQLite", style: .default, handler: { (action) in
                AWAREStudy.shared().setDBType(AwareDBTypeSQLite)
                self.refresh()
            }))
            alert.addAction(UIAlertAction(title: "JSON", style: .default, handler: { (action) in
                AWAREStudy.shared().setDBType(AwareDBTypeJSON)
                self.refresh()
            }))
            alert.addAction(UIAlertAction(title: "CSV", style: .default, handler: { (action) in
                AWAREStudy.shared().setDBType(AwareDBTypeCSV)
                self.refresh()
            }))
            alert.addAction(UIAlertAction(title: NSLocalizedString("Cancel", comment: ""), style: .cancel, handler: { (action) in
                
            }))
            alert.popoverPresentationController?.sourceView = tableView.cellForRow(at: indexPath)?.contentView
            alert.popoverPresentationController?.sourceRect = (tableView.cellForRow(at: indexPath)?.contentView.frame)!
            self.present(alert, animated: true, completion: nil)
        case AdvancedSettingsIdentifiers.autoSync.rawValue:
            let alert = UIAlertController(title: "Turn On or Off automatic data upload to a remote server?", message: "The current status is \(AWAREStudy.shared().isAutoDBSync() ? "On" :"Off" )", preferredStyle: .actionSheet)
            alert.addAction(UIAlertAction(title: "On", style: .default, handler: { (action) in
                AWAREStudy.shared().setAutoDBSync(true)
                StudyParticipationController.refreshCollectionState(
                    fitbitPresenter: self,
                    createRemoteTables: !(AWAREStudy.shared().getURL() ?? "").isEmpty
                )
                self.refresh()
            }))
            alert.addAction(UIAlertAction(title: "Off", style: .default, handler: { (action) in
                AWAREStudy.shared().setAutoDBSync(false)
                StudyParticipationController.refreshCollectionState(
                    fitbitPresenter: self,
                    createRemoteTables: !(AWAREStudy.shared().getURL() ?? "").isEmpty
                )
                self.refresh()
            }))
            alert.addAction(UIAlertAction(title: NSLocalizedString("Cancel", comment: ""), style: .cancel, handler: nil))
            alert.popoverPresentationController?.sourceView = tableView.cellForRow(at: indexPath)?.contentView
            alert.popoverPresentationController?.sourceRect = (tableView.cellForRow(at: indexPath)?.contentView.frame)!
            self.present(alert, animated: true, completion: nil)
            break
        // upload interval
        case AdvancedSettingsIdentifiers.uploadInterval.rawValue:
            let alert = UIAlertController(title: row.title, message: "Set an upload interval by minute.", preferredStyle: .alert)
            alert.addTextField(configurationHandler: { textField in
                textField.clearButtonMode = .whileEditing
                textField.text = row.details
                textField.keyboardType = UIKeyboardType.numberPad
            })
            alert.addAction(UIAlertAction(title: NSLocalizedString("Update", comment: ""), style: .default, handler: { (action) in
                if let textFields = alert.textFields {
                    if textFields.count > 0 {
                        if let textField = textFields.first {
                            if let text = textField.text{
                                let study = AWAREStudy.shared()
                                study.setAutoDBSyncIntervalWithMinutue( Int32(text) ?? 60 )
                                self.refresh()
                            }
                        }
                    }
                }
            }))
            alert.addAction(UIAlertAction(title: NSLocalizedString("Cancel", comment: ""), style: .cancel, handler: nil))
            self.present(alert, animated: true, completion: nil)
            break
        // wifi only
        case AdvancedSettingsIdentifiers.wifiOnly.rawValue:
            let alert = UIAlertController(title: "Turn On or Off WiFi only mode?", message: "If the mode is On, data upload processes are executed only when this phone has a WiFi connection.", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "On", style: .default, handler: { (action) in
                AWAREStudy.shared().setAutoDBSyncOnlyWifi(true)
                self.refresh()
            }))
            alert.addAction(UIAlertAction(title: "Off", style: .default, handler: { (action) in
                AWAREStudy.shared().setAutoDBSyncOnlyWifi(false)
                self.refresh()
            }))
            alert.addAction(UIAlertAction(title: NSLocalizedString("Cancel", comment: ""), style: .cancel, handler: nil))
            self.present(alert, animated: true, completion: nil)
            break
        // battery only
        case AdvancedSettingsIdentifiers.batteryChargingOnly.rawValue:
            let alert = UIAlertController(title: "Turn On or Off Battery only mode?", message: "If the mode is On, data upload processes are executed only when this phone is charged the battery.", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "On", style: .default, handler: { (action) in
                AWAREStudy.shared().setAutoDBSyncOnlyBatterChargning(true)
                self.refresh()
            }))
            alert.addAction(UIAlertAction(title: "Off", style: .default, handler: { (action) in
                AWAREStudy.shared().setAutoDBSyncOnlyBatterChargning(false)
                self.refresh()
            }))
            alert.addAction(UIAlertAction(title: NSLocalizedString("Cancel", comment: ""), style: .cancel, handler: nil))
            self.present(alert, animated: true, completion: nil)
            break
        // fetch count
        case AdvancedSettingsIdentifiers.dbFetchCount.rawValue:
            let alert = UIAlertController(title: row.title, message: "Set the maximum number of fetch records one-time from the local database.", preferredStyle: .alert)
            alert.addTextField(configurationHandler: { textField in
                textField.clearButtonMode = .whileEditing
                textField.text = row.details
                textField.keyboardType = UIKeyboardType.numberPad
            })
            alert.addAction(UIAlertAction(title: NSLocalizedString("Update", comment: ""), style: .default, handler: { (action) in
                if let textFields = alert.textFields {
                    if textFields.count > 0 {
                        if let textField = textFields.first {
                            if let text = textField.text{
                                let study = AWAREStudy.shared()
                                study.setMaximumNumberOfRecordsForDBSync( Int(text) ?? 1000 )
                                self.refresh()
                            }
                        }
                    }
                }
            }))
            alert.addAction(UIAlertAction(title: NSLocalizedString("Cancel", comment: ""), style: .cancel, handler: nil))
            self.present(alert, animated: true, completion: nil)
        // db clean
        case AdvancedSettingsIdentifiers.dbCleanInterval.rawValue:
            let alert = UIAlertController(title: row.title, message: nil, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Always", style: .default, handler: { (action) in
                AWAREStudy.shared().setCleanOldDataType(cleanOldDataTypeAlways)
                self.refresh()
            }))
            alert.addAction(UIAlertAction(title: "Daily", style: .default, handler: { (action) in
                AWAREStudy.shared().setCleanOldDataType(cleanOldDataTypeDaily)
                self.refresh()
            }))
            alert.addAction(UIAlertAction(title: "Weekly", style: .default, handler: { (action) in
                AWAREStudy.shared().setCleanOldDataType(cleanOldDataTypeWeekly)
                self.refresh()
            }))
            alert.addAction(UIAlertAction(title: "Monthly", style: .default, handler: { (action) in
                AWAREStudy.shared().setCleanOldDataType(cleanOldDataTypeMonthly)
                self.refresh()
            }))
            alert.addAction(UIAlertAction(title: "Never", style: .default, handler: { (action) in
                AWAREStudy.shared().setCleanOldDataType(cleanOldDataTypeNever)
                self.refresh()
            }))
            alert.addAction(UIAlertAction(title: NSLocalizedString("Cancel", comment: ""), style: .cancel, handler: nil))
            self.present(alert, animated: true, completion: nil)
        // quit
        case AdvancedSettingsIdentifiers.quit.rawValue:
            let alert = UIAlertController(title: row.title, message: "Are you sure to quit this study? If you quit this study, all of the study settings will be removed.", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Quit", style: .destructive, handler: { (action) in
                StudyParticipationController.revokeParticipation(clearStudySettings: true)
                self.refresh()
            }))
            alert.addAction(UIAlertAction(title: NSLocalizedString("Cancel", comment: ""), style: .cancel, handler: nil))
            self.present(alert, animated: true, completion: nil)
        case AdvancedSettingsIdentifiers.export.rawValue:
            var activityItems = Array<URL>();
            
            // Get the document directory url
            let documentsUrl =  FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!

            do {
                // Get the directory contents urls (including subfolders urls)
                let directoryContents = try FileManager.default.contentsOfDirectory(at: documentsUrl, includingPropertiesForKeys: nil)
                print(directoryContents)

                let alert = UIAlertController(title: "Export StudyTrace Data",
                                              message: "Choose a local database file to share or save.",
                                              preferredStyle: .alert)
                
                // if you want to filter the directory contents you can do like this:
                switch AWAREStudy.shared().getDBType() {
                case AwareDBTypeSQLite:
                    let dbFiles = directoryContents.filter{ $0.pathExtension == "sqlite" || $0.pathExtension == "sqlite-shm" || $0.pathExtension == "sqlite-wal"}
                    for url in dbFiles {
                        activityItems.append(url)
                    }
                break
                case AwareDBTypeJSON:
                    let dbFiles = directoryContents.filter{ $0.pathExtension == "json" || $0.pathExtension == "sqlite" || $0.pathExtension == "sqlite-shm" || $0.pathExtension == "sqlite-wal"}
                    for url in dbFiles {
                        activityItems.append(url)
                    }
                break
                case AwareDBTypeCSV:
                    let dbFiles = directoryContents.filter{ $0.pathExtension == "csv" || $0.pathExtension == "sqlite" || $0.pathExtension == "sqlite-shm" || $0.pathExtension == "sqlite-wal"}
                    for url in dbFiles {
                        activityItems.append(url)
                    }
                break
                default: break
                }
                
                for url in activityItems {
                    let action = UIAlertAction(title: url.lastPathComponent, style: .default, handler: { (action) in
                        
                        let activityVC = UIActivityViewController(activityItems: [url], applicationActivities: nil)
                        if UIDevice.current.userInterfaceIdiom == .pad {
                            activityVC.popoverPresentationController?.sourceView = tableView.cellForRow(at: indexPath)?.contentView
                            activityVC.popoverPresentationController?.permittedArrowDirections = UIPopoverArrowDirection.down
                        }
                        self.present(activityVC, animated: true, completion: nil)
                    
                    })
                    alert.addAction(action)
                }
                alert.addAction(UIAlertAction(title: NSLocalizedString("Cancel", comment: ""), style: .cancel, handler: nil))
                self.present(alert, animated: true, completion: nil)
            } catch {
                print(error)
            }
            break
        case AdvancedSettingsIdentifiers.version.rawValue:
            let studyURL = AWAREStudy.shared().getURL() ?? ""
            showInfoAlert(title: "StudyTrace Version",
                          message: """
                          App: StudyTrace
                          Version: \(getAppVersion()) (\(getAppBuildNumber()))
                          Bundle ID: \(Bundle.main.bundleIdentifier ?? "Unavailable")
                          Study URL: \(studyURL.isEmpty ? "Not configured" : studyURL)
                          """)
            break
        case AdvancedSettingsIdentifiers.uiMode.rawValue:
            let alert = UIAlertController(title: row.title, message: nil, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Normal", style: .default, handler: { (action) in
                AWAREStudy.shared().setUIMode(AwareUIModeNormal)
                self.refresh()
            }))
            alert.addAction(UIAlertAction(title: "Hide Sensors", style: .default, handler: { (action) in
                AWAREStudy.shared().setUIMode(AwareUIModeHideSensors)
                self.refresh()
            }))
            alert.addAction(UIAlertAction(title: "Hide Settings", style: .destructive, handler: { (action) in
                AWAREStudy.shared().setUIMode(AwareUIModeHideSettings)
                self.refresh()
            }))
            alert.addAction(UIAlertAction(title: "Hide All", style: .destructive , handler: { (action) in
                AWAREStudy.shared().setUIMode(AwareUIModeHideAll)
                self.refresh()
            }))
            alert.addAction(UIAlertAction(title: NSLocalizedString("Cancel", comment: ""), style: .cancel, handler: nil))
            self.present(alert, animated: true, completion: nil)
            break
        case AdvancedSettingsIdentifiers.contextView.rawValue:
            let alert = UIAlertController(title: "Hide Context View from TabBar?", message: "If you set Yes, the context view will be hidden.", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Yes", style: .default, handler: { (action) in
                super.setHideContextView(status: true)
                if UserDefaults.standard.synchronize(){
                    super.hideContextViewIfNeeded()
                }
                self.refresh()
            }))
            alert.addAction(UIAlertAction(title: "No", style: .default, handler: { (action) in
                super.setHideContextView(status: false)
                if UserDefaults.standard.synchronize() {
                    super.hideContextViewIfNeeded()
                }
                self.refresh()
            }))
            alert.addAction(UIAlertAction(title: NSLocalizedString("Cancel", comment: ""), style: .cancel, handler: nil))
            self.present(alert, animated: true, completion: nil)
            break
        case AdvancedSettingsIdentifiers.statusMonitor.rawValue:
            let alert = UIAlertController(title: "Monitor status of StudyTrace?", message: "If you set YES, the client records status every 1 minute.", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Yes", style: .default, handler: { (action) in
                AWAREStatusMonitor.shared().activate(withCheckInterval: 60)
                UserDefaults.standard.set(true, forKey: AdvancedSettingsIdentifiers.statusMonitor.rawValue)
                UserDefaults.standard.synchronize()
                self.refresh()
            }))
            alert.addAction(UIAlertAction(title: "No", style: .default, handler: { (action) in
                UserDefaults.standard.set(false, forKey: AdvancedSettingsIdentifiers.statusMonitor.rawValue)
                UserDefaults.standard.synchronize()
                AWAREStatusMonitor.shared().deactivate()
                self.refresh()
            }))
            alert.addAction(UIAlertAction(title: NSLocalizedString("Cancel", comment: ""), style: .cancel, handler: nil))
            self.present(alert, animated: true, completion: nil)
            break
        case AdvancedSettingsIdentifiers.complianceCheck.rawValue:
            showInfoAlert(title: "StudyTrace Readiness",
                          message: buildComplianceSummary())
        case AdvancedSettingsIdentifiers.onboarding.rawValue:
            OnboardingManager().startOnboarding(with: self)
        case AdvancedSettingsIdentifiers.pushNotification.rawValue:
            let alert = UIAlertController(title: "Do you upload your push notification taken to a server?",
                                          message: "You need to set up the server information on Push Notification sensor, and allow to receive the Push Notification on your phone.",
                                          preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Yes", style: .default, handler: { (action) in
                let push = PushNotification()
                if let token = push.getToken(), let server = push.getRemoteServerURL() {
                    push.uploadToken(token, toProvider: server, forcefully: true)
                }
            }))
            alert.addAction(UIAlertAction(title: NSLocalizedString("Cancel", comment: ""), style: .cancel, handler: nil))
            self.present(alert, animated: true, completion: nil)
            break
        case AdvancedSettingsIdentifiers.anchorAccuracy.rawValue:
            let alert = UIAlertController(title:"Anchor",
                                          message: "Please select an accuracy of a base location sensor (=anchor) for collecting data in the background." ,
                                          preferredStyle: .actionSheet)
            alert.addAction(UIAlertAction(title: "3km", style: .default, handler: { (action) in
                AWARECore.shared().setAnchorAccuracy(kCLLocationAccuracyThreeKilometers)
                self.refresh()
                AWARECore.shared().reactivate()
            }))
            alert.addAction(UIAlertAction(title: "1km", style: .default, handler: { (action) in
                AWARECore.shared().setAnchorAccuracy(kCLLocationAccuracyKilometer)
                self.refresh()
                AWARECore.shared().reactivate()
            }))
            alert.addAction(UIAlertAction(title: "100m", style: .default, handler: { (action) in
                AWARECore.shared().setAnchorAccuracy(kCLLocationAccuracyHundredMeters)
                self.refresh()
                AWARECore.shared().reactivate()
            }))
            alert.addAction(UIAlertAction(title: "10m", style: .default, handler: { (action) in
                AWARECore.shared().setAnchorAccuracy(kCLLocationAccuracyNearestTenMeters)
                self.refresh()
                AWARECore.shared().reactivate()
            }))
            alert.addAction(UIAlertAction(title: NSLocalizedString("Cancel", comment: ""), style: .cancel, handler: nil))
            alert.popoverPresentationController?.sourceView = tableView.cellForRow(at: indexPath)?.contentView
            alert.popoverPresentationController?.sourceRect = (tableView.cellForRow(at: indexPath)?.contentView.frame)!
            self.present(alert, animated: true, completion: nil)
            break
        case AdvancedSettingsIdentifiers.team.rawValue:
            showInfoAlert(title: "StudyTrace Team",
                          message: """
                          StudyTrace is configured by your research team.

                          For study-specific questions, consent updates, or withdrawal requests, please contact the coordinator who invited you to this study.
                          """)
        case AdvancedSettingsIdentifiers.aboutStudyTrace.rawValue:
            showInfoAlert(title: "About StudyTrace",
                          message: """
                          StudyTrace is a research data collection app for surveys, location, and optional device-use data.

                          Screen Time summaries are collected only when a study requests them, you approve Apple's Screen Time permission, and you select the specific apps, websites, or categories to include.

                          It stores data on-device and uploads only to the study server you configure in the app. StudyTrace does not use study data for advertising or cross-app tracking.
                          """)
            break
        case AdvancedSettingsIdentifiers.privacy.rawValue:
            showInfoAlert(title: "StudyTrace Privacy",
                          message: """
                          StudyTrace collects only the data streams enabled for your study after consent.

                          Data is stored locally on your device first and may then be uploaded to your configured study server.

                          Optional Screen Time summaries require separate iOS permission and participant selection of specific apps, websites, or categories.

                          You can review permissions in iOS Settings, quit a study, and export your local database from this screen at any time.
                          """)
            break
        default:
            break
        }
    }
    
    func refresh(){
        AWAREStudy.shared().refreshStudySettings()
        self.viewDidAppear(false)
    }
    
    func getFilePathOnDocument(with fileName:String) -> String {
        let path = NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true)[0]
        return path.appending(fileName)
    }
}

extension AdvancedSettingsViewController {
    
    func getAdvancedSettings() -> Array<TableRowContent>{
        let study = AWAREStudy.shared()
        let settings = [TableRowContent(type: .setting,
                                        title: "Debug Mode",
                                        details: study.isDebug() ? "On":"Off",
                                        identifier: AdvancedSettingsIdentifiers.debugMode.rawValue),
                        TableRowContent(type: .setting,
                                        title: "Storage",
                                        details: "\(convertStorageTypeToString(study.getDBType()))",
                                        identifier: AdvancedSettingsIdentifiers.storage.rawValue),
                        TableRowContent(type: .setting,
                                        title: "Auto Upload",
                                        details: "\(AWAREStudy.shared().isAutoDBSync() ? "On" :"Off" )",
                                        identifier: AdvancedSettingsIdentifiers.autoSync.rawValue),
                        TableRowContent(type: .setting,
                                        title: "Upload Interval",
                                        details: "\(study.getAutoDBSyncIntervalSecond()/60)",
                                        identifier: AdvancedSettingsIdentifiers.uploadInterval.rawValue),
                        TableRowContent(type: .setting,
                                        title: "DB Fetch Count",
                                        details: "\(study.getMaximumNumberOfRecordsForDBSync())",
                                        identifier: AdvancedSettingsIdentifiers.dbFetchCount.rawValue),
                        TableRowContent(type: .setting,
                                        title: "DB Clean Interval",
                                        details: getDBCleanModeAsString(),
                                        identifier: AdvancedSettingsIdentifiers.dbCleanInterval.rawValue),
                        TableRowContent(type: .setting,
                                        title: "Export DB",
                                        details: "",
                                        identifier: AdvancedSettingsIdentifiers.export.rawValue),
                        TableRowContent(type: .setting,
                                        title: "Start Onboarding",
                                        details: "",
                                        identifier: AdvancedSettingsIdentifiers.onboarding.rawValue),
                        TableRowContent(type: .setting,
                                        title: "Compliance Check",
                                        details: "",
                                        identifier: AdvancedSettingsIdentifiers.complianceCheck.rawValue),
                        TableRowContent(type: .setting,
                                        title: "Quit Study",
                                        identifier: AdvancedSettingsIdentifiers.quit.rawValue),
                        TableRowContent(type: .setting,
                                        title: "Version",
                                        details: "\(getAppVersion()) (\(getAppBuildNumber()))"),
                        TableRowContent(type: .setting,
                                        title: "About StudyTrace",
                                        identifier: AdvancedSettingsIdentifiers.aboutStudyTrace.rawValue),
                        TableRowContent(type: .setting,
                                        title: "Team",
                                        identifier: AdvancedSettingsIdentifiers.team.rawValue),
                        TableRowContent(type: .setting,
                                        title: "Privacy Policy",
                                        identifier: AdvancedSettingsIdentifiers.privacy.rawValue)
        ]
        return settings;
    }
    
    func convertStorageTypeToString(_ type:AwareDBType) -> String {
        switch type {
        case AwareDBTypeSQLite:
            return "SQLite"
        case AwareDBTypeJSON:
            return "JSON"
        case AwareDBTypeCSV:
            return "CSV"
        default:
            return "Unknown"
        }
    }
    
    func getDBCleanModeAsString() -> String {
        let study = AWAREStudy.shared()
        switch study.getCleanOldDataType(){
        case cleanOldDataTypeDaily:
            return "Daily"
        case cleanOldDataTypeNever:
            return "Never"
        case cleanOldDataTypeAlways:
            return "Always"
        case cleanOldDataTypeWeekly:
            return "Weekly"
        case cleanOldDataTypeMonthly:
            return "Monthly"
        default:
            break
        }
        return ""
    }
    
    func getUIModeAsString() -> String {
        let uiMode = AWAREStudy.shared().getUIMode()
        switch uiMode {
        case AwareUIModeNormal:
            return "Normal"
        case AwareUIModeHideSettings:
            return "Hide Settings"
        case AwareUIModeHideSensors:
            return "Hide Sensors"
        case AwareUIModeHideAll:
            return "Hide All"
        default:
            return "Unknown"
        }
    }
    
    func getDesiredAccuracy(_ accuracy: CLLocationAccuracy ) -> String {
        switch accuracy {
        case kCLLocationAccuracyThreeKilometers:
            return "3km"
        case kCLLocationAccuracyKilometer:
            return "1km"
        case kCLLocationAccuracyHundredMeters:
            return "100m"
        case kCLLocationAccuracyNearestTenMeters:
            return "10m"
        case kCLLocationAccuracyBest:
            return "Best"
        case kCLLocationAccuracyBestForNavigation:
            return "BestForNavigation"
        default:
            return "100m"
        }
    }
    
    func getAppVersion() -> String {
        return Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as! String
    }
    
    func getAppBuildNumber() -> String {
        return Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as! String
    }

    private func buildComplianceSummary() -> String {
        let locationManager = CLLocationManager()
        let locationStatus: String
        switch locationManager.authorizationStatus {
        case .authorizedAlways:
            locationStatus = "Always allowed"
        case .authorizedWhenInUse:
            locationStatus = "While using app"
        case .notDetermined:
            locationStatus = "Not requested"
        case .denied:
            locationStatus = "Denied"
        case .restricted:
            locationStatus = "Restricted"
        @unknown default:
            locationStatus = "Unknown"
        }

        let autoUpload = AWAREStudy.shared().isAutoDBSync() ? "On" : "Off"
        let studyURL = (AWAREStudy.shared().getURL() ?? "").isEmpty ? "Not configured" : "Configured"
        let pushState = UserDefaults.standard.bool(forKey: AdvancedSettingsIdentifiers.pushNotification.rawValue) ? "Configured" : "Not configured"

        return """
        Study URL: \(studyURL)
        Auto Upload: \(autoUpload)
        Location Permission: \(locationStatus)
        Push Token Upload: \(pushState)

        If any required item is missing, reopen onboarding or review iOS Settings for StudyTrace.
        """
    }

    private func showInfoAlert(title: String, message: String) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }
}

extension AdvancedSettingsIdentifiers {
    
    func getFiles() -> Array<URL>{
        
        let documentPath = NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true)[0]
        var activityItems = Array<URL>();
    
        var fileNames: [String] {
            do {
                return try FileManager.default.contentsOfDirectory(atPath: documentPath)
            } catch {
                return []
            }
        }
        for name in fileNames {
            activityItems.append(URL(fileURLWithPath: "\(documentPath)/\(name)" ))
        }
        return activityItems;
    }
}

extension UIViewController{
    func hideContextViewIfNeeded(){
        if isHideContextView() {
            if let items = self.tabBarController?.tabBar.items {
                items[1].isEnabled = false
                items[1].image = nil
                items[1].title = nil
            }
        }else{
            if let items = self.tabBarController?.tabBar.items {
                items[1].isEnabled = true
                items[1].image = UIImage(systemName: "chart.xyaxis.line")
                items[1].title = "Dashboard"
            }
        }
    }
    
    func isHideContextView() -> Bool{
        let status = AWAREStudy.shared().getSetting("client_ios_hide_context_view")
        if status == "1" {
            return true
        }else{
            return false
        }
    }
    
    func setHideContextView(status:Bool){
        let key = "client_ios_hide_context_view"
        if status{
            AWAREStudy.shared().setSetting(key, value: "1" as NSObject)
        }else{
            AWAREStudy.shared().setSetting(key, value: "0" as NSObject)
        }
        // print(AWAREStudy.shared().getSensorSettings())
    }
}
