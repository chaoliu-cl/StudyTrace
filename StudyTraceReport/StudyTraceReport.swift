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
                Text("No precise Screen Time usage available for the selected interval yet.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(configuration.summaries.enumerated()), id: \.offset) { _, summary in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(displayName(for: summary))
                            Text(targetDescription(for: summary))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 12)
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

    private func targetDescription(for summary: ScreenTimeAppUsageSummary) -> String {
        switch summary.targetKind {
        case ScreenTimeShared.targetApplication:
            return "App"
        case ScreenTimeShared.targetCategory:
            return "Category"
        case ScreenTimeShared.targetWebDomain:
            return "Website"
        default:
            return "Selection total"
        }
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
        let selectedApplicationTokens = loadSelectedApplicationTokenOrder()
        let selectedCategoryTokens = loadSelectedCategoryTokenOrder()
        var intervalStart = Date().timeIntervalSince1970 * 1000.0
        var intervalEnd = intervalStart
        var aggregateDuration: TimeInterval = 0
        var nextApplicationIndex = 0
        var nextCategoryIndex = 0

        for await deviceData in data {
            for await segment in deviceData.activitySegments {
                intervalStart = min(intervalStart, segment.dateInterval.start.timeIntervalSince1970 * 1000.0)
                intervalEnd = max(intervalEnd, segment.dateInterval.end.timeIntervalSince1970 * 1000.0)
                aggregateDuration += segment.totalActivityDuration

                for await categoryActivity in segment.categories {
                    let category = categoryActivity.category
                    let name = category.localizedDisplayName
                    var nestedApplicationDuration: TimeInterval = 0
                    var nestedPickups = 0
                    var nestedNotifications = 0
                    for await applicationActivity in categoryActivity.applications {
                        nestedApplicationDuration += applicationActivity.totalActivityDuration
                        nestedPickups += applicationActivity.numberOfPickups
                        nestedNotifications += applicationActivity.numberOfNotifications

                        let application = applicationActivity.application
                        let appName = application.localizedDisplayName
                        let bundleIdentifier = application.bundleIdentifier
                        let selectedApplicationIndex = application.token.flatMap { selectedApplicationTokens.firstIndex(of: $0) }
                        let applicationKey = selectedApplicationIndex.map { "selected-app-\($0)" }
                            ?? bundleIdentifier
                            ?? appName
                            ?? "app-\(nextApplicationIndex)"
                        let previousApplication = summariesByKey[applicationKey]
                        let applicationIndex: Int
                        if let selectedApplicationIndex = selectedApplicationIndex {
                            applicationIndex = selectedApplicationIndex
                        } else if let previousIndex = previousApplication?.targetIndex {
                            applicationIndex = previousIndex
                        } else {
                            applicationIndex = nextApplicationIndex
                            nextApplicationIndex += 1
                        }
                        let applicationLabel = appName?.isEmpty == false
                            ? appName!
                            : "App \(applicationIndex + 1)"
                        let now = Date().timeIntervalSince1970 * 1000.0

                        summariesByKey[applicationKey] = ScreenTimeAppUsageSummary(
                            targetKind: ScreenTimeShared.targetApplication,
                            targetIndex: applicationIndex,
                            targetLabel: applicationLabel,
                            appName: applicationLabel,
                            bundleIdentifier: bundleIdentifier,
                            durationSeconds: (previousApplication?.durationSeconds ?? 0) + applicationActivity.totalActivityDuration,
                            pickups: (previousApplication?.pickups ?? 0) + applicationActivity.numberOfPickups,
                            notifications: (previousApplication?.notifications ?? 0) + applicationActivity.numberOfNotifications,
                            intervalStart: intervalStart,
                            intervalEnd: intervalEnd,
                            timestamp: now
                        )
                    }
                    let categoryDuration = categoryActivity.totalActivityDuration > 0
                        ? categoryActivity.totalActivityDuration
                        : nestedApplicationDuration
                    let selectedIndex = category.token.flatMap { selectedCategoryTokens.firstIndex(of: $0) }
                    let key = selectedIndex.map { "selected-category-\($0)" } ?? name ?? String(categoryActivity.hashValue)
                    let previous = summariesByKey[key]
                    let index: Int
                    if let selectedIndex = selectedIndex {
                        index = selectedIndex
                    } else if let previousIndex = previous?.targetIndex {
                        index = previousIndex
                    } else {
                        index = nextCategoryIndex
                        nextCategoryIndex += 1
                    }
                    let fallback = "Category \(index + 1)"
                    let label = (name?.isEmpty == false) ? name! : fallback
                    let now = Date().timeIntervalSince1970 * 1000.0

                    summariesByKey[key] = ScreenTimeAppUsageSummary(
                        targetKind: ScreenTimeShared.targetCategory,
                        targetIndex: index,
                        targetLabel: label,
                        appName: label,
                        bundleIdentifier: nil,
                        durationSeconds: (previous?.durationSeconds ?? 0) + categoryDuration,
                        pickups: (previous?.pickups ?? 0) + nestedPickups,
                        notifications: (previous?.notifications ?? 0) + nestedNotifications,
                        intervalStart: intervalStart,
                        intervalEnd: intervalEnd,
                        timestamp: now
                    )
                }
            }
        }

        var summaries = summariesByKey.values.filter { $0.durationSeconds > 0 }.sorted {
            if $0.durationSeconds == $1.durationSeconds {
                return $0.targetLabel < $1.targetLabel
            }
            return $0.durationSeconds > $1.durationSeconds
        }
        if summaries.isEmpty && aggregateDuration > 0 {
            let now = Date().timeIntervalSince1970 * 1000.0
            summaries = [
                ScreenTimeAppUsageSummary(
                    targetKind: ScreenTimeShared.targetAggregate,
                    targetIndex: 0,
                    targetLabel: "Selected Screen Time total",
                    appName: "Selected Screen Time total",
                    bundleIdentifier: nil,
                    durationSeconds: aggregateDuration,
                    pickups: 0,
                    notifications: 0,
                    intervalStart: intervalStart,
                    intervalEnd: intervalEnd,
                    timestamp: now
                )
            ]
        }
        let resolvedLabels = summaries.compactMap { summary -> ScreenTimeResolvedLabel? in
            guard let appName = summary.appName?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !appName.isEmpty else { return nil }
            return ScreenTimeResolvedLabel(
                targetKind: summary.targetKind,
                targetIndex: summary.targetIndex,
                appName: appName,
                bundleIdentifier: summary.bundleIdentifier,
                source: "device_activity_category_report",
                updatedAt: summary.timestamp
            )
        }
        if !resolvedLabels.isEmpty {
            let existing = ScreenTimeUsageStore.shared.loadResolvedLabels()
            var merged = existing
            for label in resolvedLabels {
                merged[label.cacheKey] = label
            }
            ScreenTimeUsageStore.shared.saveResolvedLabels(Array(merged.values))
        }
        ScreenTimeUsageStore.shared.saveLatestReportSummaries(summaries)
        ScreenTimeUsageStore.shared.appendReportSummaries(summaries)
        return StudyTraceAppUsageReportConfiguration(generatedAt: Date(), summaries: summaries)
    }

    private func loadSelectedApplicationTokenOrder() -> [ApplicationToken] {
        guard let defaults = UserDefaults(suiteName: ScreenTimeShared.appGroupID),
              let data = defaults.data(forKey: ScreenTimeShared.applicationTokenOrderDataKey),
              let tokens = try? PropertyListDecoder().decode([ApplicationToken].self, from: data) else {
            return []
        }
        return tokens
    }

    private func loadSelectedCategoryTokenOrder() -> [ActivityCategoryToken] {
        guard let defaults = UserDefaults(suiteName: ScreenTimeShared.appGroupID),
              let data = defaults.data(forKey: ScreenTimeShared.categoryTokenOrderDataKey),
              let tokens = try? PropertyListDecoder().decode([ActivityCategoryToken].self, from: data) else {
            return []
        }
        return tokens
    }
}

@main
@available(iOS 16.0, *)
struct StudyTraceReportExtension: DeviceActivityReportExtension {
    var body: some DeviceActivityReportScene {
        StudyTraceAppUsageReportScene()
    }
}
