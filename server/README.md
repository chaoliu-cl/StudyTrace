# StudyTrace Server

A small, self-hostable data collection server for study/sensor data, designed
to deploy on [Railway](https://railway.app) with a managed PostgreSQL database
and hosted dashboards.

It stores time-series data in PostgreSQL and exposes it through two
interchangeable ingestion front-ends over the **same** storage:

- **AWARE protocol** — what the StudyTrace iOS client speaks out of the box
  (the app embeds `AWAREFramework` 1.14.x). Mounted at `/index.php/webservice/…`.
- **Generic JSON API** — a protocol-neutral REST interface for any other data
  source (a custom app, a logging script, another framework). Mounted at
  `/api/v1`.

This server is **one reference option, not a requirement.** Researchers are
free to:

- use this server with the StudyTrace app over the AWARE protocol,
- send data from any other client via the generic JSON API,
- or host their own AWARE-compatible server implementing the consent
  enrollment API. Participant sign-in requires that API over HTTPS.

Both front-ends are equivalent doors into the same per-sensor tables, so you
can mix them (e.g. collect from the app via AWARE and from a wearable bridge
via the generic API into the same study).

## Hosted interfaces

The Railway deployment now exposes three browser-facing interfaces in the same
service:

- `/participant/` — participant-facing onboarding page for the iPhone app
- `/researcher/` — study-scoped dashboard authenticated by study id + **researcher** password
- `/admin/` — global admin dashboard authenticated by `ADMIN_TOKEN`

Operational endpoints remain available too:

- `/health` — Railway health check
- `/status` — machine-readable service descriptor

## Server-managed survey delivery

Participants no longer need to scan a survey QR code for normal study use.
After a participant joins the study URL once, the AWARE join configuration
points the iPhone app to the study's hosted ESM schedule:

```
/index.php/webservice/index/{STUDY_ID}/{PERSONAL_TOKEN}/esm/config
```

Use `/researcher/` to create or update the study's notification schedules:

- `Fixed schedule` sends notifications at the listed 24-hour times, e.g.
  `09:30, 17:15`.
- `Randomized around listed times` sends each notification at a random offset
  within the configured randomization window around each listed time.
- `Expiration window` controls how long a survey remains valid after the
  scheduled time.
- `ESM survey notifications` schedule ordinary study survey prompts.
- `Battery screenshot notifications` schedule the photo-upload prompt for
  Settings → Battery → View All Battery Usage screenshots.
- Each section has its own question JSON. Use `esm_type: 14` for an in-survey
  photo question.

Existing participants pick up the schedule when the app starts/restarts its
collection state. For immediate testing after changing a schedule, ask the
participant to open the app once after deployment. QR-based ESM import remains
available as a fallback/debug workflow.

## Storage model

Each sensor gets its own Postgres table (`aware_<sensor>`), storing the
`study_id`, `device_id`, `timestamp`, and the full original JSON row as
`JSONB`. This preserves every field a client sends without per-sensor schemas
while keeping rows scoped to a study. Study and device metadata live in the
`studies` and `devices` tables.

### Deduplication

Every row also gets a `dedupe_key`, backed by a unique index on
`(study_id, device_id, dedupe_key)`, so retried uploads are stored once:

- Rows carrying an `event_id`, `upload_id`, or `dedupe_key` field use it as the
  key. The iOS app sets `event_id` on telemetry rows and `upload_id` (a SHA-256
  of the image) on Battery screenshots.
- Other rows (e.g. AWARE sensor batches) are keyed by a hash of their content,
  so an identical re-send is skipped.
- Insert responses report `inserted` and `duplicates`. A repeated screenshot
  upload returns `200` with `"duplicate": true` and the original OCR feedback.
- Rows stored before this change have no key and are left as they are.

## Data quality and compliance

The iOS app queues its own uploads (telemetry and screenshots) on disk and
retries them in the background. Each telemetry row carries a per-device
sequence number and the phone's IANA time zone. The `participant_health`
export and dashboard derive from this:

| Column | Meaning |
|--------|---------|
| `last_heartbeat` | Latest hourly heartbeat. The app sends one while it is running, so a long silence means iOS suspended or killed it. |
| `max_telemetry_gap_hours_24h` | Longest stretch with no telemetry in the last 24 hours. |
| `last_launch_reason` | `user`, `location`, `remote_notification`, or `background`. |
| `prompts_delivered_7d` | Distinct survey prompts the phone reported as delivered, presented, or tapped. Prompts swiped away before the app next ran may be missed. |
| `survey_sessions_7d` | Answered survey sessions (answers within 15 minutes count as one session). |
| `compliance_rate_7d` | `survey_sessions_7d / prompts_delivered_7d`, capped at 1. |
| `telemetry_missing_7d` | Rows lost in transit, from gaps in the sequence numbers. |
| `permission_changes_7d` | Permission changes, such as location Always → While Using. |
| `location_accuracy_authorization`, `background_refresh_status`, `timezone` | Latest device state. |

`location_daily_summary` groups fixes by the participant's **local** calendar
day, using the time zone the phone reported at the time of each fix. A device
that has not reported one yet falls back to the study's default time zone (set
`timezone` in `POST /admin/studies`), then `DEFAULT_STUDY_TIMEZONE`, then UTC.
`survey_quality` rows include `local_date` and `timezone` the same way.

## App-usage screenshots

Apple does not let apps export Screen Time, so studies ask participants to
upload screenshots. Two kinds are supported, each with its own notification
schedule in `/researcher/`:

| Kind | Screen | Export | Default |
|------|--------|--------|---------|
| Battery | Settings → Battery → View All Battery Usage | `battery_usage_apps` (per app: on-screen time and battery %) | on when a schedule is saved |
| Screen Time activity | Settings → Screen Time → See All App & Website Activity, one day | `screen_time_activity` (daily total screen time, pickups, notifications, plus most-used apps) | off until a schedule is saved |

Participant workflow on iPhone:

1. A scheduled notification opens a step-by-step guide to the right Settings
   screen.
2. The participant takes a screenshot and picks it in StudyTrace.
3. The phone reads it with on-device OCR (English, plus Japanese on iOS 16+).
   Participants do not see or edit the values. If the image does not look
   like the requested Settings screen, the app offers to choose another one.
4. StudyTrace uploads the screenshot with the recognized text (`ocr_text`) to
   `POST /api/v1/studies/{id}/usage-screenshots`, and the server extracts the
   app rows and totals (`extraction_method = provided_text`). Unclear
   screenshots are flagged `needs_review`, and the app asks the participant
   to retake them. Battery uploads report `usage_window = last_24_hours` (the
   instructions ask participants to keep that tab selected); Screen Time
   uploads report the day shown as `activity_date`. The re-encoded image
   carries none of the original file's metadata; the capture time is sent
   separately as `captured_at`.

Older app versions that showed a review screen send `confirmed_rows`; those
are still stored as-is with `extraction_method = participant_confirmed`.
Uploads with neither confirmed values nor text fall back to server OCR with
Tesseract; set `OCR_LANGUAGES` (e.g. `eng+jpn`) for non-English studies. The
legacy `/battery-screenshots` routes still accept Battery uploads.

Retired app-usage exports are hidden from the dashboards.

## Derived exports

All derived exports use the participant's local day (see time zones above)
and are listed under **Sensor coverage** in `/researcher/`:

| Export | Contents |
|--------|----------|
| `battery_usage_apps` | One row per app per Battery screenshot. |
| `screen_time_activity` | Daily totals and most-used apps per Screen Time screenshot. |
| `app_usage_combined` | App-level usage from every source with explicit `platform`, `construct` (`battery_on_screen_time`, `screen_time_app_total`, `foreground_time`), and `usage_window` columns. These constructs differ; filter before comparing. |
| `phone_use_daily` | Per participant-day, from lock/unlock events (iOS `plugin_device_usage`, Android `android_screen_events`): pickups, total use, session count and median length, share of sessions under a minute, long sessions, night use (00:00–05:00 local), first/last use. On iOS these events are recorded only while StudyTrace runs; check `participant_health` for gaps. |
| `location_daily_summary` | Daily mobility from GPS. |
| `survey_quality` | Per answer: status (answered/dismissed/expired), latency, local date, flags. |
| `participant_health` | Heartbeat, gaps, 7-day compliance, dismissed/expired surveys, telemetry loss, permissions, platform-specific checks. |

### Whole-study export

`GET /api/v1/studies/{id}/export.zip` (researcher password; add `?images=1`
to include photo and screenshot images) or the **Download full study export**
button returns one ZIP with:

- `raw/<table>.csv` for every uploaded table (all rows, paged), with photo
  answers replaced by `image:media/<file>` references;
- every derived export above, plus `devices.csv` and `withdrawals.csv`;
- `codebook.csv` describing every column of every file, and `README.txt`.

Admins can use `GET /admin/studies/{id}/export.zip`. ZIP64 is not used, so a
single export must stay under 4 GB.

### Survey question templates

The ESM schedule form offers optional templates from
`public/assets/survey-templates.json`: momentary pleasantness and energy,
stress, loneliness, a self-estimated phone-use item (to compare with logged
use), and a morning sleep diary adapted from the Consensus Sleep Diary. Each
lists its source. Nothing reaches participants until a researcher adds a
template and saves the schedule; confirm instruments with your IRB.

## AWARE protocol front-end

The subset the StudyTrace client calls:

| Client action        | Request                                                                 |
|----------------------|-------------------------------------------------------------------------|
| Join / get config    | `POST /index.php/webservice/index/{STUDY_ID}/{PERSONAL_TOKEN}` body `device_id=…` |
| Create sensor table  | `POST …/{STUDY_ID}/{PERSONAL_TOKEN}/{table}/create_table`                      |
| Insert data          | `POST …/{table}/insert` body `device_id=…&data=<JSON array>`            |
| Latest row (sync)    | `POST …/{table}/latest` body `device_id=…`                              |
| Clear table          | Disabled (returns 403). Personal ingestion credentials cannot authorize destructive table deletion. |

## Generic JSON API front-end

Protocol-neutral REST over the same storage. Ingestion authenticates with the
active, device-bound personal credential as a Bearer token (`Authorization: Bearer <personal-token>`)
or an `x-study-password` header. Deleting data requires the researcher password
(`x-researcher-password` or Bearer). Base: `/api/v1/studies/{STUDY_ID}`.

| Action        | Request                                                                              |
|---------------|--------------------------------------------------------------------------------------|
| Insert data   | `POST   /api/v1/studies/{id}/sensors/{sensor}/data` body `{ "device_id": "...", "rows": [ {...} ] }` |
| Latest row    | `GET    /api/v1/studies/{id}/sensors/{sensor}/latest?device_id=...`                  |
| Row count     | `GET    /api/v1/studies/{id}/sensors/{sensor}/count?device_id=...`                   |
| Clear data    | `DELETE /api/v1/studies/{id}/sensors/{sensor}/data?device_id=...` (researcher password) |
| Withdraw      | `POST   /api/v1/studies/{id}/withdrawal` body `{ "device_id": "...", "delete_data": true }` (called by the app) |
| Delete participant | `DELETE /api/v1/studies/{id}/participants/{device_id}` (researcher password; all tables) |

The insert body also accepts a bare JSON array of rows, or a single row object.
`device_id` may be given in the body, the `device_id` query param, or an
`x-device-id` header.

Example:

```bash
curl -X POST https://YOUR-APP.up.railway.app/api/v1/studies/pilot1/sensors/heartrate/data \
  -H "Authorization: Bearer pi_PERSONAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"device_id":"watch-1","rows":[{"timestamp":1719000000000,"bpm":62}]}'
```

## Architecture

- **Node.js + Express** — `src/appFactory.js` composes shared infra (health,
  admin, hosted dashboards) with the two front-end routers; `src/index.js`
  boots it.
- **`src/awareApi.js`** — AWARE protocol router.
- **`src/genericApi.js`** — generic JSON API router.
- **`src/db.js`** — PostgreSQL storage shared by both; tables created on demand.
- **`src/studyConfig.js`** — config returned to AWARE clients on join.
- **`public/`** — participant, researcher, and admin web interfaces.

## Deploy on Azure with CU Launch

CU Launch v1 requires a supported app at the repository root. The root
`package.json` declares Express directly, with no npm workspaces, and
`index.js` boots this existing server. The native clients and other repository
directories are not separate web services.

1. Publish the updated repository revision, then retry CU Launch preparation
   with the repository root as the app directory and Express as the app type.
2. Use Node.js 20 or newer, `npm ci` to install (or `npm ci --omit=dev` for
   production), and `npm start` to run. There is no compilation step. Keep
   `server/src/` and `server/public/` in the deployment artifact.
3. Provision a PostgreSQL database for the Azure deployment. Allow network
   access from the app and set `DATABASE_URL` to its PostgreSQL connection
   string. The server uses TLS and initializes its schema on startup.
4. Set `ADMIN_TOKEN` to a long random secret and `PUBLIC_BASE_URL` to the
   Azure deployment's public HTTPS URL, without a trailing slash. Configure
   these as platform environment variables, not repository files.
5. Let the platform supply `PORT`; the server listens on that port on all
   interfaces (default `3000` locally). Configure `/health` as the health
   check. Set `TRUST_PROXY_HOPS` to the number of trusted proxy hops in the
   institution's deployment (default `1`). The other optional variables in
   the Railway table below also apply to Azure.
6. Verify `/health`, `/status`, `/participant/`, `/researcher/`, and `/admin/`.
   `/status` must report `database: "configured"` before collecting data.
   Without `DATABASE_URL`, dashboards load in setup mode and data APIs return
   `503`; a successful `/health` alone does not confirm database readiness.
7. Provision a study through `/admin/` as described below and use its Azure
   HTTPS invitation URL to enroll participants in that deployment.

Use a separate database and Azure-specific environment variables to operate
Azure alongside Railway. Existing participants continue uploading to their
original invitation host; deploying Azure does not migrate them or their data.
Both `railway.json` files, the `server/` package, and the server implementation
are unchanged. Railway services rooted at either `/` or `/server` can keep
their existing settings.

## Deploy on Railway

The server lives in the `server/` subdirectory of the StudyTrace repo, so point
Railway at that directory.

### 1. Create the project

1. Push this repo to GitHub (`https://github.com/chaoliu-cl/StudyTrace`).
2. In Railway: **New Project → Deploy from GitHub repo →** select `StudyTrace`.
3. In the service **Settings → Source**, set **Root Directory** to `server`.
   Railway's Nixpacks builder auto-detects Node and runs `npm start`
   (see `railway.json`).

### 2. Add PostgreSQL

1. In the project: **New → Database → Add PostgreSQL**.
2. Railway injects a `DATABASE_URL` variable. In your service **Variables**,
   reference it (Railway usually links it automatically; if not, add
   `DATABASE_URL = ${{ Postgres.DATABASE_URL }}`).

### 3. Set environment variables

On the service **Variables** tab:

| Variable          | Required | Description                                                                 |
|-------------------|----------|-----------------------------------------------------------------------------|
| `DATABASE_URL`    | yes      | Provided by the Postgres plugin.                                            |
| `ADMIN_TOKEN`     | yes      | A long random secret. Required to provision studies via the admin endpoint. |
| `PUBLIC_BASE_URL` | recommended | Your public Railway URL, e.g. `https://studytrace-production.up.railway.app`. Used to build the study URL returned to clients. If unset, it is derived from request headers. |
| `PORT`            | no       | Railway sets this automatically.                                            |
| `TRUST_PROXY_HOPS` | no      | Number of reverse-proxy hops in front of the server (default `1`, correct for Railway). Used to read the real client IP for login rate limiting. |
| `AUTH_FAILURE_MAX` / `AUTH_FAILURE_WINDOW_MS` | no | Failed-login limit per IP (default 30 per 900000 ms). |
| `DEFAULT_STUDY_TIMEZONE` | no | IANA time zone for local-day summaries when neither the phone nor the study has one (default `UTC`). |
| `OCR_LANGUAGES` | no | Tesseract languages for server-side screenshot OCR, e.g. `eng+jpn` (default `eng`). Only used when a screenshot arrives without phone-recognized text or participant-confirmed values. |

### 4. Generate a public domain

In **Settings → Networking → Public Networking**, click **Generate Domain**.
Use that HTTPS URL as `PUBLIC_BASE_URL`.

> The StudyTrace app enforces HTTPS (App Transport Security). Railway-generated
> domains are HTTPS, so they satisfy this out of the box.

### 5. Optional: add a custom domain

You can use your personal domain with Railway. A subdomain is the cleanest
choice because the root domain `liu-chao.site` already hosts your personal
site. Recommended production URL:

```
https://studytrace.liu-chao.site
```

In Railway:

1. Open the StudyTrace web service.
2. Go to **Settings → Networking → Public Networking**.
3. Click **+ Custom Domain**.
4. Enter `studytrace.liu-chao.site`.
5. Railway will show a `CNAME` record and a verification `TXT` record.
6. In your DNS provider for `liu-chao.site`, add both records exactly as shown.
7. Wait for Railway to verify the domain and issue SSL.
8. Set `PUBLIC_BASE_URL` to `https://studytrace.liu-chao.site`.
9. Redeploy or restart the service so generated study URLs use the custom domain.

Keep `https://studytrace-production.up.railway.app` active as a fallback until
the custom domain verifies. If you meant `liu-cha.site` instead of
`liu-chao.site`, confirm that domain is registered first and use
`studytrace.liu-cha.site` in the same workflow.

### 6. Verify it's up

```
curl https://YOUR-APP.up.railway.app/health
# {"ok":true}
```

Open these pages after deploy:

- `https://YOUR-APP.up.railway.app/participant/`
- `https://YOUR-APP.up.railway.app/researcher/`
- `https://YOUR-APP.up.railway.app/admin/`

After custom-domain verification, also check:

- `https://studytrace.liu-chao.site/health`
- `https://studytrace.liu-chao.site/participant/`
- `https://studytrace.liu-chao.site/researcher/`
- `https://studytrace.liu-chao.site/admin/`

## Provision a study

The administrator provisions a study with a researcher password (minimum 12
characters). The existing `password` provisioning field remains for schema/API
compatibility, but **shared study passwords no longer authorize participants**
and provisioning never returns a shared join QR. Researcher passwords are scrypt
hashes. Personal invitation tokens are cryptographically random 256-bit secrets;
only their SHA-256 hashes are stored on the server.

```bash
curl -X POST https://YOUR-APP/admin/studies \
  -H "Content-Type: application/json" -H "x-admin-token: $ADMIN_TOKEN" \
  -d '{"study_id":"pilot1","password":"unused-legacy-secret","researcher_password":"a-different-long-secret","name":"StudyTrace Pilot"}'
```

Existing participant data is preserved by the additive migration in
`migrations/20261021_consent_enrollment.sql`, applied idempotently at server boot.
There is no automatic consent backfill: existing installations need a personal
invitation after staff verify their external consent. Deploy the server before
releasing iOS build 13, coordinate that change with existing participants, and
retain database backups. Older clients cannot use shared credentials afterward.
Android clients need a corresponding activation flow before using this server.

## Consent verification and passwordless participant sign-in

1. Collect adult study-specific consent through the approved external process.
   Keep signed forms and identity/code keys in the separate secure consent
   register. This app does not claim the generic onboarding choice is a signed
   study-specific consent form.
2. In `/researcher/`, load the study with its researcher password. Under
   **Consent verification and participant sign-in**, enter the participant code,
   approved consent version, secure consent-register reference, signed date, and
   verifying staff ID; confirm that completed adult consent was checked.
3. **Issue personal invitation**. Privately give that participant the returned
   QR or HTTPS link. It can first activate for seven days, binds atomically to
   the first device, and permits retries from that device without extending the
   deadline. The plaintext cannot be retrieved later; revoke a lost invitation
   and issue another. The `participant` URL query is only a display label; the
   server's verified consent record determines the identity.
4. Participant: Study tab → **Study sign-in** to paste the link, or tap the QR
   icon, scan the QR, and tap **Sign in to study**. The first sign-in requires
   internet. The server verifies the invitation before AWARE study configuration
   is joined or collection starts. Grant the requested study permissions,
   including Always location access for background mobility collection. The
   verified authorization is saved in this device's Keychain; daily passwords
   and repeated manual sign-ins are unnecessary.
5. Research collection ends 28 days after activation. The app schedules a local
   deadline and checks it at collection/upload entry points and relaunch. The
   server rejects expired data credentials on every route. Status is refreshed
   on foreground and every 15 minutes while the process runs. Offline cached
   access never extends beyond the original deadline. Remote revocation stops
   server acceptance immediately; a running offline device learns it on a later
   status check. Use **Settings → Quit Study** for immediate local withdrawal.
6. **Refresh consent access** lists enrollment records and offers **Revoke
   access**. Revocation blocks data and sign-in; a new invitation requires a new
   staff verification. In-app Quit Study also revokes its enrollment and queues
   the server withdrawal if offline. An old queued withdrawal cannot revoke a
   newly verified enrollment on the same phone. Switching studies clears the
   previous study's local data and pending uploads.

API equivalents (researcher password in `x-researcher-password`):

- `POST /api/v1/studies/{id}/join-link` body:
  `{"participant":"P001","consent_verified":true,"consent_version":"APPROVED-VERSION","consent_reference":"REGISTER-REF","consented_at":"2026-10-20","verified_by":"STAFF-ID"}`.
  Returns `study_url`, `qr_svg`, `enrollment_id`, and `invitation_expires_at`.
- `GET /api/v1/studies/{id}/enrollments` lists consent/access metadata, never tokens.
- `DELETE /api/v1/studies/{id}/enrollments/{enrollment_id}` revokes access.
- Participant activation: `POST /api/v1/studies/{id}/enrollment`, Bearer personal
  token, JSON `{"device_id":"..."}`. Response: participant code, consent version,
  and fixed `expires_at`. `GET` on the same endpoint checks current authorization.
- The admin `/admin/studies/{id}/join-link` endpoint accepts the same required
  consent fields; it cannot bypass consent verification.

For App Review, prepare a separate test study and synthetic data. Establish
the applicable consent or approved test-access process before issuing review
credentials. Issue several unused individual test invitations
close to submission, provide them privately in Notes, and keep them valid during
review. Never mark a fictitious signed human consent as real research consent.
The Apple response must include the actual tested URL/QR and navigation after
deployment. See `AppStoreAssets/AppReview/combined-app-review-response-draft.txt`.

## Inspect collected data

Connect to the Postgres instance (Railway gives you a connection string and a
web data tab). Each sensor is a table:

```sql
SELECT count(*) FROM aware_locations;
SELECT data FROM aware_locations ORDER BY timestamp DESC LIMIT 5;
SELECT * FROM devices;          -- enrolled devices + participant ids
SELECT study_id, name FROM studies;
```

## Export data (admin API)

For analysis without direct SQL access, two admin endpoints (guarded by
`x-admin-token: $ADMIN_TOKEN`) list and export collected data.

List sensors with row counts:

```bash
curl https://YOUR-APP.up.railway.app/admin/sensors \
  -H "x-admin-token: $ADMIN_TOKEN"
# { "ok": true, "sensors": [ { "sensor": "locations", "table": "aware_locations", "rows": 1234 }, ... ] }
```

Export one sensor's rows. `format=json` (default) or `format=csv`; optional
`device_id`, `limit` (max 10000), and `offset` for paging:

```bash
# JSON
curl "https://YOUR-APP.up.railway.app/admin/export/locations?limit=5000&offset=0" \
  -H "x-admin-token: $ADMIN_TOKEN"

# CSV (flattens the JSON payload into columns; downloads as locations.csv)
curl "https://YOUR-APP.up.railway.app/admin/export/locations?format=csv&device_id=dev-1" \
  -H "x-admin-token: $ADMIN_TOKEN" -o locations.csv
```

CSV columns are `id, device_id, timestamp, <union of payload keys>, created_at`.
Page with `limit`/`offset` for large datasets.

Researchers can also use the hosted dashboard at `/researcher/`, or export one
study-scoped sensor with the researcher password:

```bash
curl "https://YOUR-APP.up.railway.app/api/v1/studies/pilot1/export/locations?format=csv" \
  -H "x-researcher-password: a-different-long-secret" -o pilot1-locations.csv
```

## Withdrawal and deletion

- When a participant quits in the app, it asks whether to also delete data
  already uploaded, then calls `POST /api/v1/studies/{id}/withdrawal`. The
  request is always recorded in the `withdrawals` audit table; with
  `delete_data: true`, every row that device uploaded is removed from every
  sensor table (raw and derived) and the device is unregistered. Without
  deletion the device stays listed (status **Withdrawn**) but no longer counts
  as enrolled; joining again re-enrolls it.
- Device counts on both dashboards are enrolled (not withdrawn) devices and
  refresh every minute while the page is open. Every upload path registers its
  device, and on boot the server registers any device found in sensor data
  but missing from the `devices` table.
- Researchers can delete a participant from the **Devices** table in
  `/researcher/` (or `DELETE /api/v1/studies/{id}/participants/{device_id}`).
  Admins can use `DELETE /admin/studies/{id}/participants/{device_id}`.
- The dashboard's **Withdrawals and deletions** table lists every request.


## Local development

```bash
cd server
npm install
DATABASE_URL=postgres://localhost/studytrace ADMIN_TOKEN=dev npm start
```

Run the protocol smoke test (uses an in-memory Postgres, no DB needed). CI runs
the same suite on every pull request that touches the server
(`.github/workflows/server-tests.yml`):

```bash
npm test
```

Preview the dashboards without a database (in-memory data, localhost only):

```bash
npm run preview
```

Then open `http://localhost:4173/researcher/` with study `demo` and researcher
password `demo-researcher-password` (demo values from `scripts/dev-preview.mjs`).

## Security notes

- Ingestion endpoints require an active device-bound personal credential; researcher
  endpoints (dashboards, exports, media, schedules, deletion) require the
  separate researcher password. Personal participant credentials are never accepted
  for researcher endpoints.
- Passwords are stored as scrypt hashes and compared in constant time.
- The admin endpoint requires the `x-admin-token` header to match `ADMIN_TOKEN`.
  Keep that token secret and rotate it if exposed.
- Failed credential checks are rate limited per client IP (30 per 15 minutes by
  default; tune with `AUTH_FAILURE_MAX` / `AUTH_FAILURE_WINDOW_MS`). The client
  IP comes from `X-Forwarded-For`, trusting `TRUST_PROXY_HOPS` proxy hops
  (default `1`, correct for Railway).
- Responses carry a strict Content-Security-Policy and related headers, and
  the dashboards escape all participant-supplied values.
- Residual risk: devices are identified by their random `device_id`, not a
  per-device secret, so someone holding the participant password *and* another
  device's ID could still upload rows under it. Per-device tokens would need
  changes to the AWAREFramework client.
- Table names from the client are constrained to a safe charset and prefixed
  with `aware_`, so they cannot inject SQL or collide with metadata tables.
- This server accepts data over HTTPS only in practice, because Railway serves
  the public domain over TLS and the app refuses non-HTTPS servers.
