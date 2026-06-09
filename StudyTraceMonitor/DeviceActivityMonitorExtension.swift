//
//  DeviceActivityMonitorExtension.swift
//  StudyTraceMonitor
//
//  DeviceActivityMonitor extension. iOS launches this extension (not the main
//  app) to deliver Screen Time monitoring callbacks for the apps the user
//  selected via FamilyActivityPicker. We record threshold crossings into the
//  shared App Group store; the main app drains them into AWARE storage for
//  upload to the research server.
//

import DeviceActivity
import Foundation

class DeviceActivityMonitorExtension: DeviceActivityMonitor {

    override func intervalDidStart(for activity: DeviceActivityName) {
        super.intervalDidStart(for: activity)
        // A new monitoring interval (day) has begun. Threshold events below
        // will fire as cumulative usage accrues during this interval.
    }

    override func intervalDidEnd(for activity: DeviceActivityName) {
        super.intervalDidEnd(for: activity)
    }

    /// Fired once when cumulative usage of the selected apps reaches the
    /// threshold associated with this event during the current interval.
    override func eventDidReachThreshold(_ event: DeviceActivityEvent.Name,
                                         activity: DeviceActivityName) {
        super.eventDidReachThreshold(event, activity: activity)

        let thresholdMinutes = Self.thresholdMinutes(from: event.rawValue)
        let record = ScreenTimeUsageEvent(
            event: event.rawValue,
            thresholdMinutes: thresholdMinutes,
            activity: activity.rawValue,
            timestamp: Date().timeIntervalSince1970 * 1000.0
        )
        ScreenTimeUsageStore.shared.append(record)
    }

    /// Event names are formatted as "<prefix>.<minutes>"; recover the minutes.
    private static func thresholdMinutes(from eventName: String) -> Int {
        if let last = eventName.split(separator: ".").last, let value = Int(last) {
            return value
        }
        return 0
    }
}
