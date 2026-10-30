# StudyTrace: complete Railway deployment and pilot configuration

Prepared October 30, 2026. This guide covers the three supplied questionnaires,
one evening screenshot notification, GPS, expanded weather, air pollution,
five environment context questions, and GPS-to-map green-space context.
Personal light and indoor exposure sensing are disabled for this protocol.

Deploying the backend makes the features available. Study-specific context and
map collection remain off until you enable them for the intended study. The
schedule setup helper is a separate operation, with a dry-run and backup.

## 1. Understand the participant protocol

| Daily task | Random target window, each phone's local time | Questions with context enabled |
| --- | --- | --- |
| PANAS-10 | 09:00–12:00 | 10 instrument items + 5 context items |
| Perceived Stress Scale | 13:00–16:00 | 10 + 5 |
| Mind-Wandering Questionnaire | 17:00–19:00 | 5 + 5 |
| Today's app-usage screenshots | 19:15–20:45 | One photo task, multiple screenshots allowed |

These windows are the supplied editable defaults. Each questionnaire is sent
once daily, at its own notification. Enabling context adds 15 items per day:
40 questionnaire items total, plus the screenshot task. It adds no notifications
and does not attach context questions to the screenshot task. Original instrument
wording, item order, and answer choices remain intact. The final instrument item's
button leads to context, and the last context item submits the response.

The five study-specific context questions ask about:

1. Current setting: indoors, outdoors, vehicle, or other.
2. Current perceived noisiness, from very quiet to very noisy.
3. Current temperature sensation, from very cold to very hot.
4. Outdoor time in the past 60 minutes, in duration bands.
5. Outdoor green-space contact in the past 60 minutes, in duration bands.

They are optional, with a prefer-not-to-answer choice, and are not validated
psychometric scales. Perceived noise is self-report; no microphone audio or
calibrated decibel measurement is collected. Duration bands must not be treated
as exact minutes. Keep these items separate from original instrument scores.

The screenshot asks for TODAY's usage so far (iPhone Screen Time or Android
Digital Wellbeing). The planned target ends at 20:45; the delivery window ends
at 20:59. Operating-system restrictions can delay or suppress notifications.
The 60-minute response window can extend past 21:00. This is a new-notification
cutoff, not an upload deadline or a guarantee of exact visible delivery time.

## 2. Verify the existing Railway project

Your existing deployment is:

- Project: **empathetic-success**, ID `d66540d4-ee9a-4f5b-b331-5e06f1bb63e5`.
- Environment: **production**.
- Web service: **StudyTrace**.
- Database service: **Postgres**.
- Public origin: `https://studytrace-production.up.railway.app`.
- Repository: `chaoliu-cl/StudyTrace`, branch `main`.

Keep the existing services and database. Do not recreate/reset them to deploy
this update. In **StudyTrace → Settings**, verify the connected GitHub source
and branch. Keep the existing working root directory: both repository root and
`server` have maintained package/config files and use `npm start`. For a new
deployment, use repository root with `npm ci` and `npm start`.

In **StudyTrace → Variables**, verify:

| Variable | Value / instruction |
| --- | --- |
| `DATABASE_URL` | Reference `${{Postgres.DATABASE_URL}}`; keep the existing database |
| `ADMIN_TOKEN` | Keep your existing admin secret |
| `PUBLIC_BASE_URL` | `https://studytrace-production.up.railway.app`, or your working canonical HTTPS custom domain |
| `DEFAULT_STUDY_TIMEZONE` | Optional fallback such as `America/New_York`; phone-reported zones take precedence for local-date daylight |
| `PORT` | Railway supplies it; do not hard-code another port |

The base URL must include `https://`. Participant/researcher passwords belong
to individual studies, not these service variables. The environmental additions
need no new API key, cron job, volume, or database migration. Small map byte-range
requests go to the public ESA WorldCover S3 dataset. Data tables are created on
demand when records arrive; they are not database resets.

## 3. Deploy the backend

### Existing GitHub deployment (recommended)

1. Confirm the tested update is committed/pushed and merged into `main`.
2. Open **Railway → production → StudyTrace → Deployments**. A push to the
   linked branch normally triggers a build automatically. Check its commit SHA.
3. If auto-deploy is disabled, use the service's deployment action for the latest
   source commit. Redeploying an old deployment runs that old source again;
   select the intended new commit.
4. Set/retain healthcheck path **`/health`** and the existing 100-second timeout.
5. If variables/settings are staged, review and deploy those changes.
6. Wait for the new deployment to become Active/Successful, and check build/runtime
   logs. A failed build must be fixed before enabling study features.

The build installs `geotiff`, a maintained JavaScript GeoTIFF reader, in addition
to the existing dependencies. It reads small portions of historical map files
on the server; no GIS service or map database needs to be provisioned.

### Optional Terminal deployment

Use a clean checkout of the intended source. This Mac has local Xcode workspace
changes, so avoid uploading that entire dirty checkout unintentionally. To make
a separate deployment checkout, choose an unused directory:

```sh
cd /Users/chaoliu/Downloads/StudyTrace
git fetch origin
git worktree add --detach /Users/chaoliu/Downloads/StudyTrace-deploy origin/main
cd /Users/chaoliu/Downloads/StudyTrace-deploy
npm ci
npm test
railway login
railway status
railway up --project d66540d4-ee9a-4f5b-b331-5e06f1bb63e5 \
  --environment production --service StudyTrace
```

Skip `railway login` if already authenticated. Do not run `railway up --new`;
that would create a replacement service. After deployment:

```sh
railway deployment list --project d66540d4-ee9a-4f5b-b331-5e06f1bb63e5 \
  --environment production --service StudyTrace --limit 3
curl -fsS https://studytrace-production.up.railway.app/health
```

Health should return `{"ok":true}`. This confirms the web process, not phone
collection or a successful database write. Open `/researcher/` and confirm the
new context and green-space checkboxes are present. If the web page is stale,
reload it before saving settings.

## 4. Create a separate test study

1. Open `https://studytrace-production.up.railway.app/admin/` and authenticate
   with the existing `ADMIN_TOKEN`.
2. In **Create or update a study**, use an unused ID such as
   `pilot_schedule_test`, a study name, a participant password, and a separate
   researcher password of at least 12 characters. Set the study's fallback
   time zone if needed.
3. Save. When updating an existing real study, keep its study ID and leave its
   participant password unchanged so enrolled phones' URLs continue working.
4. Open `/researcher/`, enter the test study ID and its researcher password,
   and load the dashboard.

## 5. Enable environmental features for that study

In **Environment collection**, set:

- **Environment measures: On** (master control).
- **Include air pollution (Open-Meteo/CAMS): checked**.
- **Add five environment context questions to each questionnaire: checked**.
- **Include GPS-based green-space map context (ESA WorldCover): checked**.

Click **Save environment collection**, confirm the success message, reload,
and verify the selections remain on. Repeat deliberately for your real study
after testing. Saving this form preserves stored survey/screenshot schedules.
The backend settings API accepts researcher credentials and:

```json
{
  "enabled": true,
  "air_quality_enabled": true,
  "context_questions_enabled": true,
  "green_space_enabled": true
}
```

The endpoint is `PUT /api/v1/studies/YOUR_ID/environment-settings`, using
`x-researcher-password` and `Content-Type: application/json`. The GUI avoids
putting passwords in shell history. Participant credentials cannot edit settings.

The master must be on for context, maps, and provider enrichment. Do not append
the context items to the original questionnaire JSON yourself: the participant
configuration endpoint adds them at delivery-config time. Existing stored
instrument definitions remain unchanged, and refreshes do not duplicate items.

Personal light and indoor exposure sensing are off. The participant
`environment-config` endpoint's legacy `enabled` field is false specifically
to stop light collection in existing Android builds; `environment_enabled`
reports the backend master. This does not stop server-side weather/maps.
Android phones must refresh their cached settings. Historical/previously queued
lux records may remain in exports; identify them by their source.

## 6. Apply the three-questionnaire plus evening-photo schedule

The provided **StudyTrace-Pilot-Setup-2026-10-30** folder contains
`pilot-configuration.json`, three question-only JSON files, a codebook, and
`apply-pilot-configuration.mjs`. Keep them together.

The dashboard's ordinary ESM form currently saves only one schedule. Its random
app-usage preset creates three photo reminders per day. Therefore use the
provided helper for this exact three-instrument/one-photo protocol. Do not save
those two schedule forms afterward: they would replace this custom setup.
Viewing/exporting data, generating join links, and saving Environment collection
are safe. The older mind-body-pilot guides describe a different schedule.

On this Mac:

```sh
cd /Users/chaoliu/Downloads/StudyTrace
pilot_setup_dir="/Users/chaoliu/Downloads/StudyTrace-Pilot-Setup-2026-10-30"
pilot_study_id="pilot_schedule_test"

# Preview only; no database connection or live change.
node "$pilot_setup_dir/apply-pilot-configuration.mjs" --study-id "$pilot_study_id"
```

Add your real `--start-date MM-DD-YYYY --end-date MM-DD-YYYY` to preview and apply
commands, replacing the placeholders. Dates are inclusive. With no bounds, the
schedule continues until changed. Keep schedule IDs stable during a study.

For a quick test, add `--test-times` with four distinct future phone-local times
from 09:00 through 20:59, at least 20 minutes apart with a 20–30 minute lead.
The order is PANAS, PSS, MWQ, photo. For example, only if still in the future:

```sh
node "$pilot_setup_dir/apply-pilot-configuration.mjs" \
  --study-id "$pilot_study_id" --test-times 12:30,13:00,13:30,14:00
```

Apply the same options after previewing:

```sh
railway run --project d66540d4-ee9a-4f5b-b331-5e06f1bb63e5 \
  --environment production --service Postgres -- \
  node "$pilot_setup_dir/apply-pilot-configuration.mjs" \
  --study-id "$pilot_study_id" --apply
```

Add the identical `--test-times`/date options when applying a test/bounded
configuration. Omit `--test-times` to restore normal random targets. The original
JSON stays unchanged. Context is injected separately by the study setting, so
the helper correctly still validates 10/10/5 original items.

Run from the repository with Node 20+ and installed dependencies (`npm ci` if
needed). The Postgres service injects its existing `DATABASE_PUBLIC_URL` for this
local process. A private Railway database hostname is not reachable from this
Mac. If the public variable is unavailable/sealed, stop and resolve the intended
database access; the helper does not expose new networking or print secrets.

Before updating, the helper locks the exact study row and writes a local backup
of the four schedule fields in `backups/`. It preserves other settings, credentials,
enrollment, and collected data. It clears legacy Battery and yesterday's Screen
Time reminder arrays to avoid extra photo notifications. Keep the backup path.
The helper does not create studies or turn on environment features by itself.

## 7. Enroll and refresh the phones

In the researcher dashboard's **Participant join link** section, enter the
participant password and a unique participant ID, then generate the join link/QR.
Keep admin/researcher credentials separate from links sent to participants.

- **iPhone:** install the build with the recent collection fixes, complete
  consent, and scan the QR in StudyTrace's StudyTrace tab (or paste the Study
  URL). Join/refresh with the same URL. The cloud/up-arrow control starts a
  manual upload. Allow notifications, Always location, Precise Location, and
  Background App Refresh. Confirm automatic upload is on; Wi-Fi-only or
  charging-only settings can postpone transfers. Avoid force-quitting.
- **Android:** consent and use **Join or refresh study** in Settings. Grant
  precise/background location when offered, allow notifications, tap
  **Start collection**, then **Refresh surveys** and **Upload now** for testing.
  Confirm the ongoing collection notification and check background restrictions.

These server additions use existing radio-question/GPS support and do not need
a new mobile build specifically for this release. The earlier iPhone upload,
QR, and photo fixes still require an updated signed app; Railway cannot install
it. A local Xcode archive is not automatically a TestFlight release. Do not
uninstall to refresh, because unsynced local data can be lost.

Open the app online daily to refresh schedules and replenish pending iPhone
notifications. GPS is permission/provider/OS dependent, not a guaranteed precise
three-minute trace. GPS permission alone does not start Android collection.

## 8. Verify collection on one iPhone and one Android

1. Use the separate test study and future fixed test times. Refresh both phones
   after saving settings/schedules. Verify 15, 15, and 10 questionnaire items,
   followed by one separate photo task. Submit at least two screenshots.
2. Walk outside for 5–10 minutes, then upload. Confirm recent coordinates for
   each phone in `locations` CSV. A registered device or HTTP health response
   is not proof of GPS. Map lookup needs a reported accuracy of 100 m or better.
3. In **Sensor coverage**, download `survey_responses`. Context item triggers
   begin `studytrace_context_` and end `_v1`; five stable IDs distinguish setting,
   perceived noise, thermal sensation, outdoor time, and nature time. These are
   label/category answers, not calculated scores or decibels. Also inspect
   `survey_quality` for blank/missed responses.
4. Download `environment_measures`. Filter by `device_id` AND `source`:

| Source | What to check |
| --- | --- |
| `open_meteo` | Temperature, humidity, apparent temperature, wind, precipitation, cloud, weather code, solar radiation; at most once/device/UTC hour |
| `open_meteo_daylight` | `sunrise_at`, `sunset_at`, `daylight_duration_seconds`, `daylight_local_date`, `daylight_timezone`; first eligible location per local date/time zone |
| `open_meteo_air_quality` | Six pollutant concentrations in µg/m³ and separate US/EU AQI; at most once/device/UTC hour |
| `esa_worldcover` | `green_space_status`, natural vegetation/tree/crop/built/water percentages, map reference year, GPS accuracy, coverage; at most one usable result/device/15-minute period |
| `android_ambient_light` | Historical/queued light data only; refreshed clients should stop generating this stream |

5. Check timestamps and units using the full study ZIP's codebook. Provider time
   fields are epoch milliseconds UTC; daylight also provides the local date and
   zone. Precipitation zero is valid. Missing values remain missing.
6. Reapply normal random targets without `--test-times`, refresh phones, and
   observe a full day. Then repeat setup using your real study ID and real dates.

## 9. Interpret map and environmental data correctly

Map context uses **ESA WorldCover 2021 v200**, nominal 10 m classes. It is a
historical land-cover proxy, not current vegetation imagery, NDVI, accessible
park acreage, proof of a visit, or time spent in nature. The five context items
provide a complementary participant report.

The server rounds map centres to 0.001 degrees and calculates a 300 m circular
buffer. GPS accuracy and rounding error remain separate export fields. Areas
are weighted for latitude. Natural vegetation includes trees, shrubland,
grassland, wetlands, mangroves, moss/lichen (classes 10,20,30,90,95,100); cropland,
built-up land, and water are separate. Percentages use valid mapped buffer area
and are reported only with at least 90% valid coverage.

Poor/missing GPS accuracy, missing tiles, incomplete maps, or provider failures
must not be treated as zero greenery. A quality-only row can precede a usable
map result in the same 15-minute period if a later fix improves. Analyze usable
map records with `green_space_status=available`; do not count the earlier quality
row as a second exposure. Coordinates above 85° latitude are marked unsupported.

Weather, air, daylight, and map requests run independently; failures preserve
the original location upload and can retry on a later upload. Only newly uploaded
recent fixes (roughly 48 hours) are considered. Enabling a feature does not scan
historical stored GPS or fill every missing interval in a delayed batch.

Use source/time/quality fields when linking environmental context to survey
answers. The server does not claim a causal effect or automatically calculate
personal exposure doses. Where available, use notification/session identifiers;
older iOS answer rows may require cautious timestamp-based matching.

## 10. Troubleshooting and rollback

- **New controls absent:** verify Railway's active commit, then reload the page.
- **Context absent:** confirm master and context checkbox are on for the same
  study, refresh/rejoin the phones, and test an ordinary questionnaire rather
  than a screenshot task. Cached or already-open surveys may retain old items.
- **GPS absent:** check app build, consent/join URL, permissions, internet/sync,
  and Android Start collection. A server update cannot recover unrecorded data.
- **Weather/air/daylight missing:** check current GPS timestamps/coordinates and
  logs for `[environment] Weather`, `Air quality`, or `Daylight enrichment deferred:`.
- **Map missing:** check the map opt-in, GPS accuracy, status/coverage flags,
  and outbound HTTPS access to `esa-worldcover.s3.eu-central-1.amazonaws.com`.
  Logs use `[environment] Green space enrichment deferred:`. Network/decoding
  jobs are bounded; a busy or failed lookup retries later. No paid map service
  or global raster download should be provisioned to work around a transient error.
- **Old light rows:** refresh Android's settings; queued historical rows can
  still upload. Personal light is separate from outdoor solar radiation.

To stop the new context or map feature, uncheck it and save; refresh phones to
remove context from newly fetched questionnaires. Master Off stops provider
lookups and future injected items. Existing data remain stored.

For schedule rollback, preview the saved schedule backup, then apply it through
the same Postgres service. Replace the path with the exact printed backup:

```sh
node "$pilot_setup_dir/apply-pilot-configuration.mjs" \
  --study-id "$pilot_study_id" --restore-backup /absolute/path/BACKUP.json

railway run --project d66540d4-ee9a-4f5b-b331-5e06f1bb63e5 \
  --environment production --service Postgres -- \
  node "$pilot_setup_dir/apply-pilot-configuration.mjs" --study-id "$pilot_study_id" \
  --restore-backup /absolute/path/BACKUP.json --apply
```

Schedule rollback preserves other settings and collected data. It does not
remove an already-shown notification from a phone that has not refreshed.

For a backend rollback, use Railway's previous known-good deployment. If personal
light must stay off, first switch Environment measures Off and refresh Android:
the older backend's participant configuration could otherwise re-enable its
legacy light stream. Rollback does not delete collected records.

## Sources and data attribution

- [Railway GitHub/service deployment](https://docs.railway.com/services)
- [Railway variables and staged changes](https://docs.railway.com/variables)
- [Railway healthchecks](https://docs.railway.com/deployments/healthchecks)
- [Railway local commands with service variables](https://docs.railway.com/cli/run)
- [Open-Meteo weather variables](https://open-meteo.com/en/docs)
- [Open-Meteo/CAMS air-quality fields and attribution](https://open-meteo.com/en/docs/air-quality-api)
- [ESA WorldCover data, 2021 map, and attribution](https://esa-worldcover.org/en/data-access)
- [GeoTIFF reader](https://github.com/geotiffjs/geotiff.js)

Include the provider processing and new survey/map measures in your study's
participant information/consent. Export rows preserve source attribution.
