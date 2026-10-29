# Mobile collection upgrade and iPhone audit — October 29, 2026

## What changed

1. New study QR codes use an HTTPS app invitation. Updated iPhones open the
   StudyTrace tab with the Study URL prefilled; participants review it and tap
   Update. The browser fallback has an Open StudyTrace button. Both in-app QR
   readers accept these invitations and the previous AWARE/HTTPS formats.
2. Survey photo questions (`esm_type: 14`) support choosing existing photos,
   taking pictures, adding/removing images, and multiple attachments. Android
   keeps private drafts when the camera/picker opens, including other answers.
   iOS preserves the questionnaire when returning from the picker. Photos are
   re-encoded to remove original EXIF/GPS metadata. Ten images per question are
   supported, with size limits displayed by the clients.
3. iOS screenshot activities select up to ten screenshots and upload them
   sequentially with a group id, index, count, and the original prompt deadline.
   Android screenshot questions use the same multi-photo survey control.
   Researcher media links and full-study ZIPs support every attachment.
4. Optional environment collection adds outdoor temperature (°C), cloud cover
   (%), WMO weather code, and solar radiation (W/m²) from Open-Meteo, using GPS
   rounded to 0.01°. Android additionally samples ambient light in lux when
   its light sensor and running location service are available. iOS lux is
   missing: outdoor model estimates are not indoor measurements.
5. Researcher setup appears first: participant invitation, survey scheduling
   and questions, screenshot schedules, environment settings. Stored data,
   sensor exports, health, and monitoring follow. The large Recent survey
   responses and Survey quality panels were removed. Both datasets remain
   available as CSV in Sensor coverage, including `survey_responses` in ZIPs.
6. Daily phone use, Battery screenshot app usage, and Screen Time activity
   remain separate because they measure different constructs (see below).

## Evidence from the live pilot

The audit queried Railway configuration and aggregate PostgreSQL counts without
changing study schedules, passwords, participant records, or uploaded data.

- `PUBLIC_BASE_URL` was `studytrace-production.up.railway.app`, without the
  HTTPS scheme. The AWARE configuration therefore returned invalid webservice
  and survey URLs. Android reconstructs its API base from its invitation, which
  helps explain the difference between platforms. The server now normalizes a
  bare host, and the Railway variable is corrected during deployment.
- `research_grp_pilot` had **five enrolled devices** at the audit snapshot.
  Two devices had uploaded Android device-state records; three enrolled devices
  had no device-state record. No iOS device-state or Apple device registration
  was present for this study. Earlier studies do contain iOS records. This
  confirms the current gap, but does not prove the three silent devices are all
  iPhones or establish their individual permissions/installation state.
- Older AWARE executors append literal JSON to a form body without escaping it.
  Standard form decoding converts `+` in base64 into spaces and splits survey
  text at `&`. The backend now preserves that legacy body, while updated iOS
  clients encode their forms correctly.
- Both old sensor executors treated an HTTP 4xx/5xx response without a transport
  error as a successful upload. They now require a successful HTTP status before
  advancing SQLite's cursor. Survey uploads split large photo batches into
  bounded requests; every part must succeed before the batch is acknowledged.
- AWARE's defaults restricted automatic sensor uploads to **Wi-Fi while
  charging, once an hour**. A one-time client migration enables 15-minute
  uploads on available connections without requiring charging. Later participant
  changes to those preferences remain available.
- AWARE replaced a zero replay cursor with the current time during storage
  initialization. A process restart after a failed recovery could therefore
  skip retained data. Zero now remains a valid replay cursor. At the first
  updated launch, retained sensor rows are replayed once, with server
  deduplication, and automatic local data cleaning is disabled for recovery.
- Survey answer queries did not recognize the `esm` table used by the iOS
  questionnaire controller. It is now included. SQLite ESM batches are ordered
  by answer time and include the complete final timestamp group, preventing a
  batch boundary from skipping sibling answers. The questionnaire now reuses
  the schedule plugin’s uploader, and consolidated survey/quality exports
  suppress identical answers mirrored into old iOS tables; raw exports retain
  their original records.
- The updated device-state record includes sync preferences, interval, pending
  upload count, and sensor count. Participant health flags missing device-state
  uploads and restrictive sync settings. Reopening the app immediately attempts
  sensor sync and flushes device-state telemetry.

The iPhone audit identifies concrete failure paths; it does not certify an
end-to-end upload from a physical pilot iPhone. Replaying can recover only data
still retained locally. Data never recorded or already deleted cannot be
reconstructed by this update.

## Why the three phone-use datasets are retained

| Dataset | Construct | Window and limitation |
| --- | --- | --- |
| `phone_use_daily` | Observed unlocks, unlock-to-lock session duration, session distribution, night use | Participant-local calendar day. On iOS, observations require StudyTrace to be running; it is not complete Apple Screen Time. No per-app names or notification totals. |
| `battery_usage_apps` | App on-screen time and battery-consumption percentage read from Battery screenshots | Selected Battery window, commonly rolling 24 hours. Not necessarily a calendar day. |
| `screen_time_activity` | Screen Time totals, pickups, notifications, and visible most-used apps | Screenshot's selected day or cumulative today-so-far window. Several screenshots can cover different portions of the same screen. |

They overlap in usage context but are not interchangeable. Keep source/window
columns and image references during analysis. Do not add repeated screenshot
totals or the pilot's cumulative morning/afternoon/evening snapshots together.

## Environment settings and interpretation

Environment collection is off until a researcher saves On. This avoids changing
an existing pilot's consented collection automatically. Enable only for a study
whose consent describes environment processing and the provider lookup.

`environment_measures` is a raw CSV export with explicit `source` and
`measurement_type`. Weather represents the newest recent GPS fix in each
incoming batch, at most once per device/UTC hour. Fixes older than 48 hours are
skipped. A failed provider request does not reject the GPS upload; a subsequent
location batch retries. Phone/location downtime leaves missing observations.
Android light is sampled at most every 15 minutes while its location service
runs; a missing light sensor produces an unavailable status.

Open-Meteo hourly solar radiation is in W/m² and represents modeled outdoor
sunlight, not lux at the participant's phone. Provider units and attribution
follow [Open-Meteo's documentation](https://open-meteo.com/en/docs).

## Validation

- Server deployment tests and the full PostgreSQL smoke suite pass. Added
  regressions cover the malformed public base URL, literal iPhone form bodies,
  Unicode and base64 preservation, every attachment's authenticated media URL,
  ZIP image files, `esm` response CSVs, export paging, app invitation URLs,
  dashboard order, environment access control, opt-in behavior, coordinate
  rounding, device/hour deduplication, and missing lux.
- **20 iOS simulator unit tests pass**, including wrapped invitations, rejection
  of an insecure nested URL, photo batches whose second request fails, retrying
  both parts, and preserving a zero recovery cursor across storage recreation.
- A Simulator UI check opened a `studytrace://join?url=...` invitation and
  visibly confirmed the Study URL field was populated in the StudyTrace tab.
- Android debug assembly, **35 JVM tests**, and lint pass. Android is version
  **1.0.2 (3)**. No Android device was connected during the audit.
- A real request to Open-Meteo using public New York City coordinates returned
  the expected weather fields and units. Automated weather ingestion tests use
  a mocked provider rather than participant coordinates.
- Both maintained AWARE patch scripts can be reapplied without changing the
  patched sources. CocoaPods reapplies them after `pod install`.

## Production deployment

The backend was deployed to Railway production on October 29, 2026, deployment
`e77c8741-bd98-44fc-8a76-0e5bc2a7882b`. `PUBLIC_BASE_URL` is now
`https://studytrace-production.up.railway.app`.

Read-only production verification returned HTTP 200 for health, status, the
researcher dashboard, app invitation fallback, Apple app association, study
summary, and response CSV. The live pilot exposed 50 consolidated survey
responses and 50 quality rows through Sensor coverage. The new dashboard
order and removal of the two oversized panels were verified in the served
HTML. No participant data or existing study schedules were changed, and
environment collection remains opt-in.

Android release signing is not configured in this workspace, so the prepared
APK is a development build, not a Play-uploadable release. An iOS device archive
is prepared separately through Xcode. Neither app has been published to a store
by deploying Railway.

## Mobile rollout and physical-device checks

Deploying the server does not replace apps already installed through TestFlight
or Google Play. Distribute the updated mobile builds through the study's normal
channel, then verify on a consenting test participant before interpreting the
pilot as repaired:

1. Update and reopen an iPhone while online. Confirm its Study URL starts with
   `https://`, then use the upload control. Check Participant health for fresh
   `device_state`, `client_events`, `locations`, and `plugin_device_usage` rows.
2. Scan a newly generated QR with the system Camera. Verify the Study URL is
   filled and the participant label survives. Also test the in-app scanner and
   Open StudyTrace fallback. Universal Link behavior additionally depends on
   the installed build's signed associated-domain entitlement and Apple's
   association cache. Custom study hosts use the fallback or in-app scanner.
3. Deliver a type-14 question on iPhone and Android. Select two library photos,
   add a camera photo, remove one, and submit. Verify all remaining attachments
   in the image ZIP and response CSV. Repeat with camera access denied, picker
   cancellation, and an expired prompt. A simulator does not validate a real
   camera or vendor-specific Android camera app.
4. Submit photos while offline; reopen online and verify they upload once.
   On Android, also rotate/recreate the activity while an external picker is
   open and confirm the private draft is restored. Leaving or switching studies
   must purge private drafts, camera files, environment settings, and uploads.
5. For screenshot activities, choose several images covering a scrolled app
   list. Confirm one prompt completion, all images retained, original deadline,
   and image/group identifiers. Inspect OCR review flags rather than treating
   unreadable screenshots as zero use.
6. Grant Always location and Background App Refresh on the test iPhone, then
   test foreground, screen lock, background, relaunch, and network recovery.
   iOS controls background execution; force-quitting prevents continuous
   sensing until the app is reopened. Heartbeat gaps must remain visible.
7. If enabled in the consented test study, check one weather row after a GPS
   upload and an Android lux reading on hardware with a light sensor. Confirm
   iOS lux stays missing and disabling environment collection stops new
   lookups after phone settings refresh.
