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

}
