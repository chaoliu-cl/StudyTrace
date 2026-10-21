//
//  StudyTraceTests.swift
//  StudyTraceTests
//
//  Created by Yuuki Nishiyama on 2019/02/27.
//  Copyright © 2019 Yuuki Nishiyama. All rights reserved.
//

import XCTest
import UserNotifications
import CoreLocation
import AWAREFramework
@testable import StudyTrace

class StudyTraceTests: XCTestCase {

    override func setUp() {
        // Put setup code here. This method is called before the invocation of each test method in the class.
    }

    override func tearDown() {
        // Put teardown code here. This method is called after the invocation of each test method in the class.
    }

    private var invitationURL: String {
        "https://study.example/index.php/webservice/index/study1/pi_" + String(repeating: "a", count: 64)
    }

    func testPersonalInvitationRequiresSecureExactStudyRoute() {
        XCTAssertNotNil(StudyInvitation(invitationURL + "?participant=P001"))
        XCTAssertEqual(StudyInvitation(invitationURL + "?participant=forged")?.studyURL, invitationURL)
        XCTAssertEqual(StudyInvitation(invitationURL)?.endpoint.absoluteString,
                       "https://study.example/api/v1/studies/study1/enrollment")
        XCTAssertNil(StudyInvitation(invitationURL.replacingOccurrences(of: "https:", with: "http:")))
        XCTAssertNil(StudyInvitation("https://study.example/index.php/webservice/index/study1/shared-password"))
        XCTAssertNil(StudyInvitation(invitationURL + "/locations/insert"))
        XCTAssertNil(StudyInvitation(invitationURL + "#fragment"))
        XCTAssertNil(StudyInvitation(invitationURL.replacingOccurrences(of: "study.example", with: "user:secret@study.example")))
    }

    func testAuthorizationIsBoundToStudyDeviceAndDeadline() {
        let now = Date()
        let record = ParticipantAuthorization(studyURL: invitationURL, deviceId: "phone-A",
            participant: "P001", consentVersion: "approved-v1", expiresAt: now.addingTimeInterval(60))
        XCTAssertTrue(record.permits(studyURL: invitationURL, deviceId: "phone-A", now: now))
        XCTAssertFalse(record.permits(studyURL: invitationURL, deviceId: "phone-B", now: now))
        XCTAssertFalse(record.permits(studyURL: invitationURL + "other", deviceId: "phone-A", now: now))
        XCTAssertFalse(record.permits(studyURL: invitationURL, deviceId: "phone-A", now: record.expiresAt))
        XCTAssertFalse(record.permits(studyURL: invitationURL, deviceId: "phone-A", now: now.addingTimeInterval(61)))
    }

    func testAuthorizationRejectsMissingExpiredAndExcessiveDeadlines() throws {
        let invitation = try XCTUnwrap(StudyInvitation(invitationURL))
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        func response(_ date: Date) throws -> Data {
            try JSONSerialization.data(withJSONObject: ["participant": "P001", "consent_version": "v1", "expires_at": formatter.string(from: date)])
        }
        XCTAssertNotNil(ParticipantAuthorization.parse(try response(Date().addingTimeInterval(3600)), invitation: invitation, deviceId: "phone-A"))
        XCTAssertNil(ParticipantAuthorization.parse(try response(Date().addingTimeInterval(-1)), invitation: invitation, deviceId: "phone-A"))
        XCTAssertNil(ParticipantAuthorization.parse(try response(Date().addingTimeInterval(29 * 86400)), invitation: invitation, deviceId: "phone-A"))
        XCTAssertNil(ParticipantAuthorization.parse(Data("{}".utf8), invitation: invitation, deviceId: "phone-A"))
    }

    func testVerifiedAuthorizationPersistsInDeviceKeychainAndCanBeCleared() throws {
        ParticipantEnrollment.clear()
        defer { ParticipantEnrollment.clear() }
        let record = ParticipantAuthorization(studyURL: invitationURL, deviceId: "phone-A",
            participant: "P001", consentVersion: "approved-v1", expiresAt: Date().addingTimeInterval(3600))
        XCTAssertTrue(ParticipantEnrollment.storeAuthorization(record))
        let stored = try XCTUnwrap(ParticipantEnrollment.authorization())
        XCTAssertEqual(stored.studyURL, record.studyURL)
        XCTAssertEqual(stored.deviceId, record.deviceId)
        XCTAssertEqual(stored.expiresAt, record.expiresAt)
        ParticipantEnrollment.clear()
        XCTAssertNil(ParticipantEnrollment.authorization())
    }

    func testLocalConsentCannotStartSensorsWithoutVerifiedSignIn() {
        let previous = UserDefaults.standard.bool(forKey: StudyParticipationController.consentKey)
        defer { UserDefaults.standard.set(previous, forKey: StudyParticipationController.consentKey) }
        ParticipantEnrollment.clear()
        UserDefaults.standard.set(true, forKey: StudyParticipationController.consentKey)
        XCTAssertFalse(StudyParticipationController.hasConsent())
        StudyParticipationController.refreshCollectionState(fitbitPresenter: nil, createRemoteTables: false)
        XCTAssertEqual(AWARESensorManager.shared().getAllSensors().count, 0)
    }

    func testRejectedInvitationCannotGrantConsentOrStartCollection() {
        ParticipantEnrollment.clear()
        UserDefaults.standard.set(false, forKey: StudyParticipationController.consentKey)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [EnrollmentTestURLProtocol.self]
        ParticipantEnrollment.session = URLSession(configuration: config)
        defer {
            ParticipantEnrollment.session.invalidateAndCancel()
            ParticipantEnrollment.session = .shared
            EnrollmentTestURLProtocol.handler = nil
        }
        EnrollmentTestURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/v1/studies/study1/enrollment")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer pi_" + String(repeating: "a", count: 64))
            return (403, Data("{\"error\":\"consent not verified\"}".utf8))
        }
        let done = expectation(description: "Rejected sign-in finishes")
        ParticipantEnrollment.signIn(invitationURL) { message in
            XCTAssertNotNil(message)
            XCTAssertFalse(ParticipantEnrollment.isAuthorized)
            XCTAssertFalse(StudyParticipationController.hasConsent())
            XCTAssertEqual(AWARESensorManager.shared().getAllSensors().count, 0)
            done.fulfill()
        }
        wait(for: [done], timeout: 5)
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

    @MainActor
    func testLocationCallbackStoresWithoutATimerAndPreservesFixTime() {
        let sensor = makeLocationSensor()
        var rows: [[String: Any]] = []
        sensor.setSensorEventHandler { _, data in
            if let data = data { rows.append(data) }
        }
        let fixTime = Date(timeIntervalSince1970: 1_700_000_000)

        deliverLocations([locationFix(at: fixTime)], to: sensor)

        XCTAssertEqual(rows.count, 1, "A delivered fix must be stored during its callback with the 180-second configuration.")
        XCTAssertEqual((rows.first?["timestamp"] as? NSNumber)?.doubleValue,
                       fixTime.timeIntervalSince1970 * 1000)
    }

    @MainActor
    func testLocationCadenceUsesFixTimeAndRejectsDuplicatesAndOlderFixes() {
        let sensor = makeLocationSensor()
        var rows: [[String: Any]] = []
        sensor.setSensorEventHandler { _, data in
            if let data = data { rows.append(data) }
        }
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        let offsets: [TimeInterval] = [0, 60, 180, 180, -20, 360]

        deliverLocations(offsets.map { locationFix(at: start.addingTimeInterval($0)) }, to: sensor)

        XCTAssertEqual(rows.compactMap { ($0["timestamp"] as? NSNumber)?.doubleValue },
                       [0.0, 180, 360].map { start.addingTimeInterval($0).timeIntervalSince1970 * 1000 })
        XCTAssertEqual(sensor.lastLocation?.timestamp, start.addingTimeInterval(360))
    }

    @MainActor
    func testInvalidFixAndDisabledStorageDoNotConsumeASamplingSlot() {
        let sensor = makeLocationSensor()
        var rows: [[String: Any]] = []
        sensor.setSensorEventHandler { _, data in
            if let data = data { rows.append(data) }
        }
        let start = Date(timeIntervalSince1970: 1_700_000_000)

        deliverLocations([locationFix(at: start, accuracy: -1)], to: sensor)
        sensor.storage?.setStore(false)
        deliverLocations([locationFix(at: start)], to: sensor)
        XCTAssertTrue(rows.isEmpty)
        sensor.storage?.setStore(true)
        deliverLocations([locationFix(at: start)], to: sensor)
        deliverLocations([locationFix(at: start.addingTimeInterval(180), accuracy: -1),
                          locationFix(at: start.addingTimeInterval(181))], to: sensor)

        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual((rows.last?["timestamp"] as? NSNumber)?.doubleValue,
                       start.addingTimeInterval(181).timeIntervalSince1970 * 1000)
    }

    @MainActor
    func testLocationSaveAllAndZeroIntervalKeepDistinctDeliveredFixes() {
        for (interval, saveAll) in [(0.0, false), (180.0, true)] {
            let sensor = makeLocationSensor(interval: interval)
            sensor.saveAll = saveAll
            var rows: [[String: Any]] = []
            sensor.setSensorEventHandler { _, data in
                if let data = data { rows.append(data) }
            }
            let start = Date(timeIntervalSince1970: 1_700_000_000)
            deliverLocations([locationFix(at: start),
                              locationFix(at: start.addingTimeInterval(1)),
                              locationFix(at: start.addingTimeInterval(1))], to: sensor)
            XCTAssertEqual(rows.count, 2)
        }
    }

    @MainActor
    private func makeLocationSensor(interval: Double = 180) -> Locations {
        let sensor = Locations(awareStudy: AWAREStudy.shared(), dbType: AwareDBTypeSQLite)
        // The base storage accepts a write without disk or network I/O. The
        // sensor's public event handler observes each accepted location row.
        sensor.storage = AWAREStorage(study: nil, sensorName: "location-callback-test")
        _ = sensor.setSensingIntervalWithSecond(interval)
        return sensor
    }

    private func locationFix(at date: Date, accuracy: Double = 10) -> CLLocation {
        CLLocation(coordinate: CLLocationCoordinate2D(latitude: 40, longitude: -73),
                   altitude: 0, horizontalAccuracy: accuracy, verticalAccuracy: 10,
                   timestamp: date)
    }

    @MainActor
    private func deliverLocations(_ locations: [CLLocation], to sensor: Locations) {
        let delegate: CLLocationManagerDelegate = sensor
        delegate.locationManager?(CLLocationManager(), didUpdateLocations: locations)
    }

}

private final class EnrollmentTestURLProtocol: URLProtocol {
    static var handler: ((URLRequest) -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let handler = Self.handler, let url = request.url else { return }
        let (status, data) = handler(request)
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}
