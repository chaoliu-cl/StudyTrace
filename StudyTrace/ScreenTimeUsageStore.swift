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

    public init(event: String, thresholdMinutes: Int, activity: String, timestamp: Double) {
        self.event = event
        self.thresholdMinutes = thresholdMinutes
        self.activity = activity
        self.timestamp = timestamp
    }
}

/// Append-only queue of usage events persisted in the shared App Group.
/// The extension only appends; the app drains (reads + clears).
public final class ScreenTimeUsageStore {
    public static let shared = ScreenTimeUsageStore()

    private let pendingKey = "studytrace.screentime.pending-events"
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
}
