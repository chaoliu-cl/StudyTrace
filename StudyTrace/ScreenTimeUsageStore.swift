//
//  ScreenTimeUsageStore.swift
//  StudyTrace
//
//  Shared between the main app and the DeviceActivityMonitor extension via an
//  App Group. The monitor extension appends usage events as Screen Time
//  thresholds are crossed; the main app drains them into AWARE storage so they
//  are uploaded to the research server on the normal sync cycle.
//
//  This file is intentionally Foundation-only (no UIKit / AWAREFramework) so it
//  can compile into the app-extension target as well as the app.
//

import Foundation

/// Identifiers shared by the app and the DeviceActivityMonitor extension.
public enum ScreenTimeShared {
    /// App Group container shared by the app and the monitor extension.
    /// Must match the App Group entitlement on both targets.
    public static let appGroupID = "group.com.liuchao.studytrace"

    /// DeviceActivity names used when scheduling/monitoring.
    public static let activityName = "studytrace.selected.apps.daily"
    public static let eventNamePrefix = "studytrace.selected.apps.usage"
    public static let targetAggregate = "aggregate"
    public static let targetApplication = "app"
    public static let targetCategory = "category"
    public static let targetWebDomain = "web"
    public static let selectionDataKey = "studytrace.selected-app-usage.selection"

    /// Escalating cumulative-usage thresholds (in minutes). Each DeviceActivity
    /// event fires once when cumulative usage of the selected apps crosses the
    /// threshold within the monitoring interval, giving coarse usage buckets.
    public static let thresholdsMinutes: [Int] = [5, 15, 30, 60, 120, 240]
}

/// A single Screen Time usage record captured by the monitor extension.
public struct ScreenTimeUsageEvent: Codable {
    public let event: String          // DeviceActivity event name
    public let thresholdMinutes: Int  // cumulative threshold that was reached
    public let activity: String       // DeviceActivity activity name
    public let timestamp: Double       // ms since 1970 (AWARE convention)
    public let targetKind: String      // aggregate/app/category/web
    public let targetIndex: Int?       // stable index within the participant's selected tokens

    public init(event: String,
                thresholdMinutes: Int,
                activity: String,
                timestamp: Double,
                targetKind: String = ScreenTimeShared.targetAggregate,
                targetIndex: Int? = nil) {
        self.event = event
        self.thresholdMinutes = thresholdMinutes
        self.activity = activity
        self.timestamp = timestamp
        self.targetKind = targetKind
        self.targetIndex = targetIndex
    }

    public var targetLabel: String {
        guard targetKind != ScreenTimeShared.targetAggregate else {
            return "Selected apps total"
        }
        let number = (targetIndex ?? 0) + 1
        switch targetKind {
        case ScreenTimeShared.targetApplication:
            return "App \(number)"
        case ScreenTimeShared.targetCategory:
            return "Category \(number)"
        case ScreenTimeShared.targetWebDomain:
            return "Website \(number)"
        default:
            return "Selection \(number)"
        }
    }
}

public struct ScreenTimeAppLabel: Codable {
    public let targetKind: String
    public let targetIndex: Int
    public let label: String
    public let timestamp: Double

    public init(targetKind: String, targetIndex: Int, label: String, timestamp: Double) {
        self.targetKind = targetKind
        self.targetIndex = targetIndex
        self.label = label
        self.timestamp = timestamp
    }
}

public struct ScreenTimeAppUsageSummary: Codable {
    public let targetKind: String
    public let targetIndex: Int
    public let targetLabel: String
    public let appName: String?
    public let bundleIdentifier: String?
    public let durationSeconds: Double
    public let pickups: Int
    public let notifications: Int
    public let intervalStart: Double
    public let intervalEnd: Double
    public let timestamp: Double

    public init(targetKind: String,
                targetIndex: Int,
                targetLabel: String,
                appName: String?,
                bundleIdentifier: String?,
                durationSeconds: Double,
                pickups: Int,
                notifications: Int,
                intervalStart: Double,
                intervalEnd: Double,
                timestamp: Double) {
        self.targetKind = targetKind
        self.targetIndex = targetIndex
        self.targetLabel = targetLabel
        self.appName = appName
        self.bundleIdentifier = bundleIdentifier
        self.durationSeconds = durationSeconds
        self.pickups = pickups
        self.notifications = notifications
        self.intervalStart = intervalStart
        self.intervalEnd = intervalEnd
        self.timestamp = timestamp
    }
}

/// Append-only queue of usage events persisted in the shared App Group.
/// The extension only appends; the app drains (reads + clears).
public final class ScreenTimeUsageStore {
    public static let shared = ScreenTimeUsageStore()

    private let pendingKey = "studytrace.screentime.pending-events"
    private let appLabelsKey = "studytrace.screentime.app-labels"
    private let reportSummariesKey = "studytrace.screentime.report-summaries"
    private let defaults: UserDefaults?

    public init() {
        self.defaults = UserDefaults(suiteName: ScreenTimeShared.appGroupID)
    }

    /// Appends one usage event. Called from the monitor extension.
    public func append(_ event: ScreenTimeUsageEvent) {
        guard let defaults = defaults else { return }
        var events = loadRaw()
        events.append(event)
        if let data = try? JSONEncoder().encode(events) {
            defaults.set(data, forKey: pendingKey)
        }
    }

    /// Returns all pending events without removing them.
    public func loadRaw() -> [ScreenTimeUsageEvent] {
        guard let defaults = defaults,
              let data = defaults.data(forKey: pendingKey),
              let events = try? JSONDecoder().decode([ScreenTimeUsageEvent].self, from: data) else {
            return []
        }
        return events
    }

    /// Returns all pending events and clears the queue. Called by the app
    /// after the events have been handed to AWARE storage.
    public func drain() -> [ScreenTimeUsageEvent] {
        let events = loadRaw()
        defaults?.removeObject(forKey: pendingKey)
        return events
    }

    /// Clears any queued events without draining them into app storage.
    public func clear() {
        defaults?.removeObject(forKey: pendingKey)
    }

    public func saveAppLabels(_ labels: [ScreenTimeAppLabel]) {
        guard let defaults = defaults,
              let data = try? JSONEncoder().encode(labels) else { return }
        defaults.set(data, forKey: appLabelsKey)
    }

    public func loadAppLabels() -> [ScreenTimeAppLabel] {
        guard let defaults = defaults,
              let data = defaults.data(forKey: appLabelsKey),
              let labels = try? JSONDecoder().decode([ScreenTimeAppLabel].self, from: data) else {
            return []
        }
        return labels
    }

    public func label(for targetKind: String, index: Int, fallback: String) -> String {
        return loadAppLabels().first {
            $0.targetKind == targetKind && $0.targetIndex == index
        }?.label ?? fallback
    }

    public func appendReportSummaries(_ summaries: [ScreenTimeAppUsageSummary]) {
        guard let defaults = defaults, !summaries.isEmpty else { return }
        let existing = loadRawReportSummaries()
        let trimmed = Array((existing + summaries).suffix(500))
        if let data = try? JSONEncoder().encode(trimmed) {
            defaults.set(data, forKey: reportSummariesKey)
        }
    }

    public func loadRawReportSummaries() -> [ScreenTimeAppUsageSummary] {
        guard let defaults = defaults,
              let data = defaults.data(forKey: reportSummariesKey),
              let summaries = try? JSONDecoder().decode([ScreenTimeAppUsageSummary].self, from: data) else {
            return []
        }
        return summaries
    }

    public func drainReportSummaries() -> [ScreenTimeAppUsageSummary] {
        let summaries = loadRawReportSummaries()
        defaults?.removeObject(forKey: reportSummariesKey)
        return summaries
    }
}
