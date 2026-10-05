# Data Safety draft — validate before submission

This is a code-derived draft, not a legal determination. Play Console answers
must match the deployed study servers, consent forms, retention rules, and every
study configuration users can receive through this build.

## Data collected by the Android client

| Play category | StudyTrace data | Purpose visible in code |
| --- | --- | --- |
| Location | Precise or approximate fixes, altitude, bearing, speed, accuracy, provider | Study/research app functionality |
| App activity | Package name, app label, foreground time, launch count | Study/research app functionality |
| App activity / device activity | Screen on/off and lock/unlock transitions | Study/research app functionality |
| User IDs / device IDs | Random StudyTrace device ID | Enrollment, deduplication, syncing |
| User content | Survey answers, including free text | Study participation |
| Device information | Model, Android version, time zone, permission state, power state | App functionality and reliability |
| Diagnostics / app interactions | Launches, heartbeats, notification delivery/taps, upload counts | App functionality and reliability |

The Android build does not include advertising SDKs and does not silently read
the content viewed or typed in other apps. It does not upload iOS Battery or
Screen Time screenshots.

## Security and control answers supported by the build

- Data is transmitted over HTTPS; cleartext traffic is disabled.
- App backups and device-to-device transfer of app data are disabled/excluded.
- Collection requires a server-confirmed study enrollment and participant consent.
- Location, Usage Access, and notifications remain controlled by Android settings.
- Participants can stop location collection and leave a study in the app.
- Leaving purges locally queued study data and offers a server deletion request;
  an offline request is retried.

## Decisions the publisher must confirm

- Whether data sent to an independently operated research institution counts as
  "shared" under Google's definitions or qualifies for a service-provider or
  user-initiated-action exception.
- Whether each category is optional or required for any study distributed through
  this listing.
- The production retention/deletion policy and whether legal research-retention
  duties limit deletion of previously uploaded records.
- Whether surveys collect health information, demographics, sexual orientation,
  political/religious beliefs, or other sensitive categories. Declare every
  category that any available study can request.
- Whether device/app activity is linked to a participant outside the random device ID.
