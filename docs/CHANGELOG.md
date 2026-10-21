# Changes

## 1.0.0 build 13 — October 20, 2026

- Require a researcher-verified external adult consent record before issuing a personal participant invitation. The researcher/admin form records the participant code, approved consent version, signed date, secure consent-register reference, and verifying staff ID. Tokens use 256 bits of randomness; the server stores only hashes.
- Bind first activation atomically to one device, expire unused invitations after seven days, and limit collection to 28 days after activation. Shared study passwords no longer authorize participants. All AWARE, JSON ingestion, survey-config, and screenshot routes check active enrollment and device identity. Withdrawal and researcher revocation block access; stale withdrawal retries cannot revoke a newer enrollment.
- Keep the existing QR/paste workflow as passwordless study sign-in. Store verified access in the device Keychain, check status on foreground and periodically while running, enforce the local deadline, and gate sensors, study schedules, and queued/foreground uploads. No password creation or daily manual login is required. Remote revocation stops server acceptance immediately; offline cached access lasts at most to the original deadline.
- Fix AWARE interactive join to use a foreground network session, retain platform TLS certificate validation, reject malformed study configuration, and avoid printing invitation URLs in join transport errors. Both AWARE patches survive CocoaPods reinstalls.
- Add the repeatable, additive enrollment migration; existing research data is preserved. Deploy the server before distributing this client. Existing participants require individual invitations after staff consent verification; Android needs a corresponding activation flow before using the updated server.
- Update the combined Apple Review response with consent verification, IRB documentation, reviewer navigation, and the existing genuine build-11 physical-device background-location recording. Deployment, actual reviewer invitations, the hosted video URL, and confirmation of the revised consent's approved scope remain submission preparation steps.

Validation: all server deployment, data/dashboard, and enrollment tests pass; 20 iOS tests pass with Simulator code signing, including a real Keychain round trip. Local HTTPS end-to-end testing with an isolated synthetic study confirms successful sign-in, a persisted signed-in state after force-close/relaunch, and loss of access after server revocation and foregrounding. Signed iPhone Release build succeeds. The new access flow has not been deployed to the live server or tested there on a physical phone.

## 1.0.0 build 11 — October 20, 2026

- Save delivered location fixes during Core Location callbacks, with the configured three-minute sampling interval used as a rate limit. Background storage no longer depends on a timer firing while the app is suspended.
- Use the original fix timestamp and reject invalid, duplicate, or older fixes. Record callback receipt time and app state without duplicating coordinates in the audit log.
- Stop the location sensor's significant-change monitoring when the sensor stops.
- Clarify the mobility-history feature in the location permission descriptions.
- Preserve the AWARE fix through CocoaPods reinstalls. Four location regression tests were added; all 14 unit tests pass. The signed Release build passed physical-device validation: a native iPhone recording contains a fresh persisted background fix during a 5-minute 14-second background interval. Ten additional fresh background samples were confirmed outside the recording. The complete recording, validation facts, and App Review response draft are saved in `AppStoreAssets/AppReview/`.
