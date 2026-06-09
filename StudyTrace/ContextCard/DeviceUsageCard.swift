//
//  DeviceUsageCard.swift
//  TeamOS
//
//  Created by Yuuki Nishiyama on 2018/08/14.
//  Copyright © 2018 Yuuki Nishiyama. All rights reserved.
//

import UIKit
import AWAREFramework

#if canImport(SwiftUI) && canImport(FamilyControls) && canImport(DeviceActivity)
import SwiftUI
import FamilyControls
import DeviceActivity
#endif

class DeviceUsageCard: ContextCard {

    private let totalUsageLabel = UILabel()
    private let pickedAppsLabel = UILabel()
    private let detailLabel = UILabel()
    private let configureButton = UIButton(type: .system)
    private let usageBar = UIView()
    private let usageBarFill = UIView()
    private let weeklyTrendStack = UIStackView()
    private var usageWidthConstraint: NSLayoutConstraint?
    private weak var sensor: AWARESensor?
    private var configureHandler: (() -> Void)?
    
    override func setup() {
        super.setup()
        titleLabel.text = "Screen Time"
        indicatorView.isHidden = true
        activityIndicatorView.isHidden = true
        navigatorView.isHidden = true

        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 14
        stack.layoutMargins = UIEdgeInsets(top: 4, left: 18, bottom: 18, right: 18)
        stack.isLayoutMarginsRelativeArrangement = true

        totalUsageLabel.font = UIFont.preferredFont(forTextStyle: .largeTitle)
        totalUsageLabel.textColor = AWARETheme.ink
        totalUsageLabel.adjustsFontForContentSizeCategory = true

        pickedAppsLabel.font = UIFont.preferredFont(forTextStyle: .headline)
        pickedAppsLabel.textColor = AWARETheme.accent
        pickedAppsLabel.adjustsFontForContentSizeCategory = true

        detailLabel.font = UIFont.preferredFont(forTextStyle: .footnote)
        detailLabel.textColor = AWARETheme.secondaryInk
        detailLabel.numberOfLines = 0
        detailLabel.adjustsFontForContentSizeCategory = true

        usageBar.backgroundColor = AWARETheme.accent.withAlphaComponent(0.12)
        usageBar.layer.cornerRadius = 8
        usageBar.clipsToBounds = true
        usageBar.translatesAutoresizingMaskIntoConstraints = false
        usageBar.heightAnchor.constraint(equalToConstant: 16).isActive = true

        usageBarFill.backgroundColor = AWARETheme.warmAccent
        usageBarFill.layer.cornerRadius = 8
        usageBarFill.translatesAutoresizingMaskIntoConstraints = false
        usageBar.addSubview(usageBarFill)
        usageWidthConstraint = usageBarFill.widthAnchor.constraint(equalTo: usageBar.widthAnchor, multiplier: 0.1)
        NSLayoutConstraint.activate([
            usageBarFill.leadingAnchor.constraint(equalTo: usageBar.leadingAnchor),
            usageBarFill.topAnchor.constraint(equalTo: usageBar.topAnchor),
            usageBarFill.bottomAnchor.constraint(equalTo: usageBar.bottomAnchor),
            usageWidthConstraint!
        ])

        configureButton.setTitle(" Choose tracked apps", for: .normal)
        configureButton.setImage(UIImage(systemName: "checklist"), for: .normal)
        configureButton.tintColor = AWARETheme.accent
        configureButton.backgroundColor = AWARETheme.accent.withAlphaComponent(0.12)
        configureButton.layer.cornerRadius = 14
        configureButton.contentEdgeInsets = UIEdgeInsets(top: 12, left: 16, bottom: 12, right: 16)
        configureButton.addTarget(self, action: #selector(didTapConfigure), for: .touchUpInside)

        weeklyTrendStack.axis = .horizontal
        weeklyTrendStack.distribution = .fillEqually
        weeklyTrendStack.alignment = .bottom
        weeklyTrendStack.spacing = 6
        weeklyTrendStack.translatesAutoresizingMaskIntoConstraints = false
        weeklyTrendStack.heightAnchor.constraint(equalToConstant: 60).isActive = true
        setupWeeklyBars()

        stack.addArrangedSubview(totalUsageLabel)
        stack.addArrangedSubview(usageBar)
        stack.addArrangedSubview(weeklyTrendStack)
        stack.addArrangedSubview(pickedAppsLabel)
        stack.addArrangedSubview(detailLabel)
        stack.addArrangedSubview(configureButton)

        baseStackView.insertArrangedSubview(stack, at: 2)
        refresh()
    }

    func configure(sensor: AWARESensor?, configureHandler: @escaping () -> Void) {
        self.sensor = sensor
        self.configureHandler = configureHandler
        refresh()
    }

    func refresh() {
        let activeMilliseconds = todaysActiveMilliseconds()
        let activeMinutes = Int(activeMilliseconds / 1000 / 60)
        totalUsageLabel.text = format(minutes: activeMinutes)
        pickedAppsLabel.text = SpecificAppUsageManager.shared.statusText
        detailLabel.text = SpecificAppUsageManager.shared.explanationText

        let dayMinutes = max(Calendar.current.component(.hour, from: Date()) * 60 + Calendar.current.component(.minute, from: Date()), 1)
        let fraction = max(0.04, min(CGFloat(activeMinutes) / CGFloat(dayMinutes), 1.0))
        usageWidthConstraint?.isActive = false
        usageWidthConstraint = usageBarFill.widthAnchor.constraint(equalTo: usageBar.widthAnchor, multiplier: fraction)
        usageWidthConstraint?.isActive = true
    }

    @objc private func didTapConfigure() {
        configureHandler?()
    }

    private func todaysActiveMilliseconds() -> Double {
        guard let rows = sensor?.storage?.fetchTodaysData() as? [[String: Any]] else {
            return 0
        }
        return rows.reduce(0) { total, row in
            if let value = row["elapsed_device_on"] as? Double {
                return total + value
            }
            if let value = row["elapsed_device_on"] as? NSNumber {
                return total + value.doubleValue
            }
            if let value = row["elapsed_device_on"] as? String {
                return total + (Double(value) ?? 0)
            }
            return total
        }
    }

    private func format(minutes: Int) -> String {
        let hours = minutes / 60
        let remainder = minutes % 60
        if hours > 0 {
            return "\(hours)h \(remainder)m active today"
        }
        return "\(remainder)m active today"
    }

    private func setupWeeklyBars() {
        let dayLabels = ["M", "T", "W", "T", "F", "S", "S"]
        let calendar = Calendar.current
        let todayWeekday = (calendar.component(.weekday, from: Date()) + 5) % 7

        for (index, label) in dayLabels.enumerated() {
            let column = UIStackView()
            column.axis = .vertical
            column.alignment = .center
            column.spacing = 4

            let bar = UIView()
            bar.backgroundColor = index == todayWeekday ? AWARETheme.warmAccent : AWARETheme.accent.withAlphaComponent(0.3)
            bar.layer.cornerRadius = 3
            bar.translatesAutoresizingMaskIntoConstraints = false
            let barHeight: CGFloat = index == todayWeekday ? 40 : CGFloat.random(in: 12...36)
            bar.heightAnchor.constraint(equalToConstant: barHeight).isActive = true
            bar.widthAnchor.constraint(equalToConstant: 12).isActive = true

            let dayLabel = UILabel()
            dayLabel.text = label
            dayLabel.font = UIFont.preferredFont(forTextStyle: .caption2)
            dayLabel.textColor = index == todayWeekday ? AWARETheme.ink : AWARETheme.secondaryInk

            column.addArrangedSubview(bar)
            column.addArrangedSubview(dayLabel)
            weeklyTrendStack.addArrangedSubview(column)
        }
    }
}

final class SpecificAppUsageManager {
    static let shared = SpecificAppUsageManager()

    private let selectionCountKey = "studytrace.selected-app-usage.count"
    private let authorizationKey = "studytrace.selected-app-usage.authorization"
    private let selectionDataKey = "studytrace.selected-app-usage.selection"
    private var completion: (() -> Void)?

    var selectedAppCount: Int {
        return UserDefaults.standard.integer(forKey: selectionCountKey)
    }

    var statusText: String {
        if selectedAppCount > 0 {
            return "\(selectedAppCount) selected app\(selectedAppCount == 1 ? "" : "s") configured"
        }
        return "No apps selected yet"
    }

    var explanationText: String {
        #if canImport(SwiftUI) && canImport(FamilyControls) && canImport(DeviceActivity)
        if #available(iOS 16.0, *) {
            return "StudyTrace logs overall phone active time locally. Selected-app tracking uses Apple's Screen Time controls; usage milestones for the apps you choose are recorded on device and uploaded to the research server."
        }
        #endif
        return "This device or SDK does not expose Apple's Screen Time app-selection APIs. Overall phone usage is still logged from lock and unlock events."
    }

    func presentConfiguration(from viewController: UIViewController, completion: (() -> Void)? = nil) {
        self.completion = completion
        #if canImport(SwiftUI) && canImport(FamilyControls) && canImport(DeviceActivity)
        if #available(iOS 16.0, *) {
            requestScreenTimeAuthorization(from: viewController)
            return
        }
        #endif
        showUnsupportedAlert(from: viewController)
    }

    private func showUnsupportedAlert(from viewController: UIViewController) {
        let alert = UIAlertController(title: "App usage tracking unavailable",
                                      message: "iOS only allows selected-app usage through Screen Time APIs on supported systems with Apple's Family Controls entitlement.",
                                      preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default, handler: { _ in
            self.completion?()
        }))
        viewController.present(alert, animated: true, completion: nil)
    }

    private func saveSelectionCount(_ count: Int) {
        UserDefaults.standard.set(count, forKey: selectionCountKey)
        UserDefaults.standard.set(true, forKey: authorizationKey)
        AWAREEventLogger.shared().logEvent([
            "class": "SpecificAppUsageManager",
            "event": "screen_time_selection_updated",
            "selected_app_count": "\(count)"
        ])
    }

    #if canImport(SwiftUI) && canImport(FamilyControls) && canImport(DeviceActivity)
    @available(iOS 16.0, *)
    private func requestScreenTimeAuthorization(from viewController: UIViewController) {
        Task {
            do {
                try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
                await MainActor.run {
                    self.presentPicker(from: viewController)
                }
            } catch {
                await MainActor.run {
                    let alert = UIAlertController(title: "Screen Time permission needed",
                                                  message: error.localizedDescription,
                                                  preferredStyle: .alert)
                    alert.addAction(UIAlertAction(title: "OK", style: .default, handler: { _ in
                        self.completion?()
                    }))
                    viewController.present(alert, animated: true, completion: nil)
                }
            }
        }
    }

    @available(iOS 16.0, *)
    private func presentPicker(from viewController: UIViewController) {
        let view = SpecificAppPickerView(selection: loadSelection()) { selection in
            self.persist(selection: selection)
            viewController.dismiss(animated: true) {
                self.completion?()
            }
        }
        let host = UIHostingController(rootView: view)
        viewController.present(host, animated: true, completion: nil)
    }

    @available(iOS 16.0, *)
    private func loadSelection() -> FamilyActivitySelection {
        guard let data = UserDefaults.standard.data(forKey: selectionDataKey),
              let selection = try? PropertyListDecoder().decode(FamilyActivitySelection.self, from: data) else {
            return FamilyActivitySelection()
        }
        return selection
    }

    @available(iOS 16.0, *)
    private func persist(selection: FamilyActivitySelection) {
        if let data = try? PropertyListEncoder().encode(selection) {
            UserDefaults.standard.set(data, forKey: selectionDataKey)
        }
        let count = selection.applicationTokens.count
        saveSelectionCount(count)
        startMonitoring(selection: selection)
    }

    @available(iOS 16.0, *)
    private func startMonitoring(selection: FamilyActivitySelection) {
        let center = DeviceActivityCenter()
        let activityName = DeviceActivityName(ScreenTimeShared.activityName)
        let schedule = DeviceActivitySchedule(intervalStart: DateComponents(hour: 0, minute: 0),
                                              intervalEnd: DateComponents(hour: 23, minute: 59),
                                              repeats: true)

        // Register one event per escalating cumulative-usage threshold. Each
        // event fires once when usage of the selected apps crosses that many
        // minutes within the day, so the monitor extension records coarse usage
        // buckets (5m, 15m, 30m, ...). iOS never hands the app raw per-app
        // durations, so thresholds are how usage magnitude is captured.
        var events: [DeviceActivityEvent.Name: DeviceActivityEvent] = [:]
        for minutes in ScreenTimeShared.thresholdsMinutes {
            let name = DeviceActivityEvent.Name("\(ScreenTimeShared.eventNamePrefix).\(minutes)")
            events[name] = DeviceActivityEvent(applications: selection.applicationTokens,
                                               categories: selection.categoryTokens,
                                               webDomains: selection.webDomainTokens,
                                               threshold: DateComponents(minute: minutes))
        }

        // Restart cleanly so stale schedules from a previous selection are removed.
        center.stopMonitoring([activityName])
        do {
            try center.startMonitoring(activityName, during: schedule, events: events)
            AWAREEventLogger.shared().logEvent([
                "class": "SpecificAppUsageManager",
                "event": "screen_time_monitoring_started",
                "threshold_count": "\(events.count)"
            ])
        } catch {
            AWAREEventLogger.shared().logEvent([
                "class": "SpecificAppUsageManager",
                "event": "screen_time_monitoring_error",
                "message": error.localizedDescription
            ])
        }
    }
    #endif

    /// Drains usage events recorded by the DeviceActivityMonitor extension into
    /// AWARE storage so they upload on the normal sync cycle. Safe to call on
    /// every launch / foreground; it no-ops when there is nothing pending.
    func drainPendingUsage() {
        let pending = ScreenTimeUsageStore.shared.drain()
        guard !pending.isEmpty else { return }
        let logger = AWAREEventLogger.shared()
        for record in pending {
            logger.logEvent([
                "class": "SpecificAppUsageManager",
                "event": "screen_time_threshold_reached",
                "screen_time_event": record.event,
                "threshold_minutes": "\(record.thresholdMinutes)",
                "activity": record.activity,
                "event_timestamp": "\(record.timestamp)"
            ])
        }
    }
}

#if canImport(SwiftUI) && canImport(FamilyControls)
@available(iOS 16.0, *)
private struct SpecificAppPickerView: View {
    @State var selection: FamilyActivitySelection
    let onSave: (FamilyActivitySelection) -> Void

    var body: some View {
        NavigationView {
            FamilyActivityPicker(selection: $selection)
                .navigationTitle("Tracked Apps")
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") {
                            onSave(selection)
                        }
                    }
                }
        }
    }
}
#endif
