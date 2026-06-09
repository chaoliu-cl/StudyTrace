//
//  ViewController.swift
//  StudyTrace
//
//  Created by Yuuki Nishiyama on 2019/02/27.
//  Copyright © 2019 Yuuki Nishiyama. All rights reserved.
//

import UIKit
import AWAREFramework
import Network

class ViewController: UIViewController {

    @IBOutlet weak var tableView: UITableView!

    let sensorManager = AWARESensorManager.shared()

    var refreshTimer:Timer?
    var refreshInterval: TimeInterval = 3.0

    var googleLoginRequestObserver:NSObjectProtocol?
    var contactUpdateRequestObserver:NSObjectProtocol?

    var selectedRowContent:TableRowContent?

    @IBOutlet weak var uploadButton: UIBarButtonItem!

    private let networkMonitor = NWPathMonitor()
    private var isConnected = true
    private let offlineBanner = UIView()
    private let lastSyncFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter
    }()

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "StudyTrace"
        tableView.delegate = self
        tableView.dataSource = self
        sortSensors()
        settings = getSettings()
        configureInterface()
        setupOfflineBanner()
        startNetworkMonitoring()

        let refreshControl = UIRefreshControl()
        refreshControl.tintColor = AWARETheme.accent
        refreshControl.addTarget(self, action: #selector(handlePullToRefresh(_:)), for: .valueChanged)
        tableView.refreshControl = refreshControl
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        refreshStudySection()
        updateUploadButtonState()
        hideContextViewIfNeeded()
    }

    private func setupOfflineBanner() {
        offlineBanner.backgroundColor = AWARETheme.warmAccent
        offlineBanner.translatesAutoresizingMaskIntoConstraints = false
        offlineBanner.isHidden = true

        let icon = UIImageView(image: UIImage(systemName: "wifi.slash"))
        icon.tintColor = .white
        icon.translatesAutoresizingMaskIntoConstraints = false

        let label = UILabel()
        label.text = "Offline — data will sync when connected"
        label.font = UIFont.preferredFont(forTextStyle: .caption1)
        label.textColor = .white
        label.translatesAutoresizingMaskIntoConstraints = false

        offlineBanner.addSubview(icon)
        offlineBanner.addSubview(label)
        view.addSubview(offlineBanner)

        NSLayoutConstraint.activate([
            offlineBanner.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            offlineBanner.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            offlineBanner.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            offlineBanner.heightAnchor.constraint(equalToConstant: 32),
            icon.leadingAnchor.constraint(equalTo: offlineBanner.leadingAnchor, constant: 12),
            icon.centerYAnchor.constraint(equalTo: offlineBanner.centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 16),
            label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 8),
            label.centerYAnchor.constraint(equalTo: offlineBanner.centerYAnchor)
        ])
    }

    private func startNetworkMonitoring() {
        networkMonitor.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async {
                let connected = path.status == .satisfied
                self?.isConnected = connected
                UIView.animate(withDuration: 0.3) {
                    self?.offlineBanner.isHidden = connected
                }
            }
        }
        networkMonitor.start(queue: DispatchQueue.global(qos: .utility))
    }
    
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)

        if StudyParticipationController.hasConsent() {
            AWARECore.shared().checkCompliance(with: self, showDetail: true)
        }
        refreshStudySection()
        startRefreshTimerIfNeeded()

        googleLoginRequestObserver = NotificationCenter.default.addObserver(forName: Notification.Name(ACTION_AWARE_GOOGLE_LOGIN_REQUEST),
                                               object: nil, queue: .main) { (notification) in
                                                self.login()
        }
        self.login()

        contactUpdateRequestObserver = NotificationCenter.default.addObserver(forName: Notification.Name(ACTION_AWARE_CONTACT_REQUEST),
                                               object: nil, queue: .main) { (notification) in

        }

        NotificationCenter.default.addObserver(self, selector: #selector(willEnterForegroundNotification(notification:)), name: UIApplication.willEnterForegroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(didEnterBackgroundNotification(notification:)), name: UIApplication.didEnterBackgroundNotification, object: nil)

        if StudyParticipationController.hasConsent() {
            self.checkESMSchedules()
            _ = LocationPermissionManager().isAuthorizedAlways(with: self)
        }
    }
    
    override func viewDidDisappear(_ animated: Bool) {
        refreshTimer?.invalidate()
        refreshTimer = nil
        NotificationCenter.default.removeObserver(googleLoginRequestObserver as Any)
        NotificationCenter.default.removeObserver(self, name: UIApplication.willEnterForegroundNotification, object: nil)
        NotificationCenter.default.removeObserver(self, name: UIApplication.didEnterBackgroundNotification, object: nil)
    }

    deinit {
        networkMonitor.cancel()
    }
    
    @objc func willEnterForegroundNotification(notification: NSNotification) {
        refreshStudySection()

        if StudyParticipationController.hasConsent() {
            self.checkESMSchedules()
            _ = LocationPermissionManager().isAuthorizedAlways(with: self)
        }
        startRefreshTimerIfNeeded()
    }

    @objc func handlePullToRefresh(_ sender: UIRefreshControl) {
        AWARETheme.mediumImpact()
        let study = AWAREStudy.shared()

        if let studyURL = study.getURL(), !studyURL.isEmpty {
            study.join(withURL: studyURL) { [weak self] (settings, status, error) in
                DispatchQueue.main.async {
                    StudyParticipationController.refreshCollectionState(
                        fitbitPresenter: self,
                        createRemoteTables: true
                    )
                    sender.endRefreshing()
                    AWARETheme.notificationFeedback(.success)
                    self?.refreshStudySection()
                }
            }
        } else {
            StudyParticipationController.refreshCollectionState(
                fitbitPresenter: self,
                createRemoteTables: false
            )
            sender.endRefreshing()
            refreshStudySection()
        }
    }
    
    @objc func didEnterBackgroundNotification(notification: NSNotification){
        refreshTimer?.invalidate()
        refreshTimer = nil
    }
    
    func checkESMSchedules(){
        let esmManager = ESMScheduleManager.shared()
        let schedules = esmManager.getValidSchedules()
        if(schedules.count > 0){
            if !IOSESM.hasESMAppearedInThisSession(){
                self.tabBarController?.selectedIndex = 0
            }
        }
    }
    
    func login(){
        let glogin = AWARESensorManager.shared().getSensor(SENSOR_PLUGIN_GOOGLE_LOGIN)
//        if let login = glogin as? GoogleLogin{
//            if login.isNeedLogin(){
//                let loginViewController = AWAREGoogleLoginViewController()
//                loginViewController.googleLogin = login
//                self.present(loginViewController, animated: true, completion: {
//                    
//                })
//            }
//        }
    }
    
    /// This method will be called when move to another UIViewController by segue.
    override func prepare(for segue: UIStoryboardSegue, sender: Any?) {
        
        if let next = segue.destination as? SensorSettingViewController,
           let content = self.selectedRowContent {
            next.selectedContent = content            
        }
    
    }

    
    @IBAction func didPushUploadButton(_ sender: UIBarButtonItem) {
        guard isConnected else {
            let alert = UIAlertController(title: "No Connection",
                                        message: "Data will sync automatically when you're back online.",
                                        preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default))
            self.present(alert, animated: true)
            return
        }

        let alert = UIAlertController(title: NSLocalizedString("setting_view_manual_upload_title", comment: ""),
                                    message: NSLocalizedString("setting_view_manual_upload_msg", comment: ""),
                                    preferredStyle: .alert)
        let execute = UIAlertAction(title: NSLocalizedString("Execute", comment: ""), style: .default) { (action) in
            AWARETheme.mediumImpact()
            self.startManualUpload()
        }
        let cancel = UIAlertAction(title: NSLocalizedString("Cancel", comment: ""), style: .cancel) { (action) in

        }
        alert.addAction(execute)
        alert.addAction(cancel)
        self.present(alert, animated: true, completion: nil)
    }
    
    @IBAction func didPushRefreshButton(_ sender: UIBarButtonItem) {
        let study = AWAREStudy.shared()
        if study.getURL() == "" {
            StudyParticipationController.refreshCollectionState(
                fitbitPresenter: self,
                createRemoteTables: false
            )
            let alert = UIAlertController(title: NSLocalizedString("setting_view_config_refresh_title", comment: ""),
                                          message: nil, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: NSLocalizedString("Cancel", comment: ""), style: .cancel, handler: { (action) in
                
            }))
            self.present(alert, animated:true , completion: nil)
        } else {
            if let studyURL = study.getURL() {
                study.join(withURL: studyURL) { (settings, status, error) in
                    DispatchQueue.main.async {
                        StudyParticipationController.refreshCollectionState(
                            fitbitPresenter: self,
                            createRemoteTables: true
                        )
                        self.showReloadCompletionAlert()
                    }
                }
            }
        }
        
        for sensor in self.sensors {
            sensor.syncProgress = 0
            sensor.syncStatus = .unknown
        }
        
    }

    let sections = ["Study", "Tracking"]
    
    var settings = Array<TableRowContent>()
    
    func getSettings() -> [TableRowContent] {
        let lastSyncText: String
        if let lastSync = UserDefaults.standard.object(forKey: "aware.lastSyncDate") as? Date {
            lastSyncText = "Last sync: " + lastSyncFormatter.localizedString(for: lastSync, relativeTo: Date())
        } else {
            lastSyncText = "Never synced"
        }

         return [TableRowContent(type: .setting,
                         title: "Study URL",
                         details: AWAREStudy.shared().getURL() ?? "",
                         identifier: TableRowIdentifier.studyId.rawValue),
         TableRowContent(type: .setting,
                         title: NSLocalizedString("device_id", comment: ""),
                         details: AWAREStudy.shared().getDeviceId(),
                         identifier: TableRowIdentifier.deviceId.rawValue),
         TableRowContent(type: .setting,
                         title: NSLocalizedString("device_name", comment: ""),
                         details: AWAREStudy.shared().getDeviceName(),
                         identifier: TableRowIdentifier.deviceName.rawValue),
         TableRowContent(type: .setting,
                         title: "Sync Status",
                         details: lastSyncText,
                         identifier: TableRowIdentifier.syncStatus.rawValue),
         TableRowContent(type: .setting,
                         title: NSLocalizedString("advanced_settings", comment: ""),
                         details: "",
                         identifier: TableRowIdentifier.advancedSettings.rawValue)]
    }
    
    lazy var sensors: [TableRowContent] = {
        let contents = [
            TableRowContent(type: .sensor,
                            title: NSLocalizedString("Location", comment: ""),
                            details: "Continuous GPS location sampling for mobility context.",
                            identifier: SENSOR_LOCATIONS,
                            icon: UIImage(systemName: "location.fill")),
            TableRowContent(type: .sensor,
                            title: NSLocalizedString("iOS ESM", comment: ""),
                            details: "Experience sampling prompts and answer logging.",
                            identifier: SENSOR_PLUGIN_IOS_ESM,
                            icon: UIImage(systemName: "list.clipboard.fill")),
            TableRowContent(type: .sensor,
                            title: "Specific App Usage",
                            details: SpecificAppUsageManager.shared.statusText,
                            identifier: AWARESlimConfiguration.specificAppUsageIdentifier,
                            icon: UIImage(systemName: "apps.iphone"))
        ]
        return contents
    }()

    private func sortSensors() {
        sensors.sort { lhs, rhs in
            if Language().isJapanese() {
                return lhs.identifier.localizedStandardCompare(rhs.identifier) == .orderedAscending
            } else {
                return lhs.title.localizedStandardCompare(rhs.title) == .orderedAscending
            }
        }
    }

    private func refreshStudySection() {
        settings = getSettings()

        guard isViewLoaded else { return }
        tableView.reloadData()
    }

    private func updateUploadButtonState() {
        let hasStudyURL = !(AWAREStudy.shared().getURL() ?? "").isEmpty
        uploadButton.tintColor = hasStudyURL ? AWARETheme.accent : AWARETheme.secondaryInk
        uploadButton.image = UIImage(systemName: "icloud.and.arrow.up")
        uploadButton.isEnabled = hasStudyURL
    }

    private func startRefreshTimerIfNeeded() {
        guard refreshTimer == nil else { return }

        refreshTimer = Timer.scheduledTimer(withTimeInterval: refreshInterval, repeats: true, block: { [weak self] _ in
            self?.reloadDynamicContent()
        })
    }

    private func reloadDynamicContent() {
        guard isViewLoaded else { return }

        let sectionCount = numberOfSections(in: tableView)
        guard sectionCount > 0 else { return }

        var sectionsToReload = IndexSet(integer: 0)
        if sectionCount > 1 {
            sectionsToReload.insert(1)
        }

        settings = getSettings()
        tableView.reloadSections(sectionsToReload, with: .none)
    }
}

extension ViewController: UITableViewDataSource {
    
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        if section == 0 {
            switch AWAREStudy.shared().getUIMode(){
            case AwareUIModeNormal:
                return self.settings.count
            case AwareUIModeHideSettings:
                return self.settings.count - 1
            case AwareUIModeHideAll:
                break
            case AwareUIModeHideSensors:
                return self.settings.count
            default:
                break
            }
        } else if section == 1 {
            switch AWAREStudy.shared().getUIMode(){
            case AwareUIModeNormal:
                return self.sensors.count
            case AwareUIModeHideSettings:
                break
            case AwareUIModeHideAll:
                break
            case AwareUIModeHideSensors:
                break
            default:
                break
            }
        }
        return 0
    }

    func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        return sections[section]
    }
    
    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: StudyTraceTableViewCell.cellName) as! StudyTraceTableViewCell

        if indexPath.section == 0 {
            let setting = settings[indexPath.row]
            cell.title.text  = setting.title
            cell.detail.text = setting.details
            cell.icon.isHidden = true
            cell.progress.isHidden = true
            cell.hideIcon()
            cell.hideSyncProgress()
            
        } else if indexPath.section == 1 {
            let sensor =  sensors[indexPath.row]
            cell.title.text  = sensor.title
            cell.showIcon()
            cell.showSyncProgress()
            cell.icon.image  = sensor.icon?.withRenderingMode(.alwaysTemplate)

            if sensor.identifier == AWARESlimConfiguration.specificAppUsageIdentifier {
                cell.icon.tintColor = AWARETheme.ink
                cell.detail.text = SpecificAppUsageManager.shared.statusText
                cell.hideSyncProgress()
            } else if (sensorManager.isExist(sensor.identifier)){
                cell.icon.tintColor = .systemBlue
                let latestData = sensorManager.getLatestSensorValue(sensor.identifier)
                if let data = latestData {
                    cell.detail.text = data
                }
                cell.progress.progress = sensor.syncProgress

            }else{
                cell.icon.tintColor = .dynamicColor(light: .black, dark: .white)
                cell.detail.text = sensor.details
                cell.hideSyncProgress()
            }
            
            cell.setSyncStatus(sensor.syncStatus)
        }
        
        return cell
    }
    
    func numberOfSections(in tableView: UITableView) -> Int {
        // return sections.count
        switch AWAREStudy.shared().getUIMode(){
        case AwareUIModeNormal:
            return sections.count
        case AwareUIModeHideSettings:
            return 1
        case AwareUIModeHideAll:
            return 0
        case AwareUIModeHideSensors:
            return 1
        default:
            return sections.count
        }
    }

}

extension ViewController: UITableViewDelegate {
    
    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        // print(indexPath.section, indexPath.row)
        if indexPath.section == 0 {
            let setting = settings[indexPath.row]
            switch setting.identifier {
            case TableRowIdentifier.studyId.rawValue:
                showAlertForSettingStudyId()
                break
            case TableRowIdentifier.deviceId.rawValue:
                        let deviceId = AWAREStudy.shared().getDeviceId()
                let activityVC = UIActivityViewController(activityItems: [deviceId], applicationActivities: nil)
                if UIDevice.current.userInterfaceIdiom == .pad {
                    activityVC.popoverPresentationController?.sourceView = tableView.cellForRow(at: indexPath)?.contentView
                    activityVC.popoverPresentationController?.permittedArrowDirections = UIPopoverArrowDirection.down
                }
                self.present(activityVC, animated: true, completion: nil)
                break
            case TableRowIdentifier.deviceName.rawValue:
                showAlertForSettingDeviceName()
                break
            case TableRowIdentifier.syncStatus.rawValue:
                break
            case TableRowIdentifier.advancedSettings.rawValue:
                // advancedSettingsView
                self.performSegue(withIdentifier: "toAdvancedSettings", sender: self)
                break
            default:
                break
            }
        } else if indexPath.section == 1 {
            self.selectedRowContent = sensors[indexPath.row]
            if selectedRowContent?.identifier == AWARESlimConfiguration.specificAppUsageIdentifier {
                SpecificAppUsageManager.shared.presentConfiguration(from: self) {
                    self.tableView.reloadData()
                }
            } else {
                self.performSegue(withIdentifier: "toSensorSetting", sender: self)
            }
        }
    }
    
    func tableView(_ tableView: UITableView, heightForRowAt indexPath: IndexPath) -> CGFloat {
        return 82
    }
    
    func tableView(_ tableView: UITableView, heightForHeaderInSection section: Int) -> CGFloat{
        return 34
    }
    
    
}

extension ViewController {
    func configureInterface() {
        view.backgroundColor = AWARETheme.canvas
        tableView.backgroundColor = AWARETheme.canvas
        tableView.separatorStyle = .none
        tableView.rowHeight = 76
        tableView.contentInset = UIEdgeInsets(top: 12, left: 0, bottom: 20, right: 0)
        navigationController?.navigationBar.prefersLargeTitles = true
        navigationController?.navigationBar.tintColor = AWARETheme.accent

        if let tabBar = tabBarController?.tabBar {
            tabBar.tintColor = AWARETheme.accent
            tabBar.unselectedItemTintColor = AWARETheme.secondaryInk
        }
    }

    func showReloadCompletionAlert(){
        let study = AWAREStudy.shared()
        let alert = UIAlertController(title: "Study configuration reloaded successfully.",
                                      message: study.getURL(),
                                      preferredStyle: .alert)
        let close = UIAlertAction(title: NSLocalizedString("Close", comment: ""),
                                   style: .default,
                                   handler: { (action) in
                                    for sensor in self.sensors {
                                        sensor.syncProgress = 0
                                        sensor.syncStatus = .unknown
                                    }
        })
        alert.addAction(close)
        self.present(alert, animated: true, completion: nil)
    }
    
    func startManualUpload(){
        let manager = AWARESensorManager.shared()
        
        let callback = { (sensorName:String?, syncState:AwareStorageSyncProgress, progress:Double, error:Error?) -> Void in
            
            DispatchQueue.main.async {
                var flag = false
                            
                for sensor in self.sensors {
                    let name = sensor.identifier
                    if name == sensorName! {
                        flag = true
                    } else if name == "location_gps" || name == "google_fused_location" {
                        if sensorName! == "locations" {
                            flag = true
                        }
                    } else if name == "health_kit" {
                        if sensorName! == "\(SENSOR_HEALTH_KIT)_heartrate"{
                            flag = true
                            print(sensorName!)
                        }
                    }
                    
                    if flag {
                        sensor.syncProgress = Float(progress)
                        if syncState == .complete {
                            sensor.syncStatus = .done
                        }else if syncState == .error {
                            sensor.syncStatus = .error
                        }else if (syncState == .locked || syncState == .unknown) {
                            sensor.syncStatus = .unknown
                        }else{
                            sensor.syncStatus = .syncing
                        }
                        
                        if let _ = error {
                            sensor.syncStatus = .error
                        }
                        if name == "location_gps" || name == "google_fused_location" {
                            flag = false
                            continue
                        } else if name == "\(SENSOR_HEALTH_KIT)_heartrate" {
                            flag = false
                            continue
                        }else{
                            break
                        }
                    }
                }
                
                // completion check
                var complete = true
                for sensor in self.sensors {
                    if manager.isExist(sensor.identifier){
                        // print(sensor.sensorName, sensor.syncProgress)
                        if sensor.syncProgress < 1 {
                            complete = false
                            break
                        }
                    }
                }
                
                if complete {
                    UserDefaults.standard.set(Date(), forKey: "aware.lastSyncDate")
                    AWARETheme.notificationFeedback(.success)
                    let alert = UIAlertController(title: NSLocalizedString("setting_view_upload_comp_title", comment: ""),
                                                  message: nil,
                                                  preferredStyle: .alert)
                    let close = UIAlertAction(title: NSLocalizedString("Close", comment: ""), style: .default, handler: { (action) in
                        for sensor in self.sensors {
                            sensor.syncProgress = 0
                            sensor.syncStatus = .unknown
                        }
                    })
                    alert.addAction(close)
                    self.present(alert, animated: true, completion: nil)
                }
            }
        }
        
        /// setcallback into each sensor storage
        for sensor in manager.getAllSensors(){
            if let storage = sensor.storage {
                storage.syncProcessCallback = callback
            }
        }
        // manager.setSyncProcessCallbackToAllSensorStorages()
        
        for sensor in self.sensors {
            sensor.syncProgress = 0
            sensor.syncStatus = .syncing
        }
        manager.syncAllSensorsForcefully()
    }
}

/// alerts
extension UIViewController {

    /// Normalizes a study URL to a secure https:// URL, accepting AWARE's
    /// custom schemes. "aware-ssl://" and "aware://" are AWARE conventions
    /// that are mapped to https://. A plain "https://" URL is accepted as-is.
    /// Returns nil for anything that cannot be made secure (e.g. http://),
    /// so insecure uploads are never permitted while AWARE servers remain
    /// fully supported.
    func normalizedSecureStudyURL(_ urlString: String) -> String? {
        let trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased() else {
            return nil
        }
        var normalized = trimmed
        switch scheme {
        case "https":
            break
        case "aware-ssl":
            if let range = normalized.range(of: "aware-ssl") {
                normalized = normalized.replacingCharacters(in: range, with: "https")
            }
        case "aware":
            if let range = normalized.range(of: "aware") {
                normalized = normalized.replacingCharacters(in: range, with: "https")
            }
        default:
            return nil
        }
        // Confirm the result is a well-formed https URL with a host.
        guard let secureURL = URL(string: normalized),
              secureURL.scheme?.lowercased() == "https",
              secureURL.host?.isEmpty == false else {
            return nil
        }
        return normalized
    }

    /// Returns true when the URL can be used as a secure study server,
    /// i.e. it is https:// or an AWARE scheme that maps to https://.
    func isSecureStudyURL(_ urlString: String) -> Bool {
        return normalizedSecureStudyURL(urlString) != nil
    }

    /// Presents a standard alert explaining that only HTTPS servers are allowed.
    func showInsecureURLAlert() {
        let alert = UIAlertController(
            title: NSLocalizedString("Insecure Server URL", comment: ""),
            message: NSLocalizedString("StudyTrace only connects to servers over HTTPS. Please enter a secure https:// URL.", comment: ""),
            preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default, handler: nil))
        self.present(alert, animated: true, completion: nil)
    }

    func showAlertForSettingStudyId(){
        let alert = UIAlertController(title:"Study URL", message:nil, preferredStyle: .alert)
        alert.addTextField(configurationHandler: { textField in
            textField.placeholder = "https://url.for.studytrace.server"
            textField.clearButtonMode = .whileEditing
            textField.text = AWAREStudy.shared().getURL()
        })
        alert.addAction(UIAlertAction(title: NSLocalizedString("Update", comment: "") , style: .default, handler: { (action) in
            if let textFields = alert.textFields {
                if textFields.count > 0 {
                    if let textField = textFields.first {
                        if let text = textField.text{
                            guard let secureURL = self.normalizedSecureStudyURL(text) else {
                                self.showInsecureURLAlert()
                                return
                            }
                            let study = AWAREStudy.shared()
                            study.setStudyURL(secureURL)
                            study.join(withURL: secureURL, completion: { (settings, study, error) in
                                DispatchQueue.main.async {
                                    StudyParticipationController.refreshCollectionState(
                                        fitbitPresenter: self,
                                        createRemoteTables: true
                                    )
                                }
                            })
                        }
                    }
                }
            }
        }))
        alert.addAction(UIAlertAction(title: NSLocalizedString("Cancel", comment: ""), style: .cancel, handler:nil))
        self.present(alert, animated: true, completion: {})
    }
    
    func showAlertForSettingDeviceName(){
        let alert = UIAlertController(title: NSLocalizedString("device_name", comment: ""),
                                      message:nil,
                                      preferredStyle: .alert)
        alert.addTextField(configurationHandler: { textField in
            textField.clearButtonMode = .whileEditing
            textField.text = AWAREStudy.shared().getDeviceName()
        })
        alert.addAction(UIAlertAction(title: NSLocalizedString("Update", comment: ""), style: .default, handler: { (action) in
            if let textFields = alert.textFields {
                if textFields.count > 0 {
                    if let textField = textFields.first {
                        if let text = textField.text{
                            let study = AWAREStudy.shared()
                            study.setDeviceName(text)
                            study.refreshStudySettings()
                        }
                    }
                }
            }
        }))
        alert.addAction(UIAlertAction(title: NSLocalizedString("Cancel", comment: ""), style: .cancel, handler:nil))
        self.present(alert, animated: true, completion: {})
    }
}

class TableRowContent {
    let identifier:String
    var height:CGFloat = 60
    let icon:UIImage?
    var title:String
    var details:String
    let type:TableRowType
    var syncProgress:Float = 0
    var syncStatus:SyncStatus = .unknown
    
    init(type:TableRowType,
         title:String="",
         details:String="",
         identifier:String="",
         icon:UIImage? = nil) {
        self.type = type
        self.title = title
        self.details = details
        self.identifier = identifier
        self.icon = icon
    }
}

enum TableRowType {
    case sensor
    case setting
}

enum TableRowIdentifier:String {
    case studyId          = "STUDY_URL"
    case deviceId         = "DEVICE_ID"
    case deviceName       = "DEVICE_NAME"
    case syncStatus       = "SYNC_STATUS"
    case advancedSettings = "ADVANCED_SETTINGS"
}

extension UIColor {
    public class func dynamicColor(light: UIColor, dark: UIColor) -> UIColor {
        return UIColor { traitCollection in
            traitCollection.userInterfaceStyle == .dark ? dark : light
        }
    }
}

public class Language {
    
    fileprivate func get() -> String {
        let languages = NSLocale.preferredLanguages
        if let type = languages.first {
            return type
        }
        return ""
    }
    
    func isJapanese() -> Bool {
        return self.get().contains("ja") ? true : false
    }
    
    func isEnglish() -> Bool {
        return self.get().contains("en") ? true : false
    }

}
