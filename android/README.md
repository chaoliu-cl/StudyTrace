# StudyTrace Android

Native Android client for StudyTrace research data collection.

This app joins the same HTTPS StudyTrace/AWARE study URL used by the iPhone app,
then uploads Android data through the server's generic JSON API
(`POST /api/v1/studies/{STUDY_ID}/sensors/{sensor}/data`, authenticated with the
study password from the join URL as `Authorization: Bearer`).

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

The repository has no Gradle wrapper. Either open the `android/` folder in
Android Studio, or install JDK 17, the Android SDK (platform 35) and Gradle 8.9
(the minimum for Android Gradle Plugin 8.7), then run from the repository root:

```bash
gradle -p android :app:assembleDebug
gradle -p android :app:testDebugUnitTest
```

CI builds the debug APK and runs the JVM unit tests on every pull request that
touches `android/` (`.github/workflows/android-build.yml`).

## Device setup

1. Install the debug APK on an Android device.
2. Paste the study URL returned by the StudyTrace server, for example:
   `https://YOUR-SERVER/index.php/webservice/index/pilot1/PASSWORD`.
   Links of the form `studytrace://join?url=<encoded study URL>` and AWARE
   `aware-ssl://` study links open the app with the URL filled in.
3. Check participant consent and tap `Join / Refresh Study`.
4. Grant location permission for GPS collection. On Android 11 and later, tap
   the button again to allow background ("all the time") location.
5. Open App Usage Permission and enable StudyTrace for app usage collection.
6. Tap `Start Location Collection`.

Android does not expose iOS Screen Time or Battery Usage screenshots. The
Android client uses `UsageStatsManager` instead and uploads its own
`android_app_usage` rows.
