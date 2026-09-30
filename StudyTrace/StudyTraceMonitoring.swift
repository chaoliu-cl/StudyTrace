//
//  StudyTraceMonitoring.swift
//  StudyTrace
//
//  Data-quality telemetry that lets researchers tell "the participant did
//  nothing" apart from "the app was not running": an hourly heartbeat,
//  launch reasons and gaps since the previous run, and a record of which
//  survey prompts were actually delivered (the compliance denominator).
//

import UIKit
import UserNotifications

enum StudyTraceHeartbeat {
    private static let lastHeartbeatKey = "com.studytrace.telemetry.last-heartbeat"
    private static let interval: TimeInterval = 60 * 60
    private static var timer: Timer?
    private static var launchedAt = Date()

    /// Starts the check timer. It fires while the app is running, including
    /// in the background when location updates keep StudyTrace alive, so gaps
    /// in heartbeats show when iOS suspended or killed the app.
    static func start() {
        guard timer == nil else { return }
        launchedAt = Date()
        let timer = Timer(timeInterval: 15 * 60, repeats: true) { _ in beatIfDue() }
        timer.tolerance = 60
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        beatIfDue()
    }

    /// Records a heartbeat if an hour has passed since the last one, and
    /// nudges the upload queue either way (to retry anything backed off).
    static func beatIfDue() {
        guard StudyParticipationController.hasConsent() else { return }
        let now = Date().timeIntervalSince1970
        let last = UserDefaults.standard.double(forKey: lastHeartbeatKey)
        if now - last >= interval - 60 {
            UserDefaults.standard.set(now, forKey: lastHeartbeatKey)
            StudyTraceTelemetry.recordEvent("heartbeat", metadata: [
                "pending_uploads": StudyTraceUploadQueue.shared.pendingCount,
                "minutes_since_launch": Int(Date().timeIntervalSince(launchedAt) / 60)
            ])
            StudyTraceTelemetry.flush()
        } else {
            StudyTraceUploadQueue.shared.drain()
        }
    }
}

enum StudyTraceSessionTracker {
    /// Why this process started and how long the app was silent before it.
    /// Must be computed before the launch itself records any telemetry.
    static func launchMetadata(launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> [String: Any] {
        let reason: String
        if launchOptions?[.location] != nil {
            reason = "location"
        } else if launchOptions?[.remoteNotification] != nil {
            reason = "remote_notification"
        } else if UIApplication.shared.applicationState == .background {
            reason = "background"
        } else {
            reason = "user"
        }
        var metadata: [String: Any] = ["launch_reason": reason]
        if let previous = StudyTraceTelemetry.lastEventAt() {
            metadata["previous_last_event_at"] = previous * 1000
            metadata["minutes_since_previous_event"] = Int((Date().timeIntervalSince1970 - previous) / 60)
        }
        return metadata
    }
}

enum StudyTraceNotificationAudit {
    private static let reportedKey = "com.studytrace.telemetry.reported-notifications"
    private static let lastScheduleSnapshotKey = "com.studytrace.telemetry.last-schedule-snapshot"
    private static let maxRemembered = 500

    /// AWARE's ESM scheduler puts the survey schedule_id in every prompt's
    /// userInfo; other notifications (reminders, system messages) have none.
    static func isSurveyPrompt(_ content: UNNotificationContent) -> Bool {
        return content.userInfo["schedule_id"] != nil
    }

    static func metadata(for notification: UNNotification) -> [String: Any] {
        let content = notification.request.content
        return [
            "notification_id": notification.request.identifier,
            "delivered_at": notification.date.timeIntervalSince1970 * 1000,
            "is_survey_prompt": isSurveyPrompt(content),
            "schedule_id": content.userInfo["schedule_id"] as? String ?? "",
            "thread": content.threadIdentifier,
            "title": content.title
        ]
    }

    /// Remember a notification already reported by the presented/tapped
    /// handlers, so the delivered-notification sweep does not repeat it.
    static func markReported(_ notification: UNNotification) {
        remember([key(for: notification)])
    }

    /// Logs prompts delivered while StudyTrace was not in the foreground.
    /// iOS only reports notifications still in Notification Center, so a
    /// prompt the participant swiped away before the next sweep is missed.
    static func reportDeliveredNotifications() {
        guard StudyParticipationController.hasConsent() else { return }
        UNUserNotificationCenter.current().getDeliveredNotifications { notifications in
            DispatchQueue.main.async {
                let reported = Set(UserDefaults.standard.stringArray(forKey: reportedKey) ?? [])
                var newKeys: [String] = []
                for notification in notifications.sorted(by: { $0.date < $1.date }) {
                    let notificationKey = key(for: notification)
                    guard !reported.contains(notificationKey) else { continue }
                    newKeys.append(notificationKey)
                    StudyTraceTelemetry.recordEvent("notification_delivered", metadata: metadata(for: notification))
                }
                remember(newKeys)
            }
        }
        reportScheduleSnapshotIfDue()
    }

    /// At most every 6 hours, record how many survey prompts are scheduled
    /// and when the next ones fire, so missing prompts can be told apart
    /// from prompts that were never scheduled.
    private static func reportScheduleSnapshotIfDue() {
        let now = Date().timeIntervalSince1970
        guard now - UserDefaults.standard.double(forKey: lastScheduleSnapshotKey) >= 6 * 3600 else { return }
        UserDefaults.standard.set(now, forKey: lastScheduleSnapshotKey)
        UNUserNotificationCenter.current().getPendingNotificationRequests { requests in
            let prompts = requests.filter { isSurveyPrompt($0.content) }
            let nextFires = prompts
                .compactMap { ($0.trigger as? UNCalendarNotificationTrigger)?.nextTriggerDate() }
                .sorted()
                .prefix(10)
                .map { $0.timeIntervalSince1970 * 1000 }
            StudyTraceTelemetry.recordEvent("notification_schedule_snapshot", metadata: [
                "pending_survey_prompts": prompts.count,
                "pending_notifications": requests.count,
                "next_survey_prompts_at": Array(nextFires)
            ])
        }
    }

    private static func key(for notification: UNNotification) -> String {
        return "\(notification.request.identifier)|\(Int(notification.date.timeIntervalSince1970))"
    }

    private static func remember(_ keys: [String]) {
        guard !keys.isEmpty else { return }
        var stored = UserDefaults.standard.stringArray(forKey: reportedKey) ?? []
        stored.append(contentsOf: keys.filter { !stored.contains($0) })
        UserDefaults.standard.set(Array(stored.suffix(maxRemembered)), forKey: reportedKey)
    }
}
