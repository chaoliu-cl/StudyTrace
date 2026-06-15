# StudyTrace Selected-App Screen Time Review Notes

Use this document as source text for App Store Connect review notes, Family Controls entitlement requests, IRB/support packets, and TestFlight reviewer instructions.

## Short App Review Note

StudyTrace is a research data collection app used by consenting study participants. Selected-app Screen Time / Family Controls is an optional study feature. It is requested only after the participant joins a study, reviews consent language, and separately grants Apple's Screen Time permission.

The Screen Time feature lets a participant choose the specific apps, websites, or app categories that may be included in the study. The app does not collect Screen Time data for unselected apps, does not use Screen Time data for advertising, does not sell participant data, and does not perform cross-app tracking. Data is uploaded only to the HTTPS study server configured for that participant's study.

StudyTrace requests selected-app Screen Time summaries because many research protocols need app-specific behavioral context. Broad Screen Time categories can combine apps with very different social, educational, entertainment, work, or communication meanings, which can make the data scientifically unusable for app-specific research questions. The selected-app design is privacy-limited because participants choose the exact apps to include, unselected apps are excluded, and only summary metrics are uploaded. Participants may decline Screen Time permission, omit apps/websites/categories from the selection, quit the study in app settings, or contact the study coordinator for withdrawal and deletion requests.

## Why Family Controls Is Needed

StudyTrace studies may examine relationships between daily context, survey responses, mobility, and voluntary device-use patterns. Apple's Screen Time APIs are the user-consented mechanism for this data. StudyTrace uses:

- `FamilyControls` so participants can choose the apps, websites, or categories that may be included.
- `DeviceActivityMonitor` for coarse usage milestones.
- `DeviceActivityReport` for local Screen Time report summaries when selected-app, website, or category summaries are explicitly enabled.

The app avoids non-public APIs and does not attempt to inspect app usage outside Apple's Screen Time permission flow.

## Data Minimization Position

StudyTrace limits selected-app collection to the apps the participant chooses for an approved study. This is the minimum useful level for protocols that ask app-specific questions, such as whether time in a particular social, communication, learning, or entertainment app relates to survey responses, mobility context, or daily routines.

Researchers should still avoid collecting more Screen Time data than the study needs:

1. Selected-app summaries are used when app-level behavioral context is required by the protocol.
2. Website/domain summaries are used only if web usage is part of the protocol.
3. Category summaries are available when the protocol can answer the research question without app-level detail.

Participants control the selection. StudyTrace does not silently enumerate all installed apps and does not collect unselected app usage.

## Data Collected When Screen Time Is Enabled

Depending on participant selection and Apple API availability, the app may upload:

- Target type: selected app, website, category, or aggregate selected usage.
- Participant-provided app label when Apple does not provide a useful display name.
- App display name or bundle identifier when Apple provides it through Screen Time reports.
- Usage duration summary.
- Pickup and notification counts when available.
- Reporting interval and timestamp.
- Device/study identifiers needed to associate rows with the enrolled study.

The app does not collect message contents, browser contents, screen recordings, keystrokes, contacts from selected apps, or data from apps/categories the participant did not select.

## User-Facing Flow

1. Participant joins a study by secure HTTPS study URL or QR code.
2. Participant reviews the in-app consent screen.
3. If the study requests Screen Time, the participant taps `Choose tracked apps`.
4. iOS displays Apple's Screen Time / Family Controls permission prompt.
5. Participant selects specific apps, websites, or categories.
6. If selected-app summaries are used, StudyTrace may ask for participant labels so the research dashboard can interpret the participant-selected items.
7. StudyTrace shows the Screen Time report view and uploads only the consented summary data.
8. Participant may quit the study from app settings and may contact the study coordinator for deletion or formal withdrawal requests.

## Suggested Entitlement Request Language

StudyTrace requests Family Controls entitlement for consent-based academic/research data collection. The app is not a parental-control, productivity-blocking, advertising, or tracking app. Participants voluntarily join a study, review consent language, grant Apple's Screen Time permission, and choose the specific apps, websites, or categories that may be included. Selected-app summaries are needed for studies where broad Screen Time categories are too coarse to answer the approved research question. Data is used only for the approved study and uploaded only to the configured HTTPS study server.

## TestFlight / App Review Demo Steps

Provide reviewers:

- A test study URL using HTTPS.
- A study password or QR code if needed.
- Instructions to open StudyTrace, join the study, agree to consent, and open the Screen Time card.
- Steps to tap `Choose tracked apps`, approve Screen Time permission, select one app, optionally label it, and view the generated Screen Time report.
- Researcher dashboard URL and study credentials so reviewers can verify that only selected Screen Time summary rows appear.

## If Apple Objects To Selected-App Export

If App Review objects to selected-app export, explain that app-level detail is scientifically necessary for the intended research protocols because broad categories merge apps with different meanings and behavioral contexts. If Apple still rejects selected-app summaries, category-level collection can remain as a fallback distribution mode:

- Category-level Screen Time summaries.
- Aggregate selected-use milestones.
- Participant surveys asking about app context when app-level detail is scientifically necessary.

This fallback preserves the research workflow while reducing privacy risk.
