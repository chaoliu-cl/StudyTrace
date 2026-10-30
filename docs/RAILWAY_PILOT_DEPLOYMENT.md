# StudyTrace: complete Railway deployment and pilot configuration

Prepared October 30, 2026. This guide covers the three supplied questionnaires,
one evening screenshot notification, GPS, expanded weather, air pollution,
five environment context questions, and GPS-to-map green-space context.
Personal light and indoor exposure sensing are disabled for this protocol.

Deploying the backend makes the features available. Study-specific context and
map collection remain off until you enable them for the intended study. The
schedule is configured in the researcher dashboard, with an editable draft and
a previous-configuration backup. Terminal is optional for deployment and is
not required for questionnaire or screenshot configuration.

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
**Survey and screenshot schedules** editor, pilot preset button, and context/
green-space checkboxes are present. If the web page is stale, reload it before
saving settings.

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

## 6. Configure the three questionnaires and evening screenshot in the dashboard

No Terminal command, database edit, or new Railway variable is needed for this
step. Deploy the updated backend once, then use the researcher dashboard for
ongoing schedule changes.

### Load and review your study

1. Open `https://studytrace-production.up.railway.app/researcher/` (or your
   canonical custom domain). Enter the intended **Study ID** and its
   **researcher password**, then click **Load dashboard**.
2. Find **Survey and screenshot schedules**, directly below the participant
   join-link section. Existing questionnaires and screenshot tasks load into
   one list. Use **Download configuration JSON** to retain a dated copy before
   changing an ongoing pilot. These files contain schedules/questions, not
   participant responses or passwords.
3. For a new pilot, click **Load three-survey pilot preset**. This loads the
   supplied document-based PANAS-10, PSS-10, and MWQ, plus one evening screenshot
   task, into an **unsaved draft**. It replaces the draft list, including any
   extra Battery or Screen Time tasks; review before saving. If your pilot is
   already configured, edit its existing rows instead of reloading the preset.
4. Confirm **4 tasks · 4 intended notifications/day**. The default rows are:

| Task | Daily delivery mode | Random window | Response window |
| --- | --- | --- | --- |
| PANAS-10 | One random time daily within a window | 09:00–12:00 | 60 minutes |
| Perceived Stress Scale | One random time daily within a window | 13:00–16:00 | 60 minutes |
| Mind-Wandering Questionnaire | One random time daily within a window | 17:00–19:00 | 60 minutes |
| App-usage screenshots | One random time daily within a window | 19:15–20:45 | 60 minutes |

Each questionnaire is its own notification and appears once daily. Do not put
all three instruments into each row. With environment context enabled, the list
shows **10 + 5**, **10 + 5**, and **5 + 5** questions; the screenshot remains one
photo task. Do not append context questions manually.

### Customize each task

5. Click **Edit** beside a task. Set its **Task name**, **Delivery mode**,
   **Response window (minutes)**, **Start date**, **End date**, and notification
   title/message. Repeat for **all four rows** when setting study dates; dates
   belong to each task independently. Blank dates mean no date bound. The date
   picker uses your browser's locale; the saved list shows `MM-DD-YYYY`.
6. For random delivery, choose **One random time daily within a window**, then
   enter the start/end times. Windows must remain within one day, be between
   2 minutes and 6 hours wide, and use each phone's local clock. Keep the
   screenshot target at **19:15–20:45** for the before-21:00 protocol. Odd-minute
   widths round the last possible target inward by one minute.
7. For a test or a fixed protocol, choose **Fixed time(s)** and enter one or
   more comma-separated 24-hour times, such as `10:15, 11:15`. Each listed time
   creates a daily notification. **Randomized around listed times** instead
   draws within plus/minus the entered number of minutes around each time
   (maximum 180 minutes). The table always shows the resulting target windows
   and total notification count. No minimum spacing between tasks is enforced.
8. Expand **Delivery limits and schedule ID** if you need stricter bounds on
   new notifications. The times plus their randomization must fit those bounds.
   A delivered response may remain open after the limit. Schedule IDs remain
   stable when editing an existing row, to preserve occurrence history.
9. Expand a numbered question to edit its **Question title**, **Question text /
   instructions**, answer choices (one per line), or **Item ID in exports**.
   Choice, text, and photo questions are supported; existing advanced question
   fields are retained. Use **Move up**, **Move down**, or **Remove question**
   to change item order, or add a choice/text/photo question. **Import questions
   JSON** replaces only the selected task's questions and accepts the supplied
   question-only files. Templates append questions to the selected task.
   Preserve validated instruments' wording, order, recall periods, choices,
   and item IDs unless you deliberately revise the protocol and codebook.
10. **Add questionnaire**, **Add app-usage screenshot**, **Duplicate**, and
    **Remove** change the draft list. Removing a task stops its future schedule
    after phones refresh; existing responses/images are retained. Duplicate
    tasks add notifications, so check the total before saving. The app-usage
    screenshot row retains its native photo workflow; participants can select
    multiple screenshots on the updated apps. Existing Battery and yesterday's
    Screen Time tasks are listed separately and can be edited or removed there.

### Save, verify, and refresh phones

11. Click **Save all schedules**. This saves the entire displayed protocol
    together. Look for **All schedules saved**. A validation error leaves the
    saved configuration intact; correct the field and save again.
12. Click **Reload saved schedules**, then recheck all four rows, dates, counts,
    and question wording. Download the saved configuration for your study log.
    Reload discards unsaved edits, so export a draft first if you want to keep it.
13. If another browser window changed the schedules, your save is rejected.
    Download your draft, reload the latest configuration, reconcile the changes,
    then save. Environment-setting changes do not conflict with schedule saves.
14. Ask participants to open StudyTrace online and tap **Refresh surveys**.
    The backend stores configuration; phones download it and schedule local
    notifications. Railway does not need a cron job for these reminders. Test
    one iPhone and one Android before changing the real pilot's schedule.

For a short phone test, use a separate test study, set each row to **Fixed
time(s)**, and give the four tasks distinct future phone-local times with a
20–30 minute lead and at least 20 minutes between them. Set the screenshot time
before 21:00. After testing, restore the random preset or your exported intended
configuration and refresh both phones again. A successful dashboard save does
not establish that a phone received or uploaded a notification response.

### Backup, restore, and optional JSON import

Every successful dashboard save keeps **one previous schedule configuration**.
Click **Download previous saved configuration** to retain it. To restore it,
expand **Import, restore, and advanced configuration**, choose that downloaded
file (or paste its JSON), and click **Load JSON into draft** if pasting. Review
all rows, then **Save all schedules**. This restores schedules only; environment
settings, credentials, enrollment, and previously collected data are preserved.
The next save replaces the previous-version slot, so download backups you need
for longer-term history.

The same import area accepts `pilot-configuration.json` from the supplied setup
folder. It must contain all four schedule arrays, even if the two legacy arrays
are empty. Importing a file loads a draft automatically; it does not save to the
study until you click **Save all schedules**. For question-only files, use the
selected questionnaire's **Import questions JSON** instead.

The setup folder still includes `apply-pilot-configuration.mjs` for optional
advanced database workflows. Its use is unnecessary for ordinary configuration;
prefer the dashboard's validation, revision protection, and backup workflow.
The older `docs/studies/mind-body-pilot` guides describe different historical
protocols; follow this guide for the current four-notification pilot.

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

For schedule rollback, download the previous saved configuration in the
dashboard, import it into the draft, review, and **Save all schedules**, as
described in section 6. Retain dated configuration downloads for longer history.

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
