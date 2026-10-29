//
//  StudyTraceTests.swift
//  StudyTraceTests
//
//  Created by Yuuki Nishiyama on 2019/02/27.
//  Copyright © 2019 Yuuki Nishiyama. All rights reserved.
//

import XCTest
import UserNotifications
import AWAREFramework
@testable import StudyTrace

class StudyTraceTests: XCTestCase {
    func testAppUsageScreenshotAsksForTodayAndPreservesItsDeadline() {
        let kind = UsageScreenshotKind.appUsageToday
        XCTAssertEqual(kind.promptTrigger, "app_usage_screenshot")
        XCTAssertEqual(kind.uploadKind, "screen_time_activity")
        XCTAssertTrue(kind.steps.joined().contains("Today"))
        XCTAssertFalse(kind.steps.joined().contains("yesterday"))
        let delivered = Date(timeIntervalSince1970: 1_800_000_000)
        let prompt = UsageScreenshotPrompt(identifier: "morning", scheduleId: "usage", period: "morning",
            scheduledAt: delivered.addingTimeInterval(-300), deliveredAt: delivered,
            expiresAt: delivered.addingTimeInterval(3600))
        XCTAssertTrue(prompt.isOpen(at: delivered.addingTimeInterval(3599)))
        XCTAssertFalse(prompt.isOpen(at: delivered.addingTimeInterval(3600)))
        XCTAssertFalse(prompt.isOpen(at: delivered.addingTimeInterval(-1)))
    }


    func testSurveyDeadlineCountsFromDeliveryForEarlyAndLatePrompts() {
        let anchor = Date(timeIntervalSince1970: 1_800_000_000)
        for offset in [-120, -30, 30, 120] {
            let delivered = anchor.addingTimeInterval(TimeInterval(offset * 60 + 17 * 60))
            let deadline = ESMScheduleManager.studytraceDeadline(delivery: delivered, expirationMinutes: 60)
            XCTAssertEqual(deadline.timeIntervalSince(delivered), 3600)
            XCTAssertTrue(ESMScheduleManager.studytraceIsOpen(delivery: delivered, expirationMinutes: 60, now: deadline.addingTimeInterval(-0.001)))
            XCTAssertFalse(ESMScheduleManager.studytraceIsOpen(delivery: delivered, expirationMinutes: 60, now: deadline))
            XCTAssertFalse(ESMScheduleManager.studytraceIsOpen(delivery: delivered, expirationMinutes: 60, now: deadline.addingTimeInterval(1)))
        }
    }

    func testRandomDrawsAreStableAndVaryByParticipantAndDay() {
        let first = (1...14).map { ESMScheduleManager.studytraceOffset(seed: "P001|daily|2026-10-\($0)|11:00", range: 120) }
        let second = (1...14).map { ESMScheduleManager.studytraceOffset(seed: "P002|daily|2026-10-\($0)|11:00", range: 120) }
        XCTAssertTrue(first.allSatisfy { (-120...120).contains($0) })
        XCTAssertGreaterThan(Set(first).count, 1)
        XCTAssertNotEqual(first, second)
        XCTAssertEqual(first[0], ESMScheduleManager.studytraceOffset(seed: "P001|daily|2026-10-1|11:00", range: 120))
    }

    func testNotificationHoursUseLocalClockAndIncludeBoundary() {
        let calendar = Calendar.current
        let base = calendar.startOfDay(for: Date())
        for (hour, minute, allowed) in [(8, 59, false), (9, 0, true), (20, 59, true), (21, 0, true), (21, 1, false)] {
            let date = calendar.date(bySettingHour: hour, minute: minute, second: 0, of: base)!
            XCTAssertEqual(ESMScheduleManager.studytraceIsWithinWindow(date, start: "09:00", end: "21:00"), allowed)
        }
    }

    func testObservedDeliveryIsPersistedAndReopeningCannotExtendDeadline() {
        let key = "studytrace.esm.occurrences.v2"
        let defaults = UserDefaults.standard
        let previous = defaults.object(forKey: key)
        defer {
            if let previous = previous { defaults.set(previous, forKey: key) }
            else { defaults.removeObject(forKey: key) }
        }
        let identifier = "studytrace.esm.v2|timing-test|2026-10-28"
        defaults.set([identifier: ["id": identifier, "schedule_id": "timing-test", "status": "scheduled", "expiration": 60, "window_start": "", "window_end": ""]], forKey: key)
        let manager = ESMScheduleManager.shared()
        let delivered = Date()
        XCTAssertTrue(manager.studytraceRecordDelivery(identifier: identifier, at: delivered))
        // Simulates tapping/re-reporting the same notification half an hour later.
        XCTAssertTrue(manager.studytraceRecordDelivery(identifier: identifier, at: delivered.addingTimeInterval(1800)))
        XCTAssertTrue(manager.studytraceOccurrenceIsOpen(identifier, at: delivered.addingTimeInterval(3599)))
        XCTAssertFalse(manager.studytraceOccurrenceIsOpen(identifier, at: delivered.addingTimeInterval(3600)))
        XCTAssertFalse(manager.studytraceOccurrenceIsOpen(identifier, at: delivered.addingTimeInterval(4000)))
        manager.studytraceCompleteOccurrence(identifier)
        XCTAssertFalse(manager.studytraceOccurrenceIsOpen(identifier, at: delivered.addingTimeInterval(1)))
    }

    func testLateObservedDeliveryIsNotAnOpenSurvey() {
        let key = "studytrace.esm.occurrences.v2"
        let defaults = UserDefaults.standard
        let previous = defaults.object(forKey: key)
        defer {
            if let previous = previous { defaults.set(previous, forKey: key) }
            else { defaults.removeObject(forKey: key) }
        }
        let identifier = "studytrace.esm.v2|late-test|2026-10-28"
        defaults.set([identifier: ["id": identifier, "schedule_id": "late-test", "status": "scheduled", "expiration": 60, "window_start": "09:00", "window_end": "21:00"]], forKey: key)
        let late = Calendar.current.date(bySettingHour: 21, minute: 5, second: 0, of: Date())!
        let manager = ESMScheduleManager.shared()
        XCTAssertFalse(manager.studytraceRecordDelivery(identifier: identifier, at: late))
        XCTAssertFalse(manager.studytraceOccurrenceIsOpen(identifier, at: late.addingTimeInterval(1)))
    }

    func testResponseDurationCanExtendAcrossMidnight() {
        let delivered = Calendar.current.date(bySettingHour: 23, minute: 45, second: 0, of: Date())!
        XCTAssertTrue(ESMScheduleManager.studytraceIsOpen(delivery: delivered, expirationMinutes: 60, now: delivered.addingTimeInterval(59 * 60)))
        XCTAssertFalse(ESMScheduleManager.studytraceIsOpen(delivery: delivered, expirationMinutes: 60, now: delivered.addingTimeInterval(60 * 60)))
    }

    func testInvitationWrappersPopulateTheSecureStudyURL() {
        let controller = UIViewController()
        let invitation = "https://studytrace-production.up.railway.app/index.php/webservice/index/pilot/p%2Bass?participant=P%20001"
        var wrapped = URLComponents(string: "studytrace://join")!
        wrapped.queryItems = [URLQueryItem(name: "url", value: invitation)]
        XCTAssertEqual(controller.normalizedSecureStudyURL(wrapped.string!), invitation)
        wrapped = URLComponents(string: "https://studytrace-production.up.railway.app/join")!
        wrapped.queryItems = [URLQueryItem(name: "url", value: invitation)]
        XCTAssertEqual(controller.normalizedSecureStudyURL(wrapped.string!), invitation)
        wrapped.queryItems = [URLQueryItem(name: "url", value: "http://example.com/study")]
        XCTAssertNil(controller.normalizedSecureStudyURL(wrapped.string!))
        XCTAssertNil(controller.normalizedSecureStudyURL("studytrace://join"))
    }

    func testReplayCursorSurvivesStorageRecreation() {
        let sensor = "studytrace_test_replay"
        let key = "uploader_coredata_timestamp_marker_" + sensor
        let previous = UserDefaults.standard.object(forKey: key)
        defer {
            if let previous = previous { UserDefaults.standard.set(previous, forKey: key) }
            else { UserDefaults.standard.removeObject(forKey: key) }
        }
        UserDefaults.standard.set(0, forKey: key)
        let storage = SQLiteStorage(study: AWAREStudy.shared(), sensorName: sensor, entityName: "EntityESMAnswer")
        XCTAssertNotNil(storage)
        XCTAssertEqual(UserDefaults.standard.double(forKey: key), 0, "relaunch must not skip retained offline rows")
    }

    func testPhotoUploaderRequiresEveryHTTPAcknowledgement() throws {
        let study = AWAREStudy.shared()
        let previousURL = study.getURL() ?? ""
        defer { study.setStudyURL(previousURL); StudyTraceURLProtocol.handler = nil }
        study.setStudyURL("https://studytrace-test.invalid/index.php/webservice/index/test/secret?participant=P001")
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StudyTraceURLProtocol.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let uploader = QuickSyncExecutor(awareStudy: study, sensorName: "plugin_ios_esm")
        uploader.setValue(session, forKey: "session")
        var requests = 0
        StudyTraceURLProtocol.handler = { request in
            requests += 1
            XCTAssertEqual(request.url?.path, "/index.php/webservice/index/test/secret/plugin_ios_esm/insert")
            XCTAssertNil(request.url?.query, "participant query must not swallow the sensor path")
            return requests == 2 ? 503 : 200
        }
        // Each answer fits the request limit; together they require two requests.
        let largeAnswer = String(repeating: "a", count: 11 * 1024 * 1024)
        let body = try JSONSerialization.data(withJSONObject: [["timestamp": 1, "esm_user_answer": largeAnswer], ["timestamp": 2, "esm_user_answer": largeAnswer]])
        let rejected = expectation(description: "rejected second photo batch")
        uploader.sync(with: body) { result in
            XCTAssertEqual(result?["result"] as? Bool, false, "SQLite must not advance after a partial upload")
            XCTAssertEqual(requests, 2)
            rejected.fulfill()
        }
        wait(for: [rejected], timeout: 30)
        requests = 0
        StudyTraceURLProtocol.handler = { _ in requests += 1; return 201 }
        let retried = expectation(description: "both photo batches acknowledged on retry")
        uploader.sync(with: body) { result in
            XCTAssertEqual(result?["result"] as? Bool, true)
            XCTAssertEqual(requests, 2)
            retried.fulfill()
        }
        wait(for: [retried], timeout: 30)
    }

    override func setUp() {
        // Put setup code here. This method is called before the invocation of each test method in the class.
    }

    override func tearDown() {
        // Put teardown code here. This method is called after the invocation of each test method in the class.
    }

    func testNormalizedSecureStudyURLAcceptsSecureSchemes() {
        let viewController = UIViewController()

        XCTAssertEqual(
            viewController.normalizedSecureStudyURL("https://example.com/study"),
            "https://example.com/study"
        )
        XCTAssertEqual(
            viewController.normalizedSecureStudyURL("aware-ssl://example.com/study"),
            "https://example.com/study"
        )
        XCTAssertEqual(
            viewController.normalizedSecureStudyURL("aware://example.com/study"),
            "https://example.com/study"
        )
    }

    func testNormalizedSecureStudyURLRejectsInsecureOrInvalidSchemes() {
        let viewController = UIViewController()

        XCTAssertNil(viewController.normalizedSecureStudyURL("http://example.com/study"))
        XCTAssertNil(viewController.normalizedSecureStudyURL("ftp://example.com/study"))
        XCTAssertNil(viewController.normalizedSecureStudyURL("not a url"))
    }

    func testQRCodeScannerClassifiesESMScheduleJSONBeforeURL() {
        let scheduleJSON = """
        [
          {
            "schedule_id": "pilot_daily_checkin",
            "hours": [-1],
            "esms": [
              {
                "esm": {
                  "esm_type": 2,
                  "esm_title": "Current activity",
                  "esm_radios": ["Working", "Resting"],
                  "esm_trigger": "pilot_activity"
                }
              }
            ]
          }
        ]
        """

        XCTAssertEqual(QRCodeReaderViewController.classifyScannedContent(scheduleJSON), .json)
    }

    func testQRCodeScannerAcceptsPhotoAsESMQuestionType() {
        let scheduleJSON = """
        [
          {
            "schedule_id": "pilot_context_photo",
            "hours": [-1],
            "esms": [
              {
                "esm": {
                  "esm_type": 14,
                  "esm_title": "Context photo",
                  "esm_instructions": "Please take a photo of your current context.",
                  "esm_submit": "Next",
                  "esm_na": true,
                  "esm_trigger": "pilot_context_photo"
                }
              }
            ]
          }
        ]
        """

        XCTAssertEqual(QRCodeReaderViewController.classifyScannedContent(scheduleJSON), .json)
    }

    func testQRCodeScannerClassifiesStudyURLs() {
        XCTAssertEqual(
            QRCodeReaderViewController.classifyScannedContent("https://studytrace-production.up.railway.app/index.php/webservice/index/pilot/secret"),
            .url
        )
        XCTAssertEqual(
            QRCodeReaderViewController.classifyScannedContent("aware-ssl://studytrace-production.up.railway.app/index.php/webservice/index/pilot/secret"),
            .url
        )
        XCTAssertEqual(
            QRCodeReaderViewController.classifyScannedContent("studytrace-production.up.railway.app/index.php/webservice/index/pilot/secret"),
            .url
        )
    }

    func testQRCodeScannerNormalizesBareStudyURLCandidatesToHTTPS() {
        XCTAssertEqual(
            QRCodeReaderViewController.normalizedURLCandidate("studytrace-production.up.railway.app/index.php/webservice/index/pilot/secret"),
            "https://studytrace-production.up.railway.app/index.php/webservice/index/pilot/secret"
        )
        XCTAssertEqual(
            QRCodeReaderViewController.normalizedURLCandidate(" https://studytrace-production.up.railway.app/index.php/webservice/index/pilot/secret "),
            "https://studytrace-production.up.railway.app/index.php/webservice/index/pilot/secret"
        )
    }

    func testNotificationAuditRecognizesSurveyPrompts() {
        let prompt = UNMutableNotificationContent()
        prompt.userInfo = ["schedule_id": "studytrace_random_esm_survey"]
        XCTAssertTrue(StudyTraceNotificationAudit.isSurveyPrompt(prompt))

        let reminder = UNMutableNotificationContent()
        reminder.title = "StudyTrace stopped"
        XCTAssertFalse(StudyTraceNotificationAudit.isSurveyPrompt(reminder))
    }

    func testScreenshotParserReadsDurationsAndPercentages() {
        XCTAssertEqual(UsageScreenshotParser.durationSeconds(in: "1h 12m"), 4320)
        XCTAssertEqual(UsageScreenshotParser.durationSeconds(in: "1 hour 5 min"), 3900)
        XCTAssertEqual(UsageScreenshotParser.durationSeconds(in: "45m On Screen"), 2700)
        XCTAssertEqual(UsageScreenshotParser.durationSeconds(in: "1時間5分"), 3900)
        XCTAssertEqual(UsageScreenshotParser.durationSeconds(in: "45分"), 2700)
        XCTAssertNil(UsageScreenshotParser.durationSeconds(in: "9:41"), "status-bar clock is not a duration")
        XCTAssertNil(UsageScreenshotParser.durationSeconds(in: "Formula 1 Hub"))
        XCTAssertEqual(UsageScreenshotParser.percent(in: "21%"), 21)
        XCTAssertEqual(UsageScreenshotParser.percent(in: "12％"), 12)
        XCTAssertNil(UsageScreenshotParser.percent(in: "250%"))
    }

    func testScreenshotParserReadsBatteryRows() {
        let text = ["9:41", "BATTERY USAGE BY APP", "Instagram 21%", "1h 12m On Screen", "YouTube", "45m On Screen", "3m Background", "10%"]
            .joined(separator: "\n")
        let rows = UsageScreenshotParser.batteryRows(from: text)
        XCTAssertEqual(rows, [
            UsageScreenshotParser.AppRow(appName: "Instagram", seconds: 4320, percent: 21),
            UsageScreenshotParser.AppRow(appName: "YouTube", seconds: 2700, percent: 10)
        ])
        XCTAssertTrue(UsageScreenshotParser.isLikelyScreenshot(of: .battery, text: text))

        let japanese = ["アプリごとのバッテリー使用状況", "写真", "1時間5分", "12％"].joined(separator: "\n")
        XCTAssertEqual(UsageScreenshotParser.batteryRows(from: japanese),
                       [UsageScreenshotParser.AppRow(appName: "写真", seconds: 3900, percent: 12)])
    }

    func testScreenshotParserReadsScreenTimeActivity() {
        let text = ["9:41", "Screen Time", "Yesterday", "4h 32m", "MOST USED", "Instagram", "1h 10m", "YouTube", "48m",
                    "PICKUPS", "First Pickup 7:12 AM", "Total Pickups", "87", "NOTIFICATIONS", "Total Notifications", "142"]
            .joined(separator: "\n")
        let parsed = UsageScreenshotParser.activity(from: text)
        XCTAssertEqual(parsed.summary, UsageScreenshotParser.ActivitySummary(totalSeconds: 16320, pickups: 87, notifications: 142))
        XCTAssertEqual(parsed.apps.map { $0.appName }, ["Instagram", "YouTube"])
        XCTAssertEqual(parsed.apps.map { $0.seconds }, [4200, 2880])
        XCTAssertEqual(UsageScreenshotParser.dayOffsetHint(in: text), -1)
        XCTAssertTrue(UsageScreenshotParser.isLikelyScreenshot(of: .screenTimeActivity, text: text))
    }

}

private final class StudyTraceURLProtocol: URLProtocol {
    static var handler: ((URLRequest) -> Int)?
    override class func canInit(with request: URLRequest) -> Bool { return request.url?.host == "studytrace-test.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { return request }
    override func startLoading() {
        let status = Self.handler?(request) ?? 500
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{\"status\":true}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
