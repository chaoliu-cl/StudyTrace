# StudyTrace App-Usage Screenshot Review Notes

Use this document as source text for App Store Connect review notes, IRB/support packets, and TestFlight reviewer instructions.

## Short App Review Note

StudyTrace is a research data collection app used by consenting study participants. It does not silently export Apple's Screen Time database or transmit Screen Time API data off device.

If a study needs app-usage context, StudyTrace uses a participant-driven screenshot workflow. The participant is prompted by a survey to open **Settings → Battery → View All Battery Usage**, take a screenshot, and upload that screenshot as a voluntary photo response. The secure research server may use OCR to extract app names, screen-time text, and battery percentages from the submitted image.

The screenshot workflow is consent-based, study-specific, and used only for approved research analysis. StudyTrace does not use these data for advertising, sale of data, or cross-app tracking.

## Data Collected When Enabled

Depending on the study protocol and participant response, the server may store:

- The uploaded Battery usage screenshot image.
- OCR text extracted from the screenshot.
- Parsed app names.
- Parsed screen-time text and normalized seconds when available.
- Parsed battery percentage when available.
- Extraction status, OCR method, confidence, and parse notes for quality review.
- Device/study identifiers needed to associate rows with the enrolled study.

## User-Facing Flow

1. Participant joins a study by secure HTTPS study URL or QR code.
2. Participant reviews the in-app consent screen.
3. If the study requests app-usage context, the participant receives a survey prompt.
4. The prompt instructs the participant to open Settings → Battery → View All Battery Usage.
5. The participant takes a screenshot and uploads it through the app as a photo answer.
6. The backend OCR pipeline extracts structured rows into `battery_usage_apps`.
7. Researchers review/export the derived rows from the researcher dashboard.

## TestFlight / App Review Demo Steps

Provide reviewers:

- A test study URL using HTTPS.
- A study password or QR code if needed.
- Instructions to open StudyTrace, join the study, agree to consent, and wait for or open the Battery screenshot survey.
- Steps to open iPhone Settings → Battery → View All Battery Usage, take a screenshot, and upload it as the survey photo response.
- Researcher dashboard URL and study credentials so reviewers can verify that uploaded screenshots and derived `battery_usage_apps` rows appear.

## Data Minimization Position

StudyTrace avoids private APIs and does not attempt to bypass Apple's Screen Time export restrictions. The participant intentionally submits the screenshot, and the screenshot is scoped to the Battery usage screen requested by the study protocol. Researchers should request this workflow only when app-level usage context is necessary for the approved study.
