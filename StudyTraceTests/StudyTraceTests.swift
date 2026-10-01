//
//  StudyTraceTests.swift
//  StudyTraceTests
//
//  Created by Yuuki Nishiyama on 2019/02/27.
//  Copyright © 2019 Yuuki Nishiyama. All rights reserved.
//

import XCTest
import UserNotifications
@testable import StudyTrace

class StudyTraceTests: XCTestCase {

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


    func testStudyConsentDecodesServerPayload() {
        // Shape returned by GET {study URL}/consent (server/src/consent.js).
        let json = """
        {"ok": true, "consent": {"study_id": "pilot", "study_name": "Pilot", "version": 3,
         "published_at": "2026-10-01T12:00:00.000Z", "title": "Daily phone use",
         "sections": [{"key": "purpose", "heading": "Purpose of the research", "body": "To learn."},
                      {"key": "future_field", "heading": "Server heading", "body": "Text."}],
         "contact": {"name": "Dr. Example", "email": "research@example.edu", "phone": null},
         "ethics": {"board": "Example IRB", "protocol": "IRB-1"}}}
        """
        guard let consent = StudyConsentAPI.decode(Data(json.utf8)) else {
            return XCTFail("consent did not decode")
        }
        XCTAssertEqual(consent.studyId, "pilot")
        XCTAssertEqual(consent.version, 3)
        XCTAssertEqual(consent.contact.email, "research@example.edu")
        XCTAssertNil(consent.contact.phone)
        XCTAssertEqual(consent.ethics.protocol, "IRB-1")
        XCTAssertEqual(consent.sections.count, 2)
        XCTAssertEqual(StudyConsent.localizedHeading(for: consent.sections[1]), "Server heading",
                       "unknown sections fall back to the server's heading")
        XCTAssertNil(StudyConsentAPI.decode(Data("{\"ok\": true}".utf8)))
    }

    func testStudyConsentURLsAndStudyKeys() {
        let link = "https://study.example.edu/index.php/webservice/index/pilot/secret?participant=P001"
        XCTAssertEqual(StudyConsentAPI.consentURL(for: link)?.absoluteString,
                       "https://study.example.edu/index.php/webservice/index/pilot/secret/consent?participant=P001")
        XCTAssertNil(StudyConsentAPI.consentURL(for: "http://study.example.edu/index.php/webservice/index/pilot/secret"),
                     "consent is only fetched over HTTPS")
        XCTAssertEqual(StudyConsentStore.studyKey(for: link), "study.example.edu/pilot")
        XCTAssertEqual(StudyConsentStore.studyKey(for: "https://STUDY.example.edu/index.php/webservice/index/pilot/secret"),
                       "study.example.edu/pilot", "participant labels and host case do not make a different study")
        XCTAssertNotEqual(StudyConsentStore.studyKey(for: "https://study.example.edu:8443/index.php/webservice/index/pilot/secret"),
                          StudyConsentStore.studyKey(for: link), "a different server is a different study")
        XCTAssertNil(StudyConsentStore.studyKey(for: "https://study.example.edu/not-a-study"))
    }

}
