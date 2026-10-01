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
- or point the StudyTrace app at a completely different AWARE-compatible
  server (e.g. the official AWARE server, or their own). The app's Study URL
  field accepts any HTTPS host.

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
/index.php/webservice/index/{STUDY_ID}/{PASSWORD}/esm/config
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
| Join / get config    | `POST /index.php/webservice/index/{STUDY_ID}/{PASSWORD}` body `device_id=…` |
| Create sensor table  | `POST …/{STUDY_ID}/{PASSWORD}/{table}/create_table`                      |
| Insert data          | `POST …/{table}/insert` body `device_id=…&data=<JSON array>`            |
| Latest row (sync)    | `POST …/{table}/latest` body `device_id=…`                              |
| Clear table          | Disabled (returns 403). The study password is shared by every participant, so it cannot authorize deletion. |

## Generic JSON API front-end

Protocol-neutral REST over the same storage. Ingestion authenticates with the
participant study password as a Bearer token (`Authorization: Bearer <password>`)
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
  -H "Authorization: Bearer choose-a-strong-password" \
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

Each study has **two** credentials:

| Credential | Who has it | What it allows |
|------------|------------|----------------|
| `password` (participant study password) | Every participant, inside the join URL / QR code | Joining, uploading data, downloading the survey schedule, withdrawing |
| `researcher_password` (min. 12 chars) | Research team only | Researcher dashboard, exports, photo/screenshot access, schedule edits, deleting data |

Both are stored as scrypt hashes; the server never keeps the plaintext.
Studies are created through a token-guarded admin endpoint (or the `/admin/`
dashboard):

```bash
curl -X POST https://YOUR-APP.up.railway.app/admin/studies \
  -H "Content-Type: application/json" \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -d '{"study_id":"pilot1","password":"choose-a-strong-password","researcher_password":"a-different-long-secret","name":"StudyTrace Pilot"}'
```

Response:

```json
{
  "status": true,
  "created": true,
  "study_id": "pilot1",
  "researcher_password_set": true,
  "study_url": "https://YOUR-APP.up.railway.app/index.php/webservice/index/pilot1/choose-a-strong-password",
  "api_base": "https://YOUR-APP.up.railway.app/api/v1/studies/pilot1"
}
```

- `study_url` — paste/QR into the StudyTrace app (AWARE protocol). Because the
  password is stored hashed, the URL is only returned when you send `password`
  in the request. The response also carries `qr_svg`, a QR code of the URL, and
  `/admin/` shows both after you save.
- `api_base` — base path for the generic JSON API.

Posting again for an existing study changes **only the fields you send**. To set
or rotate the researcher password without disturbing enrolled phones:

```bash
curl -X POST https://YOUR-APP.up.railway.app/admin/studies \
  -H "Content-Type: application/json" \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -d '{"study_id":"pilot1","researcher_password":"a-different-long-secret"}'
```

### Upgrading studies created before researcher passwords existed

On first boot after upgrading, existing plaintext study passwords are hashed
automatically and participants keep working. The researcher dashboard for
those studies stays **locked** (`researcher_password_not_set`) until an admin
sets a researcher password as shown above. The `/admin/` studies table shows
which studies still need one.

## Connect the app

The `study_url` above is what the StudyTrace client joins. You can:

- **Paste it** into the app: StudyTrace tab → Study URL → enter the URL, or
- **Encode it as a QR code** and scan it via the in-app QR reader. Any QR/URL
  generator works; the app accepts `https://…` directly, and also accepts the
  AWARE `aware-ssl://…` / `aware://…` scheme forms (it maps them to HTTPS).

To add a participant identifier, append `?participant=<ID>`:

```
https://YOUR-APP.up.railway.app/index.php/webservice/index/pilot1/PASSWORD?participant=P001
```

Both dashboards can rebuild the URL and its QR code later: **Join link and QR
code** in `/admin/`, and **Participant join link** in `/researcher/`. Enter the
participant study password (only its hash is stored) and, optionally, a
participant ID; you can copy the URL or download the QR as SVG or PNG. The API
is `POST /admin/studies/{id}/join-link` (admin token) or
`POST /api/v1/studies/{id}/join-link` (researcher password), with body
`{"password": "...", "participant": "P001"}`. A wrong password counts toward
the failed-login rate limit.

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

- Ingestion endpoints require the participant study password; researcher
  endpoints (dashboards, exports, media, schedules, deletion) require the
  separate researcher password. The participant password is never accepted
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
