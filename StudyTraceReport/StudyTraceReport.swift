//
//  StudyTraceReport.swift
//  StudyTraceReport
//

import DeviceActivity
import Foundation
import ManagedSettings
import SwiftUI

@available(iOS 16.0, *)
extension DeviceActivityReport.Context {
    static let studyTraceAppUsage = Self("StudyTrace App Usage")
}

@available(iOS 16.0, *)
struct StudyTraceAppUsageReportConfiguration {
    let generatedAt: Date
    let summaries: [ScreenTimeAppUsageSummary]
}

@available(iOS 16.0, *)
struct StudyTraceAppUsageReportView: View {
    let configuration: StudyTraceAppUsageReportConfiguration

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("StudyTrace Screen Time")
                .font(.headline)
            if configuration.summaries.isEmpty {
                Text("No app usage available for the selected interval yet.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(configuration.summaries, id: \.targetIndex) { summary in
                    HStack {
                        Text(displayName(for: summary))
                        Spacer()
                        Text(format(seconds: summary.durationSeconds))
                            .monospacedDigit()
                    }
                    .font(.footnote)
                }
            }
        }
        .padding()
    }

    private func displayName(for summary: ScreenTimeAppUsageSummary) -> String {
        if let name = summary.appName, !name.isEmpty {
            return name
        }
        return summary.targetLabel
    }

    private func format(seconds: Double) -> String {
        let minutes = Int(seconds / 60)
        let hours = minutes / 60
        let remainder = minutes % 60
        return hours > 0 ? "\(hours)h \(remainder)m" : "\(remainder)m"
    }
}

@available(iOS 16.0, *)
struct StudyTraceAppUsageReportScene: DeviceActivityReportScene {
    let context: DeviceActivityReport.Context = .studyTraceAppUsage
    let content: (StudyTraceAppUsageReportConfiguration) -> StudyTraceAppUsageReportView

    init() {
        self.content = { configuration in
            StudyTraceAppUsageReportView(configuration: configuration)
        }
    }

    func makeConfiguration(representing data: DeviceActivityResults<DeviceActivityData>) async -> StudyTraceAppUsageReportConfiguration {
        var summariesByKey: [String: ScreenTimeAppUsageSummary] = [:]
        var intervalStart = Date().timeIntervalSince1970 * 1000.0
        var intervalEnd = intervalStart

        for await deviceData in data {
            for await segment in deviceData.activitySegments {
                intervalStart = min(intervalStart, segment.dateInterval.start.timeIntervalSince1970 * 1000.0)
                intervalEnd = max(intervalEnd, segment.dateInterval.end.timeIntervalSince1970 * 1000.0)

                for await category in segment.categories {
                    for await application in category.applications {
                        let app = application.application
                        let name = app.localizedDisplayName
                        let bundleIdentifier = app.bundleIdentifier
                        let key = bundleIdentifier ?? name ?? String(application.hashValue)
                        let previous = summariesByKey[key]
                        let index = previous?.targetIndex ?? summariesByKey.count
                        let fallback = "App \(index + 1)"
                        let participantLabel = ScreenTimeUsageStore.shared.label(
                            for: ScreenTimeShared.targetApplication,
                            index: index,
                            fallback: fallback
                        )
                        let label = (name?.isEmpty == false) ? name! : participantLabel
                        let now = Date().timeIntervalSince1970 * 1000.0

                        summariesByKey[key] = ScreenTimeAppUsageSummary(
                            targetKind: ScreenTimeShared.targetApplication,
                            targetIndex: index,
                            targetLabel: label,
                            appName: name,
                            bundleIdentifier: bundleIdentifier,
                            durationSeconds: (previous?.durationSeconds ?? 0) + application.totalActivityDuration,
                            pickups: (previous?.pickups ?? 0) + application.numberOfPickups,
                            notifications: (previous?.notifications ?? 0) + application.numberOfNotifications,
                            intervalStart: intervalStart,
                            intervalEnd: intervalEnd,
                            timestamp: now
                        )
                    }
                }
            }
        }

        let summaries = summariesByKey.values.sorted {
            if $0.durationSeconds == $1.durationSeconds {
                return $0.targetLabel < $1.targetLabel
            }
            return $0.durationSeconds > $1.durationSeconds
        }
        ScreenTimeUsageStore.shared.appendReportSummaries(summaries)
        return StudyTraceAppUsageReportConfiguration(generatedAt: Date(), summaries: summaries)
    }
}

@main
@available(iOS 16.0, *)
struct StudyTraceReportExtension: DeviceActivityReportExtension {
    var body: some DeviceActivityReportScene {
        StudyTraceAppUsageReportScene()
    }
}
