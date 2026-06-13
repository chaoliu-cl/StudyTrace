//
//  StudyTraceTests.swift
//  StudyTraceTests
//
//  Created by Yuuki Nishiyama on 2019/02/27.
//  Copyright © 2019 Yuuki Nishiyama. All rights reserved.
//

import XCTest
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

}
