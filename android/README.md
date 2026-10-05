# StudyTrace Android

Native Android client for StudyTrace research data collection.

This app joins the same HTTPS StudyTrace/AWARE study URL used by the iPhone app,
then uploads Android data through the server's generic JSON API
(`POST /api/v1/studies/{STUDY_ID}/sensors/{sensor}/data`, authenticated with the
study password from the join URL as `Authorization: Bearer`).

## Participant experience and consent

Android now follows the same upfront onboarding pattern as the iPhone client:

1. About StudyTrace
2. Your Data
3. For Researchers
4. Informed Consent
5. Location permission
6. Android app-activity permission
7. Notifications
8. Welcome and study setup

The informed-consent page cannot be skipped. Declining records a no-consent
decision, stops any active collection, and prevents study enrollment until the
participant reopens onboarding and agrees. Agreement to the app-level
onboarding does not silently enroll the phone: the participant must still open
their study invitation, review the research team's study-specific consent,
check the enrollment consent box, and join successfully.

Onboarding appears on first launch until the participant makes a consent
decision. Reinstalling an APK over the existing app preserves that decision;
it does not replay onboarding. Participants can review all eight screens from
**Settings → Review onboarding and consent**.

The main interface has **Survey**, **Dashboard**, and **Settings** tabs. Settings
contains enrollment, permissions, collection controls, and withdrawal.
Participants can enter an invitation link or tap **Scan study QR code**. The
scanner accepts secure HTTPS, StudyTrace, and AWARE study links (including
scheme-less host/path QR codes). It displays the server and study for review,
then fills the invitation field; scanning alone never grants consent or joins
the study. QR scanning uses Google Play services on-device and does not require
a camera permission for StudyTrace. Current permission and collection states
are shown without implying that access has been granted.

The background-location and app-activity steps retain their full prominent
disclosures immediately before Android's system permission/settings screens.
App-launch and device-state telemetry is not recorded before upfront consent.

## Implemented collection

- `locations` from Android `LocationManager` in a foreground service.
- `android_app_usage`: per-app foreground time for each completed local
  calendar day, computed from `UsageStatsManager.queryEvents` resume/pause
  events and clipped at local midnight. Each day is uploaded once (never the
  partial current day), backfilling at most 7 days and not before the join
  day. Rows carry `date`, `timezone`, `package_name`, `app_label`,
  `foreground_seconds`, `launch_count`, `window_start`/`window_end`,
  `construct: "foreground_time"` and `dedupe_key`
  `android_usage:<date>:<package>`. These are not Battery screenshot rows and
  are not written to `battery_usage_apps`.
- `android_screen_events` (Android 9+): `screen_on`, `screen_off`, `lock` and
  `unlock` transitions, from which the server derives pickups and sessions.
- `plugin_ios_esm` survey rows in the AWARE ESM shape, including answered
  (`esm_status` 2), dismissed (1) and expired (3) prompts.
- `client_events` (`app_launch`, hourly `heartbeat`, `permission_changed`,
  `notification_delivered` / `notification_tapped` for survey compliance) and
  `device_state` snapshots. Every telemetry row has `timestamp`, `event_id`,
  `seq`, `timezone`, `utc_offset_minutes` and `platform: "android"`.

## Uploads and surveys

All collectors append to a persistent queue in the app's files directory.
`SyncWorker` (WorkManager, about every 15 minutes) drains it in batches of at
most 500 rows and retries on network errors, 408, 429 and 5xx responses. The
server dedupes rows by `dedupe_key`/`event_id`, so retries are safe.

Survey schedules come from `GET .../index.php/webservice/index/{STUDY_ID}/{PASSWORD}/esm/config`
and are cached for offline use. Each schedule `times` entry (or `hours` when
there are no times) becomes one prompt per local day, shifted by a
deterministic random offset of up to +/- `randomize` minutes and open until
`expiration` minutes after the scheduled slot (end of day when 0). Each prompt
is notified once, up to about 15 minutes late. Schedules without times never
notify. Battery and Screen Time screenshot prompts are iOS-only and skipped.

## Leaving a study

`Leave Study` asks whether the server should also delete this phone's uploaded
data, then stops collection, cancels prompts, clears the upload queue and local
survey state, clears the study settings, and posts
`/api/v1/studies/{STUDY_ID}/withdrawal`. When the phone is offline the request
is retried in the background with the original `withdrawn_at`.

## Build

Install JDK 17 and Android SDK platform 36, then run from the repository root:

```bash
./android/gradlew -p android :app:assembleDebug
./android/gradlew -p android :app:testDebugUnitTest :app:lintDebug
```

CI builds the debug APK, runs JVM tests and lint, and signs a release bundle
with a disposable CI-only key on every change that touches Android.

## Signed release bundle

Release tasks fall back to the debug signing configuration with a warning if
upload-key values are not set. To build a signed release bundle, supply all four
values as Gradle properties or environment variables outside the repository:

```bash
export STUDYTRACE_UPLOAD_STORE_FILE=/absolute/path/to/upload-key.jks
export STUDYTRACE_UPLOAD_STORE_PASSWORD='...'
export STUDYTRACE_UPLOAD_KEY_ALIAS='...'
export STUDYTRACE_UPLOAD_KEY_PASSWORD='...'
./android/gradlew -p android :app:bundleRelease
```

The resulting signed bundle is `android/app/build/outputs/bundle/release/app-release.aab`.
Enroll the application in Play App Signing and retain the upload keystore and
passwords in the institution's secrets manager. The Play Developer Account ID
is not a signing credential and must not be embedded in the application.

## Google Play review

- Use `https://liu-chao.site/StudyTrace/privacy/` for the Play privacy-policy field.
- Complete Data safety accurately for precise/approximate location, app activity,
  survey responses, device identifiers, device state/diagnostics, and deletion.
- Complete the background-location and location foreground-service declarations.
- Provide review videos showing the in-app disclosure, Android permission flow,
  persistent collection notification, and Stop Location Collection control.
- Declare whether each study is health-related in the Health apps declaration;
  health-related human-subjects research must use its approved informed-consent flow.

## Device setup

1. Install the debug APK on an Android device.
2. Complete the first-launch explanation and informed-consent flow. Location,
   app-activity, and notification permissions can be granted during onboarding
   or reviewed later from the main screen.
3. Paste the study URL returned by the StudyTrace server, for example:
   `https://YOUR-SERVER/index.php/webservice/index/pilot1/PASSWORD`.
   Links of the form `studytrace://join?url=<encoded study URL>` and AWARE
   `aware-ssl://` study links open the app with the URL filled in.
4. Review the study-specific consent, check the consent box, and tap
   `Join or refresh study`.
5. Grant location permission for GPS collection. On Android 11 and later, tap
   the button again to allow background ("all the time") location.
6. Open App Activity Access and enable StudyTrace when the study requires
   app-usage research data.
7. Tap `Start collection` when the study includes background location.

Android does not expose iOS Screen Time or Battery Usage screenshots. The
Android client uses `UsageStatsManager` instead and uploads its own
`android_app_usage` rows.
