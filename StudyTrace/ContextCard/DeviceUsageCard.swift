//
//  DeviceUsageCard.swift
//  TeamOS
//
//  Created by Yuuki Nishiyama on 2018/08/14.
//  Copyright © 2018 Yuuki Nishiyama. All rights reserved.
//

import UIKit
import AWAREFramework

#if canImport(SwiftUI) && canImport(FamilyControls) && canImport(DeviceActivity) && canImport(ManagedSettings)
import SwiftUI
import FamilyControls
import DeviceActivity
import ManagedSettings
#endif

#if canImport(SwiftUI) && canImport(FamilyControls) && canImport(DeviceActivity) && canImport(ManagedSettings)
@available(iOS 16.0, *)
extension DeviceActivityReport.Context {
    static let studyTraceAppUsage = Self("StudyTrace App Usage")
}
#endif

class DeviceUsageCard: ContextCard {

    private let totalUsageLabel = UILabel()
    private let pickedAppsLabel = UILabel()
    private let detailLabel = UILabel()
    private let summaryStack = UIStackView()
    private let configureButton = UIButton(type: .system)
    private let usageBar = UIView()
    private let usageBarFill = UIView()
    private let weeklyTrendStack = UIStackView()
    private var usageWidthConstraint: NSLayoutConstraint?
    private weak var sensor: AWARESensor?
    private var configureHandler: (() -> Void)?
    private var reportHandler: (() -> Void)?
    
    override func setup() {
        super.setup()
        titleLabel.text = "Battery Usage Screenshot"
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

        summaryStack.axis = .vertical
        summaryStack.spacing = 8

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

        configureButton.setTitle(" How to upload Battery screenshot", for: .normal)
        configureButton.setImage(UIImage(systemName: "camera.viewfinder"), for: .normal)
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
        weeklyTrendStack.isHidden = true
        weeklyTrendStack.heightAnchor.constraint(equalToConstant: 60).isActive = true
        setupWeeklyBars()
        usageBar.isHidden = true

        stack.addArrangedSubview(totalUsageLabel)
        stack.addArrangedSubview(usageBar)
        stack.addArrangedSubview(weeklyTrendStack)
        stack.addArrangedSubview(pickedAppsLabel)
        stack.addArrangedSubview(detailLabel)
        stack.addArrangedSubview(summaryStack)
        stack.addArrangedSubview(configureButton)

        baseStackView.insertArrangedSubview(stack, at: 2)

        // This card stacks more content than the default fixed card height, so
        // become self-sizing. Otherwise the bottom content (the configure
        // button) overflows the card bounds and cannot receive touches.
        makeSelfSizing()
        refresh()
    }

    func configure(sensor: AWARESensor?,
                   configureHandler: @escaping () -> Void,
                   reportHandler: (() -> Void)? = nil) {
        self.sensor = sensor
        self.configureHandler = configureHandler
        self.reportHandler = reportHandler
        refresh()
    }

    func refresh() {
        totalUsageLabel.text = "Upload when prompted"
        pickedAppsLabel.text = "Participant-submitted Battery screenshot"
        detailLabel.text = "If your study asks for app-usage context, complete the Battery usage screenshot survey. Open iPhone Settings > Battery > View All Battery Usage, take a screenshot, and upload it as the survey photo response."
        refreshSummaryRows()
        refreshButtonState()
    }

    @objc private func didTapConfigure() {
        presentBatteryScreenshotInstructions()
    }

    private func refreshButtonState() {
        configureButton.setTitle(" How to upload Battery screenshot", for: .normal)
        configureButton.setImage(UIImage(systemName: "camera.viewfinder"), for: .normal)
    }

    private func refreshSummaryRows() {
        summaryStack.arrangedSubviews.forEach { view in
            summaryStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }

        summaryStack.addArrangedSubview(summaryPlaceholder(text: "1. Open iPhone Settings > Battery."))
        summaryStack.addArrangedSubview(summaryPlaceholder(text: "2. Tap View All Battery Usage so app rows and screen-time values are visible."))
        summaryStack.addArrangedSubview(summaryPlaceholder(text: "3. Take a screenshot and upload it in the Battery usage screenshot survey."))
    }

    private func presentBatteryScreenshotInstructions() {
        let alert = UIAlertController(
            title: "Battery usage screenshot",
            message: "When the study sends a Battery usage screenshot survey, open iPhone Settings > Battery > View All Battery Usage, take a screenshot, return to StudyTrace, and upload it as the photo answer.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        nearestViewController()?.present(alert, animated: true)
    }

    private func nearestViewController() -> UIViewController? {
        var responder: UIResponder? = self
        while let next = responder?.next {
            if let viewController = next as? UIViewController {
                return viewController
            }
            responder = next
        }
        return nil
    }

    private func summaryRow(title: String, detail: String) -> UIView {
        let row = UIStackView()
        row.axis = .horizontal
        row.alignment = .firstBaseline
        row.spacing = 8

        let titleLabel = UILabel()
        titleLabel.font = UIFont.preferredFont(forTextStyle: .subheadline)
        titleLabel.textColor = AWARETheme.ink
        titleLabel.text = title

        let spacer = UIView()

        let detailLabel = UILabel()
        detailLabel.font = UIFont.preferredFont(forTextStyle: .caption1)
        detailLabel.textColor = AWARETheme.secondaryInk
        detailLabel.textAlignment = .right
        detailLabel.text = detail

        row.addArrangedSubview(titleLabel)
        row.addArrangedSubview(spacer)
        row.addArrangedSubview(detailLabel)
        return row
    }

    private func summaryPlaceholder(text: String) -> UIView {
        let label = UILabel()
        label.font = UIFont.preferredFont(forTextStyle: .caption1)
        label.textColor = AWARETheme.secondaryInk
        label.numberOfLines = 0
        label.text = text
        return label
    }

    private func displayName(for summary: ScreenTimeAppUsageSummary) -> String {
        if let name = summary.appName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            return name
        }
        return summary.targetLabel
    }

    private func displayName(for milestone: ScreenTimeUsageEvent) -> String {
        if let resolved = ScreenTimeUsageStore.shared.resolvedLabel(targetKind: milestone.targetKind, targetIndex: milestone.targetIndex) {
            return resolved.appName
        }
        return milestone.targetLabel
    }

    private func formatMilestoneDetail(for milestone: ScreenTimeUsageEvent) -> String {
        ">= \(milestone.thresholdMinutes)m today"
    }

    private func formatExactDuration(seconds: Double) -> String {
        let totalMinutes = Int(seconds / 60)
        let hours = totalMinutes / 60
        let minutes = totalMinutes % 60
        if hours > 0 {
            return "\(hours)h \(minutes)m"
        }
        if totalMinutes > 0 {
            return "\(totalMinutes)m"
        }
        return "<1m"
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

final class SpecificAppUsageManager: NSObject {
    static let shared = SpecificAppUsageManager()

    private let selectionCountKey = "studytrace.selected-app-usage.count"
    private let selectionCategoryCountKey = "studytrace.selected-app-usage.category-count"
    private let selectionWebCountKey = "studytrace.selected-app-usage.web-count"
    private let authorizationKey = "studytrace.selected-app-usage.authorization"
    private let selectionDataKey = ScreenTimeShared.selectionDataKey
    private var completion: (() -> Void)?
    private var reportCompletion: (() -> Void)?

    var selectedAppCount: Int {
        return UserDefaults.standard.integer(forKey: selectionCountKey)
    }

    var selectedCategoryCount: Int {
        return UserDefaults.standard.integer(forKey: selectionCategoryCountKey)
    }

    var selectedWebDomainCount: Int {
        return UserDefaults.standard.integer(forKey: selectionWebCountKey)
    }

    /// Total of every selected token kind. Selecting whole categories (or
    /// "select all") populates categoryTokens with no applicationTokens, so the
    /// app count alone is not a reliable signal that a selection exists.
    var selectedTotalCount: Int {
        return selectedAppCount + selectedCategoryCount + selectedWebDomainCount
    }

    var statusText: String {
        guard selectedTotalCount > 0 else {
            return "No apps selected yet"
        }
        var parts: [String] = []
        if selectedAppCount > 0 {
            parts.append("\(selectedAppCount) app\(selectedAppCount == 1 ? "" : "s")")
        }
        if selectedCategoryCount > 0 {
            parts.append("\(selectedCategoryCount) categor\(selectedCategoryCount == 1 ? "y" : "ies")")
        }
        if selectedWebDomainCount > 0 {
            parts.append("\(selectedWebDomainCount) site\(selectedWebDomainCount == 1 ? "" : "s")")
        }
        return parts.joined(separator: ", ") + " selected"
    }

    var explanationText: String {
        #if canImport(SwiftUI) && canImport(FamilyControls) && canImport(DeviceActivity) && canImport(ManagedSettings)
        if #available(iOS 16.0, *) {
            return "StudyTrace logs overall phone active time locally. Precise Screen Time rows are generated when you open Apple's visible DeviceActivity report for the approved targets; milestone rows remain as fallback diagnostics."
        }
        #endif
        return "This device or SDK does not expose Apple's Screen Time category APIs. Overall phone usage is still logged from lock and unlock events."
    }

    func presentConfiguration(from viewController: UIViewController, completion: (() -> Void)? = nil) {
        self.completion = completion
        #if canImport(SwiftUI) && canImport(FamilyControls) && canImport(DeviceActivity) && canImport(ManagedSettings)
        if #available(iOS 16.0, *) {
            requestScreenTimeAuthorization(from: viewController)
            return
        }
        #endif
        showUnsupportedAlert(from: viewController)
    }

    func presentUsageReport(from viewController: UIViewController,
                            completion: (() -> Void)? = nil,
                            autoDismissAfter: TimeInterval? = nil) {
        #if canImport(SwiftUI) && canImport(FamilyControls) && canImport(DeviceActivity) && canImport(ManagedSettings)
        if #available(iOS 16.0, *) {
            let selection = loadSelection()
            guard !selection.applicationTokens.isEmpty ||
                  !selection.categoryTokens.isEmpty ||
                  !selection.webDomainTokens.isEmpty else {
                completion?()
                return
            }
            let host = UIHostingController(rootView: SpecificAppUsageReportHost(selection: selection) {
                self.scheduleScreenTimeDrainAndSync()
            })
            host.title = "Precise Screen Time Export"
            let nav = UINavigationController(rootViewController: host)
            host.navigationItem.rightBarButtonItem = UIBarButtonItem(
                barButtonSystemItem: .done,
                target: self,
                action: #selector(dismissPresentedReport)
            )
            self.reportCompletion = completion
            viewController.present(nav, animated: true) {
                self.scheduleScreenTimeDrainAndSync()
                if let autoDismissAfter = autoDismissAfter {
                    DispatchQueue.main.asyncAfter(deadline: .now() + autoDismissAfter) { [weak nav] in
                        guard let nav = nav, nav.presentingViewController != nil else { return }
                        nav.dismiss(animated: true) {
                            self.finishReportPresentation()
                        }
                    }
                }
            }
            return
        }
        #endif
        completion?()
    }

    @objc private func dismissPresentedReport(_ sender: UIBarButtonItem) {
        UIApplication.shared.windows.first(where: { $0.isKeyWindow })?
            .rootViewController?
            .presentedViewController?
            .dismiss(animated: true) {
                self.finishReportPresentation()
            }
    }

    private func finishReportPresentation() {
        scheduleScreenTimeDrainAndSync()
        let completion = reportCompletion
        reportCompletion = nil
        completion?()
    }

    private func showUnsupportedAlert(from viewController: UIViewController) {
        let alert = UIAlertController(title: "App usage tracking unavailable",
                                      message: "iOS only allows selected Screen Time target summaries on supported systems with Apple's Family Controls entitlement.",
                                      preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default, handler: { _ in
            self.completion?()
        }))
        viewController.present(alert, animated: true, completion: nil)
    }

    private func saveSelectionCounts(apps: Int, categories: Int, webDomains: Int) {
        UserDefaults.standard.set(apps, forKey: selectionCountKey)
        UserDefaults.standard.set(categories, forKey: selectionCategoryCountKey)
        UserDefaults.standard.set(webDomains, forKey: selectionWebCountKey)
        UserDefaults.standard.set(true, forKey: authorizationKey)
        AWAREEventLogger.shared().logEvent([
            "class": "SpecificAppUsageManager",
            "event": "screen_time_selection_updated",
            "selected_app_count": "\(apps)",
            "selected_category_count": "\(categories)",
            "selected_web_count": "\(webDomains)"
        ])
    }

    #if canImport(SwiftUI) && canImport(FamilyControls) && canImport(DeviceActivity) && canImport(ManagedSettings)
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
                self.presentUsageReport(from: viewController, completion: {
                    self.completion?()
                }, autoDismissAfter: 20.0)
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
        let orderedApplicationTokens = Array(selection.applicationTokens)
        let orderedCategoryTokens = Array(selection.categoryTokens)
        if let data = try? PropertyListEncoder().encode(selection) {
            UserDefaults.standard.set(data, forKey: selectionDataKey)
            UserDefaults(suiteName: ScreenTimeShared.appGroupID)?.set(data, forKey: selectionDataKey)
        }
        if let data = try? PropertyListEncoder().encode(orderedApplicationTokens) {
            UserDefaults.standard.set(data, forKey: ScreenTimeShared.applicationTokenOrderDataKey)
            UserDefaults(suiteName: ScreenTimeShared.appGroupID)?.set(data, forKey: ScreenTimeShared.applicationTokenOrderDataKey)
        }
        if let data = try? PropertyListEncoder().encode(orderedCategoryTokens) {
            UserDefaults.standard.set(data, forKey: ScreenTimeShared.categoryTokenOrderDataKey)
            UserDefaults(suiteName: ScreenTimeShared.appGroupID)?.set(data, forKey: ScreenTimeShared.categoryTokenOrderDataKey)
        }
        ScreenTimeUsageStore.shared.clear()
        ScreenTimeUsageStore.shared.clearLatestThresholdEvents()
        ScreenTimeUsageStore.shared.clearLatestReportSummaries()
        ScreenTimeUsageStore.shared.clearResolvedLabels()
        saveSelectionCounts(apps: selection.applicationTokens.count,
                            categories: selection.categoryTokens.count,
                            webDomains: selection.webDomainTokens.count)
        startMonitoring(selection: selection, orderedApplicationTokens: orderedApplicationTokens)
    }

    @available(iOS 16.0, *)
    private func startMonitoring(selection: FamilyActivitySelection,
                                 orderedApplicationTokens: [ApplicationToken]) {
        let center = DeviceActivityCenter()
        let activityName = DeviceActivityName(ScreenTimeShared.activityName)
        let schedule = DeviceActivitySchedule(intervalStart: DateComponents(hour: 0, minute: 0),
                                              intervalEnd: DateComponents(hour: 23, minute: 59),
                                              repeats: true)

        // Register coarse usage milestones. Apple does not expose unrestricted
        // durations or app names to the app, so each selected token is tracked
        // as an indexed app/category/site milestone stream.
        var events: [DeviceActivityEvent.Name: DeviceActivityEvent] = [:]
        func addThresholds(nameParts: [String],
                           applications: Set<ApplicationToken> = [],
                           categories: Set<ActivityCategoryToken> = [],
                           webDomains: Set<WebDomainToken> = []) {
            for minutes in ScreenTimeShared.thresholdsMinutes {
                let name = DeviceActivityEvent.Name(([
                    ScreenTimeShared.eventNamePrefix
                ] + nameParts + [String(minutes)]).joined(separator: "."))
                events[name] = DeviceActivityEvent(applications: applications,
                                                   categories: categories,
                                                   webDomains: webDomains,
                                                   threshold: DateComponents(minute: minutes))
            }
        }

        addThresholds(nameParts: [ScreenTimeShared.targetAggregate],
                      applications: selection.applicationTokens,
                      categories: selection.categoryTokens,
                      webDomains: selection.webDomainTokens)

        for (index, token) in orderedApplicationTokens.enumerated() {
            addThresholds(nameParts: [ScreenTimeShared.targetApplication, String(index)],
                          applications: Set([token]))
        }
        for (index, token) in Array(selection.categoryTokens).enumerated() {
            addThresholds(nameParts: [ScreenTimeShared.targetCategory, String(index)],
                          categories: Set([token]))
        }
        for (index, token) in Array(selection.webDomainTokens).enumerated() {
            addThresholds(nameParts: [ScreenTimeShared.targetWebDomain, String(index)],
                          webDomains: Set([token]))
        }

        // Backward-compatible aggregate event names used by earlier builds.
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
                "threshold_count": "\(events.count)",
                "threshold_minutes": ScreenTimeShared.thresholdsMinutes.map(String.init).joined(separator: ","),
                "selected_app_count": "\(selection.applicationTokens.count)",
                "selected_category_count": "\(selection.categoryTokens.count)",
                "selected_web_count": "\(selection.webDomainTokens.count)"
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
    @discardableResult
    func drainPendingUsage(syncImmediately: Bool = false) -> Int {
        let pending = ScreenTimeUsageStore.shared.drain()
        let summaries = ScreenTimeUsageStore.shared.drainReportSummaries()
        guard !pending.isEmpty || !summaries.isEmpty else { return 0 }
        let logger = AWAREEventLogger.shared()
        let resolvedLabels = ScreenTimeUsageStore.shared.loadResolvedLabels()
        for record in pending {
            let resolvedLabel = record.targetIndex.flatMap { resolvedLabels["\(record.targetKind):\($0)"] }
            logger.logEvent([
                "class": "SpecificAppUsageManager",
                "event": "screen_time_threshold_reached",
                "screen_time_event": record.event,
                "threshold_minutes": "\(record.thresholdMinutes)",
                "target_kind": record.targetKind,
                "target_index": record.targetIndex.map(String.init) ?? "",
                "target_label": resolvedLabel?.appName ?? record.targetLabel,
                "app_name": resolvedLabel?.appName ?? "",
                "bundle_identifier": resolvedLabel?.bundleIdentifier ?? "",
                "duration_lower_bound_seconds": "\(record.durationLowerBoundSeconds)",
                "activity": record.activity,
                "event_timestamp": "\(record.timestamp)"
            ])
        }
        let freshLabels = summaries.compactMap { summary -> ScreenTimeResolvedLabel? in
            guard let appName = summary.appName?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !appName.isEmpty else { return nil }
            return ScreenTimeResolvedLabel(
                targetKind: summary.targetKind,
                targetIndex: summary.targetIndex,
                appName: appName,
                bundleIdentifier: summary.bundleIdentifier,
                source: "device_activity_report",
                updatedAt: summary.timestamp
            )
        }
        if !freshLabels.isEmpty {
            ScreenTimeUsageStore.shared.saveResolvedLabels(mergeResolvedLabels(existing: resolvedLabels, incoming: freshLabels))
            let labelPayload = freshLabels.map { label in
                [
                    "targetKind": label.targetKind,
                    "targetIndex": label.targetIndex,
                    "label": label.appName,
                    "bundleIdentifier": label.bundleIdentifier ?? "",
                    "source": label.source,
                    "timestamp": label.updatedAt,
                ]
            }
            logger.logEvent([
                "class": "SpecificAppUsageManager",
                "event": "screen_time_labels_updated",
                "labels_json": jsonString(from: labelPayload)
            ])
        }
        for summary in summaries {
            let eventName = summary.targetKind == ScreenTimeShared.targetCategory
                ? "screen_time_report_category_usage"
                : "screen_time_report_app_usage"
            logger.logEvent([
                "class": "SpecificAppUsageManager",
                "event": eventName,
                "target_kind": summary.targetKind,
                "target_index": "\(summary.targetIndex)",
                "target_label": summary.targetLabel,
                "app_name": summary.appName ?? "",
                "bundle_identifier": summary.bundleIdentifier ?? "",
                "duration_seconds": "\(summary.durationSeconds)",
                "pickups": "\(summary.pickups)",
                "notifications": "\(summary.notifications)",
                "interval_start": "\(summary.intervalStart)",
                "interval_end": "\(summary.intervalEnd)",
                "event_timestamp": "\(summary.timestamp)"
            ])
        }
        let loggedCount = pending.count + summaries.count
        if syncImmediately {
            syncScreenTimeLogsNow()
        }
        return loggedCount
    }

    private func mergeResolvedLabels(existing: [String: ScreenTimeResolvedLabel],
                                     incoming: [ScreenTimeResolvedLabel]) -> [ScreenTimeResolvedLabel] {
        var merged = existing
        for label in incoming {
            merged[label.cacheKey] = label
        }
        return Array(merged.values)
    }

    private func jsonString(from value: Any) -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: []),
              let string = String(data: data, encoding: .utf8) else {
            return "[]"
        }
        return string
    }

    func scheduleScreenTimeDrainAndSync() {
        let delays: [TimeInterval] = [0.25, 1.5, 4.0]
        for delay in delays {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                self.drainPendingUsage(syncImmediately: true)
            }
        }
    }

    private func syncScreenTimeLogsNow() {
        guard StudyParticipationController.hasConsent() else { return }
        AWARESensorManager.shared().syncAllSensorsForcefully()
    }

    func resetMonitoringAndSelection() {
        UserDefaults.standard.removeObject(forKey: selectionCountKey)
        UserDefaults.standard.removeObject(forKey: selectionCategoryCountKey)
        UserDefaults.standard.removeObject(forKey: selectionWebCountKey)
        UserDefaults.standard.removeObject(forKey: authorizationKey)
        UserDefaults.standard.removeObject(forKey: selectionDataKey)
        UserDefaults.standard.removeObject(forKey: ScreenTimeShared.applicationTokenOrderDataKey)
        UserDefaults.standard.removeObject(forKey: ScreenTimeShared.categoryTokenOrderDataKey)
        UserDefaults(suiteName: ScreenTimeShared.appGroupID)?.removeObject(forKey: selectionDataKey)
        UserDefaults(suiteName: ScreenTimeShared.appGroupID)?.removeObject(forKey: ScreenTimeShared.applicationTokenOrderDataKey)
        UserDefaults(suiteName: ScreenTimeShared.appGroupID)?.removeObject(forKey: ScreenTimeShared.categoryTokenOrderDataKey)
        ScreenTimeUsageStore.shared.clear()
        ScreenTimeUsageStore.shared.clearLatestThresholdEvents()
        ScreenTimeUsageStore.shared.clearLatestReportSummaries()
        ScreenTimeUsageStore.shared.clearResolvedLabels()

        #if canImport(SwiftUI) && canImport(FamilyControls) && canImport(DeviceActivity) && canImport(ManagedSettings)
        if #available(iOS 16.0, *) {
            let center = DeviceActivityCenter()
            center.stopMonitoring([DeviceActivityName(ScreenTimeShared.activityName)])
        }
        #endif
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

#if canImport(SwiftUI) && canImport(FamilyControls) && canImport(DeviceActivity) && canImport(ManagedSettings)
@available(iOS 16.0, *)
private struct SpecificAppUsageReportHost: View {
    let selection: FamilyActivitySelection
    let onRefresh: () -> Void
    @State private var summaries = ScreenTimeUsageStore.shared.loadLatestReportSummaries()
    @State private var milestones = ScreenTimeUsageStore.shared.loadLatestThresholdEvents()
    @State private var reportRefreshID = UUID()
    @State private var refreshTask: Task<Void, Never>?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Precise Screen Time Export")
                    .font(.headline)

                Text("This screen renders Apple's DeviceActivity report for the approved targets. When iOS returns the report, StudyTrace stores and uploads exact duration rows as duration_seconds.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                if !summaries.isEmpty {
                    ForEach(Array(summaries.prefix(20).enumerated()), id: \.offset) { _, summary in
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(displayName(for: summary))
                                    .font(.body.weight(.medium))
                                Text(targetDescription(for: summary))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(format(seconds: summary.durationSeconds))
                                .font(.body.monospacedDigit())
                        }
                        Divider()
                    }
                } else if !milestones.isEmpty {
                    Text("Exact report rows have not arrived yet. Fallback milestone rows are available below.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    ForEach(Array(milestones.prefix(10).enumerated()), id: \.offset) { _, milestone in
                        HStack {
                            Text(displayName(for: milestone))
                            Spacer()
                            Text(">= \(milestone.thresholdMinutes)m")
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(.secondary)
                        }
                        Divider()
                    }
                } else {
                    Text("No precise Screen Time rows are available yet.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Text("Keep this screen open briefly so iOS can run the report extension. If the report is still blank, use an approved target and try again.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Button("Refresh precise report") {
                    requestRefresh()
                }
                .buttonStyle(.borderedProminent)

                VStack(alignment: .leading, spacing: 8) {
                    Text("Apple report renderer")
                        .font(.subheadline.weight(.semibold))
                    Text("This visible renderer is required for exact Screen Time durations; iOS does not provide these exact rows to the app in the background.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    DeviceActivityReport(.studyTraceAppUsage, filter: filter)
                        .id(reportRefreshID)
                        .frame(minHeight: 260)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
        .navigationTitle("Screen Time")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            refreshFromStore()
            onRefresh()
            startRefreshing()
        }
        .onDisappear {
            refreshTask?.cancel()
            refreshTask = nil
        }
    }

    private var filter: DeviceActivityFilter {
        let calendar = Calendar.current
        let start = calendar.startOfDay(for: Date())
        let interval = DateInterval(start: start, end: Date())
        return DeviceActivityFilter(
            segment: .daily(during: interval),
            users: .all,
            devices: .all,
            applications: selection.applicationTokens,
            categories: selection.categoryTokens,
            webDomains: selection.webDomainTokens
        )
    }

    private func startRefreshing() {
        refreshTask?.cancel()
        refreshTask = Task {
            for _ in 0..<15 {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    refreshFromStore()
                }
            }
        }
    }

    private func refreshFromStore() {
        summaries = ScreenTimeUsageStore.shared.loadLatestReportSummaries()
        milestones = ScreenTimeUsageStore.shared.loadLatestThresholdEvents()
    }

    private func requestRefresh() {
        reportRefreshID = UUID()
        refreshFromStore()
        onRefresh()
        startRefreshing()
    }

    private func displayName(for summary: ScreenTimeAppUsageSummary) -> String {
        if let appName = summary.appName?.trimmingCharacters(in: .whitespacesAndNewlines), !appName.isEmpty {
            return appName
        }
        return summary.targetLabel
    }

    private func displayName(for milestone: ScreenTimeUsageEvent) -> String {
        if let resolved = ScreenTimeUsageStore.shared.resolvedLabel(targetKind: milestone.targetKind, targetIndex: milestone.targetIndex) {
            return resolved.appName
        }
        return milestone.targetLabel
    }

    private func targetDescription(for summary: ScreenTimeAppUsageSummary) -> String {
        switch summary.targetKind {
        case ScreenTimeShared.targetApplication:
            return "Exact approved app duration"
        case ScreenTimeShared.targetCategory:
            return "Exact approved iOS category duration"
        case ScreenTimeShared.targetWebDomain:
            return "Exact approved website duration"
        default:
            return "Exact approved selection duration"
        }
    }

    private func targetDescription(for milestone: ScreenTimeUsageEvent) -> String {
        switch milestone.targetKind {
        case ScreenTimeShared.targetApplication:
            return "Approved app target"
        case ScreenTimeShared.targetCategory:
            return "Approved iOS category target"
        case ScreenTimeShared.targetWebDomain:
            return "Approved website target"
        default:
            return "Approved selection total"
        }
    }

    private func format(seconds: Double) -> String {
        let totalMinutes = Int(seconds / 60)
        let hours = totalMinutes / 60
        let minutes = totalMinutes % 60
        if hours > 0 {
            return "\(hours)h \(minutes)m"
        }
        if totalMinutes > 0 {
            return "\(totalMinutes)m"
        }
        return "<1m"
    }
}
#endif
