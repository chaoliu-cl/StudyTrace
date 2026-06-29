//
//  ContextCardViewController.swift
//  StudyTrace
//
//  Created by Yuuki Nishiyama on 2019/02/27.
//  Copyright © 2019 Yuuki Nishiyama. All rights reserved.
//

import UIKit
import AWAREFramework

class ContextCardViewController: UIViewController, UIImagePickerControllerDelegate, UINavigationControllerDelegate {

    @IBOutlet weak var refreshButton: UIBarButtonItem!
    @IBOutlet weak var deleteButton:  UIBarButtonItem!
    @IBOutlet weak var mainStackView: UIStackView!
    var contextCards = Array<ContextCard>()

    private let emptyStateStack = UIStackView()
    private var isUploadingBatteryScreenshot = false

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Dashboard"
        view.backgroundColor = AWARETheme.canvas
        mainStackView.spacing = 16
        mainStackView.layoutMargins = UIEdgeInsets(top: 18, left: 14, bottom: 24, right: 14)
        mainStackView.isLayoutMarginsRelativeArrangement = true
        navigationController?.navigationBar.prefersLargeTitles = true
        deleteButton.isEnabled = false
        setupEmptyState()
    }

    private func setupEmptyState() {
        emptyStateStack.axis = .vertical
        emptyStateStack.alignment = .center
        emptyStateStack.spacing = 12
        emptyStateStack.translatesAutoresizingMaskIntoConstraints = false

        let iconView = UIImageView(image: UIImage(systemName: "chart.bar.xaxis"))
        iconView.tintColor = AWARETheme.secondaryInk
        iconView.contentMode = .scaleAspectFit
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.heightAnchor.constraint(equalToConstant: 48).isActive = true
        iconView.widthAnchor.constraint(equalToConstant: 48).isActive = true

        let label = UILabel()
        label.text = "No data to display yet"
        label.font = UIFont.preferredFont(forTextStyle: .subheadline)
        label.textColor = AWARETheme.secondaryInk
        label.textAlignment = .center

        let sublabel = UILabel()
        sublabel.text = "Cards will appear as sensors collect data"
        sublabel.font = UIFont.preferredFont(forTextStyle: .caption1)
        sublabel.textColor = AWARETheme.secondaryInk.withAlphaComponent(0.7)
        sublabel.textAlignment = .center

        emptyStateStack.addArrangedSubview(iconView)
        emptyStateStack.addArrangedSubview(label)
        emptyStateStack.addArrangedSubview(sublabel)
        view.addSubview(emptyStateStack)
        NSLayoutConstraint.activate([
            emptyStateStack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            emptyStateStack.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        ])
        emptyStateStack.isHidden = true
    }
    
    override func viewDidAppear(_ animated: Bool) {
        NotificationCenter.default.addObserver(self,
                                               selector: #selector(willEnterForegroundNotification(notification:)),
                                               name: UIApplication.willEnterForegroundNotification,
                                               object: nil)
        if contextCards.count == 0 {
            setupContextCards()
        } else {
            refreshVisibleContextCards()
        }
        if StudyParticipationController.hasConsent() {
            _ = LocationPermissionManager().isAuthorizedAlways(with: self)
        }
    }
    
    override func viewDidDisappear(_ animated: Bool) {
        NotificationCenter.default.removeObserver(self,
                                                  name: UIApplication.willEnterForegroundNotification,
                                                  object: nil)
    }
    
    override func didReceiveMemoryWarning() {
        if AWAREUtils.isBackground() {
            self.removeAllContextCards()
        }
    }
    
    
    @objc func willEnterForegroundNotification(notification: NSNotification) {
        refreshVisibleContextCards()
        let esmManager = ESMScheduleManager.shared()
        let schedules = esmManager.getValidSchedules()
        if(schedules.count > 0){
            if !IOSESM.hasESMAppearedInThisSession(){
                self.tabBarController?.selectedIndex = 0
            }
        }
        if StudyParticipationController.hasConsent() {
            _ = LocationPermissionManager().isAuthorizedAlways(with: self)
        }
    }

    private func refreshVisibleContextCards() {
        for card in contextCards {
            if let deviceUsageCard = card as? DeviceUsageCard {
                deviceUsageCard.refresh()
            }
        }
    }
    
    func removeAllContextCards(){
        for card in contextCards {
            card.baseStackView.isHidden = true
            self.mainStackView.removeArrangedSubview(card)
        }
        contextCards.removeAll()
    }
    
    func setupContextCards(){
        self.removeAllContextCards()
        addESMCard()
        addLocationCard()
        addDeviceUsageCard()

        if contextCards.count == 0 {
            refreshButton.isEnabled = false
            deleteButton.isEnabled = false
            emptyStateStack.isHidden = false
        }else{
            refreshButton.isEnabled = true
            deleteButton.isEnabled = true
            emptyStateStack.isHidden = true
            animateCardsIn()
        }
    }

    private func animateCardsIn() {
        for (index, card) in contextCards.enumerated() {
            card.alpha = 0
            card.transform = CGAffineTransform(translationX: 0, y: 20)
            UIView.animate(withDuration: 0.4, delay: Double(index) * 0.1, usingSpringWithDamping: 0.8, initialSpringVelocity: 0, options: .curveEaseOut) {
                card.alpha = 1
                card.transform = .identity
            }
        }
    }
    
    var supportedContextCards = [SENSOR_PLUGIN_DEVICE_USAGE,
                                 SENSOR_IOS_ESM,
                                 "locations"]
    
    let key = "com.liuchao.studytrace.context-cards"
    
    func setContextCard(name:String){
        if var unwrappedCards = UserDefaults.standard.stringArray(forKey: key) {
            for c in unwrappedCards {
                if c == name {
                    return
                }
            }
            unwrappedCards.append(name)
            UserDefaults.standard.set(unwrappedCards, forKey: key)
            UserDefaults.standard.synchronize()
        }else{
            UserDefaults.standard.set([name], forKey: key)
            UserDefaults.standard.synchronize()
        }
    }
    
    func removeContextCard(name:String){
        if var unwrappedCards = UserDefaults.standard.stringArray(forKey: key) {
            unwrappedCards.removeAll { (string) -> Bool in
                if string == name {
                    return true
                }
                return false
            }
            UserDefaults.standard.set(unwrappedCards, forKey: key)
            UserDefaults.standard.synchronize()
        }
    }
    
    func getCurrentContextCardNames() -> [String] {
        if let unwrappedCards = UserDefaults.standard.stringArray(forKey: key) {
            return unwrappedCards
        }else{
            return Array<String>()
        }
    }
    
    @IBAction func didPushReloadButton(_ sender: UIBarButtonItem) {
        setupContextCards()
    }
    
    @IBAction func didPushAddButton(_ sender: UIBarButtonItem) {
        presentBatteryScreenshotUploader()
    }

    private func showBatteryScreenshotInstructions() {
        let alert = UIAlertController(
            title: "Battery usage screenshot",
            message: "When your study sends a Battery usage screenshot survey, open iPhone Settings > Battery > View All Battery Usage, take a screenshot, return to StudyTrace, and upload it as the photo answer.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
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
        let deviceId = AWAREStudy.shared().getDeviceId() ?? ""
        let screenshotBase64 = imageData.base64EncodedString()
        guard let request = batteryScreenshotUploadRequest(studyURL: studyURL,
                                                           deviceId: deviceId,
                                                           timestamp: timestamp,
                                                           screenshotBase64: screenshotBase64) else {
            isUploadingBatteryScreenshot = false
            showBatteryScreenshotUploadResult(title: "Study Not Configured",
                                              message: "StudyTrace could not find the study upload credentials. Please rejoin the study from the QR code, then upload the screenshot again.")
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
        let esmJson: [String: Any] = [
            "esm_type": 14,
            "esm_title": "Battery usage screenshot",
            "esm_instructions": "Open Settings > Battery > View All Battery Usage, then upload the screenshot.",
            "esm_trigger": "battery_usage_screenshot",
            "esm_submit": "Submit",
            "esm_na": true
        ]
        let payload: [String: Any] = [
            "device_id": deviceId,
            "timestamp": timestamp,
            "screenshot_base64": screenshotBase64,
            "esm_json": jsonString(esmJson)
        ]
        guard JSONSerialization.isValidJSONObject(payload),
              let body = try? JSONSerialization.data(withJSONObject: payload, options: []) else {
            return nil
        }

        var request = URLRequest(url: target.url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(target.password, forHTTPHeaderField: "x-study-password")
        request.httpBody = body
        return request
    }

    private func batteryScreenshotUploadTarget(from studyURL: String) -> (url: URL, password: String)? {
        guard let components = URLComponents(string: studyURL),
              components.scheme?.lowercased() == "https",
              components.host?.isEmpty == false else {
            return nil
        }

        let pathParts = components.path.split(separator: "/").map(String.init)
        var studyId: String?
        var password: String?
        if pathParts.count >= 5 {
            for index in 0...(pathParts.count - 5) {
                if pathParts[index] == "index.php",
                   pathParts[index + 1] == "webservice",
                   pathParts[index + 2] == "index" {
                    studyId = pathParts[index + 3]
                    password = pathParts[index + 4]
                    break
                }
            }
        }

        guard let studyId = studyId, !studyId.isEmpty,
              let password = password, !password.isEmpty else {
            return nil
        }

        var uploadComponents = URLComponents()
        uploadComponents.scheme = components.scheme
        uploadComponents.host = components.host
        uploadComponents.port = components.port
        uploadComponents.path = "/api/v1/studies/\(studyId)/battery-screenshots"
        guard let uploadURL = uploadComponents.url else { return nil }
        return (uploadURL, password)
    }

    private func jsonString(_ value: Any) -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: []),
              let string = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return string
    }

    private func showBatteryScreenshotUploadResult(title: String, message: String) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }
    
    @IBAction func didPushRemoveButton(_ sender: UIBarButtonItem) {
        let alert = UIAlertController(title: NSLocalizedString("context_card_remove_title", comment: ""),
                                      message: NSLocalizedString("context_card_remove_msg", comment: ""),
                                      preferredStyle: .alert)
        
        alert.addAction(UIAlertAction(title: NSLocalizedString("context_card_item_remove_all", comment: ""),
                                      style: .destructive, handler: { (action) in
            UserDefaults.standard.removeObject(forKey: self.key)
            UserDefaults.standard.synchronize()
            
            self.setupContextCards()
        }))
        
        for item in getCurrentContextCardNames() {
            alert.addAction(UIAlertAction(title: item, style: .default, handler: { (action) in
                self.removeContextCard(name: item)
                self.setupContextCards()
            }))
        }
        alert.addAction(UIAlertAction(title: NSLocalizedString("Cancel", comment: ""), style: .cancel, handler: { (action) in
            
        }))
        self.present(alert, animated: true, completion: nil)
    }
    
    
    func addAccelereomterCard(){
        if let sensor = AWARESensorManager.shared().getSensor(SENSOR_ACCELEROMETER) {
            let contextCard = ScatterChartCard(frame: CGRect(x:0, y:0, width: self.view.frame.width, height:300))
            contextCard.yAxisMax = 6
            contextCard.yAxisMin = -6
            contextCard.granularitySecond = 10
            contextCard.setTodaysChart(sensor: sensor, yKeys: ["double_values_0","double_values_1","double_values_2"])
            contextCard.titleLabel.text = NSLocalizedString("Accelerometer", comment: "")
            self.contextCards.append(contextCard)
            self.mainStackView.addArrangedSubview(contextCard)
        }
    }
    
    func addGyroscopeCard(){
        if let sensor = AWARESensorManager.shared().getSensor(SENSOR_GYROSCOPE) {
            let contextCard = ScatterChartCard(frame: CGRect(x:0, y:0, width: self.view.frame.width, height:300))
            contextCard.yAxisMax = 6;
            contextCard.yAxisMin = -6;
            contextCard.granularitySecond = 10
            contextCard.setTodaysChart(sensor: sensor, yKeys: ["double_values_0","double_values_1","double_values_2"])
            contextCard.titleLabel.text = NSLocalizedString("Gyroscope", comment: "")
            self.contextCards.append(contextCard)
            self.mainStackView.addArrangedSubview(contextCard)
        }
    }
    
    func addBatteryCard(){
        
        if let sensor = AWARESensorManager.shared().getSensor(SENSOR_BATTERY) {
            let contextCard = ScatterChartCard(frame: CGRect(x:0,y:0, width: self.view.frame.width, height:300))
            contextCard.yAxisMax = 105;
            contextCard.yAxisMin = 0;
            contextCard.setTodaysChart(sensor: sensor, yKeys: ["battery_level"])
            contextCard.titleLabel.text = NSLocalizedString("Battery", comment: "")
            self.contextCards.append(contextCard)
            self.mainStackView.addArrangedSubview(contextCard)
        }
    }
    
    func addBarometerCard(){
        if let sensor = AWARESensorManager.shared().getSensor(SENSOR_BAROMETER) {
            let contextCard = ScatterChartCard(frame: CGRect(x:0,y:0, width: self.view.frame.width, height:300))
            //contextCard.yAxisMax = 1300;
            //contextCard.yAxisMin = 800;
            contextCard.setTodaysChart(sensor: sensor, yKeys: ["double_values_0"])
            contextCard.titleLabel.text = NSLocalizedString("Barometer", comment: "")
            contextCard.granularitySecond = 60
            self.contextCards.append(contextCard)
            self.mainStackView.addArrangedSubview(contextCard)
        }
    }
    
    func addScreenEventCard(){
        if let sensor = AWARESensorManager.shared().getSensor(SENSOR_SCREEN){
            let contextCard = ScatterChartCard(frame: CGRect(x:0,y:0, width: self.view.frame.width, height:300))
            contextCard.setTodaysChart(sensor: sensor, yKeys: ["screen_status"])
            contextCard.titleLabel.text = NSLocalizedString("Screen", comment: "")
            self.contextCards.append(contextCard)
            self.mainStackView.addArrangedSubview(contextCard)
        }
    }
    
    func addActivityRecognitionCard(){
        if let sensor = AWARESensorManager.shared().getSensor(SENSOR_IOS_ACTIVITY_RECOGNITION) {
            let contextCard = ScatterChartCard(frame: CGRect(x:0,y:0, width: self.view.frame.width, height:300))
            contextCard.setFilterHandler { (key, value) -> Dictionary<String, Any>? in
                var val = value
                if key == "stationary" {
                    if val["stationary"] as? Double == 1.0 {
                        val["stationary"] = 1.0
                    }
                }else if key == "walking" {
                    if val["walking"] as? Double == 1.0{
                        val["walking"] = 2.0
                        val["stationary"] = 0
                    }
                }else if key == "running" {
                    if val["running"] as? Double == 1.0{
                        val["running"] = 3.0
                        val["stationary"] = 0
                    }
                }else if key == "automotive" {
                    if val["automotive"] as? Double == 1.0 {
                        val["automotive"] = 4.0
                        val["stationary"] = 0
                    }
                }else if key == "cycling" {
                    if val["cycling"] as? Double == 1.0 {
                        val["cycling"] = 5.0
                        val["stationary"] = 0
                    }
                }
                return val
            }
            contextCard.setTodaysChart(sensor: sensor, yKeys: ["stationary","walking","running","automotive","cycling"])
//            contextCard.setWeeklyChart(sensor: sensor, yKeys: ["stationary","walking","running","automotive","cycling"])
            contextCard.titleLabel.text = NSLocalizedString("Activity Recognition", comment: "")
            contextCard.yAxisMax = 5.5
            contextCard.yAxisMin = 0.5
            if let chart = contextCard.scatterChart {
                chart.leftAxis.enabled = false
            }
            self.contextCards.append(contextCard)
            self.mainStackView.addArrangedSubview(contextCard)
        }
    }
    
    func addAmbientNoiseCard() {
        if let sensor = AWARESensorManager.shared().getSensor(SENSOR_AMBIENT_NOISE) {
            // double_rms
            let rmsCard = ScatterChartCard(frame: CGRect(x:0,y:0, width: self.view.frame.width, height:300))
            rmsCard.setTodaysChart(sensor: sensor, yKeys: ["double_rms"])
            rmsCard.titleLabel.text = "Ambient Noise | RMS"
            self.contextCards.append(rmsCard)
            self.mainStackView.addArrangedSubview(rmsCard)
            
            // double_decibels
            let dbCard = ScatterChartCard(frame: CGRect(x:0,y:0, width: self.view.frame.width, height:300))
            dbCard.setTodaysChart(sensor: sensor, yKeys: ["double_decibels"])
            dbCard.titleLabel.text = "Ambient Noise | Decibel"
            self.contextCards.append(dbCard)
            self.mainStackView.addArrangedSubview(dbCard)
            
            // double_frequency
            let frequencyCard = ScatterChartCard(frame: CGRect(x:0,y:0, width: self.view.frame.width, height:300))
            frequencyCard.setTodaysChart(sensor: sensor, yKeys: ["double_frequency"])
            frequencyCard.titleLabel.text = "Ambient Noise | Frequency"
            self.contextCards.append(frequencyCard)
            self.mainStackView.addArrangedSubview(frequencyCard)
        }
    }
    
    func addOpenWeatherChart(){
        if let sensor = AWARESensorManager.shared().getSensor(SENSOR_PLUGIN_OPEN_WEATHER) {
            /// temperature
            let contextCard = ScatterChartCard(frame: CGRect(x:0,y:0, width: self.view.frame.width, height:300))
            contextCard.xAxisLabels = ["0","6","12","18","24"];
            contextCard.setTodaysChart(sensor: sensor, yKeys: ["temperature_min","temperature","temperature_max"])
            contextCard.titleLabel.text = NSLocalizedString("Weather", comment: "")
            self.contextCards.append(contextCard)
            self.mainStackView.addArrangedSubview(contextCard)
        }
    }

    func addDeviceUsageCard(){
        let contextCard = DeviceUsageCard(frame: CGRect(x:0,y:0, width: self.view.frame.width, height:280))
        contextCard.configure(sensor: AWARESensorManager.shared().getSensor(SENSOR_PLUGIN_DEVICE_USAGE),
                              configureHandler: { [weak self] in
            self?.presentBatteryScreenshotUploader()
        })
        self.contextCards.append(contextCard)
        self.mainStackView.addArrangedSubview(contextCard)
    }
    
    func addPedometerCard(){
        if let sensor = AWARESensorManager.shared().getSensor(SENSOR_PLUGIN_PEDOMETER) {
//            let contextCard = BarChartCard(frame: CGRect(x:0,y:0, width: self.view.frame.width, height:250))
            let contextCard = ScatterChartCard(frame: CGRect(x:0,y:0, width: self.view.frame.width, height:300))
            contextCard.xAxisLabels = ["0","6","12","18","24"]
            contextCard.yAxisMin = 0
            // contextCard.setTodaysChart(sensor: sensor, keys: ["number_of_steps"])
            contextCard.setTodaysChart(sensor: sensor, yKeys: ["number_of_steps"])
            contextCard.titleLabel.text = NSLocalizedString("Pedometer", comment: "")
            self.contextCards.append(contextCard)
            self.mainStackView.addArrangedSubview(contextCard)
        }
    }
    
    func addSignificantMotionCard(){
        if let sensor = AWARESensorManager.shared().getSensor(SENSOR_SIGNIFICANT_MOTION) {
            let contextCard = ScatterChartCard(frame: CGRect(x:0,y:0, width: self.view.frame.width, height:300))
            contextCard.xAxisLabels = ["0","6","12","18","24"];
            contextCard.setTodaysChart(sensor: sensor, yKeys: ["is_moving"])
            contextCard.titleLabel.text = NSLocalizedString("Significant Motion", comment:"")
            self.contextCards.append(contextCard)
            self.mainStackView.addArrangedSubview(contextCard)
        }
    }
    
    func addLocationCard(){

        if let fusedLocationSensor = AWARESensorManager.shared().getSensor(SENSOR_GOOGLE_FUSED_LOCATION) as? FusedLocations{
            let contextCard = MapCard(frame: CGRect(x:0,y:0, width: self.view.frame.width, height:400))
            contextCard.setMap(locationSensor: fusedLocationSensor.locationSensor)
            contextCard.titleLabel.text = NSLocalizedString("Location", comment:"")
            self.contextCards.append(contextCard)
            self.mainStackView.addArrangedSubview(contextCard)
        }
        
        if let locationSensor = AWARESensorManager.shared().getSensor("locations") as? Locations{
            let contextCard = MapCard(frame: CGRect(x:0,y:0, width: self.view.frame.width, height:400))
            contextCard.setMap(locationSensor: locationSensor)
            contextCard.titleLabel.text = NSLocalizedString("Location", comment:"")
            self.contextCards.append(contextCard)
            self.mainStackView.addArrangedSubview(contextCard)
        }
    }
    
    func addESMCard(){
        self.setupESMCard()
    }

}
