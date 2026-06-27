//
//  ContextCardViewController.swift
//  StudyTrace
//
//  Created by Yuuki Nishiyama on 2019/02/27.
//  Copyright © 2019 Yuuki Nishiyama. All rights reserved.
//

import UIKit
import AWAREFramework

class ContextCardViewController: UIViewController {

    @IBOutlet weak var refreshButton: UIBarButtonItem!
    @IBOutlet weak var deleteButton:  UIBarButtonItem!
    @IBOutlet weak var mainStackView: UIStackView!
    var contextCards = Array<ContextCard>()

    private let emptyStateStack = UIStackView()

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
        showBatteryScreenshotInstructions()
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
        contextCard.configure(sensor: AWARESensorManager.shared().getSensor(SENSOR_PLUGIN_DEVICE_USAGE), configureHandler: {})
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
