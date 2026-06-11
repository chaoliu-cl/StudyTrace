# StudyTrace Server

A small, self-hostable data collection server for study/sensor data, designed
to deploy on [Railway](https://railway.app) with a managed PostgreSQL database.

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

## Storage model

Each sensor gets its own Postgres table (`aware_<sensor>`), storing the
`device_id`, `timestamp`, and the full original JSON row as `JSONB`. This
preserves every field a client sends without per-sensor schemas. Study and
device metadata live in the `studies` and `devices` tables.

## AWARE protocol front-end

The subset the StudyTrace client calls:

| Client action        | Request                                                                 |
|----------------------|-------------------------------------------------------------------------|
| Join / get config    | `POST /index.php/webservice/index/{STUDY_ID}/{PASSWORD}` body `device_id=…` |
| Create sensor table  | `POST …/{STUDY_ID}/{PASSWORD}/{table}/create_table`                      |
| Insert data          | `POST …/{table}/insert` body `device_id=…&data=<JSON array>`            |
| Latest row (sync)    | `POST …/{table}/latest` body `device_id=…`                              |
| Clear table          | `POST …/{table}/clear_table` body `device_id=…`                         |

## Generic JSON API front-end

Protocol-neutral REST over the same storage. Authenticate with the study
password as a Bearer token (`Authorization: Bearer <password>`) or an
`x-study-password` header. Base: `/api/v1/studies/{STUDY_ID}`.

| Action        | Request                                                                              |
|---------------|--------------------------------------------------------------------------------------|
| Insert data   | `POST   /api/v1/studies/{id}/sensors/{sensor}/data` body `{ "device_id": "...", "rows": [ {...} ] }` |
| Latest row    | `GET    /api/v1/studies/{id}/sensors/{sensor}/latest?device_id=...`                  |
| Row count     | `GET    /api/v1/studies/{id}/sensors/{sensor}/count?device_id=...`                   |
| Clear data    | `DELETE /api/v1/studies/{id}/sensors/{sensor}/data?device_id=...`                    |

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
  admin) with the two front-end routers; `src/index.js` boots it.
- **`src/awareApi.js`** — AWARE protocol router.
- **`src/genericApi.js`** — generic JSON API router.
- **`src/db.js`** — PostgreSQL storage shared by both; tables created on demand.
- **`src/studyConfig.js`** — config returned to AWARE clients on join.

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

### 4. Generate a public domain

In **Settings → Networking → Public Networking**, click **Generate Domain**.
Use that HTTPS URL as `PUBLIC_BASE_URL`.

> The StudyTrace app enforces HTTPS (App Transport Security). Railway-generated
> domains are HTTPS, so they satisfy this out of the box.

### 5. Verify it's up

```
curl https://YOUR-APP.up.railway.app/health
# {"ok":true}
```

## Provision a study

Studies are created through a token-guarded admin endpoint. Run this once per
study:

```bash
curl -X POST https://YOUR-APP.up.railway.app/admin/studies \
  -H "Content-Type: application/json" \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -d '{"study_id":"pilot1","password":"choose-a-strong-password","name":"StudyTrace Pilot"}'
```

Response:

```json
{
  "status": true,
  "study_id": "pilot1",
  "study_url": "https://YOUR-APP.up.railway.app/index.php/webservice/index/pilot1/choose-a-strong-password",
  "api_base": "https://YOUR-APP.up.railway.app/api/v1/studies/pilot1"
}
```

- `study_url` — paste/QR into the StudyTrace app (AWARE protocol).
- `api_base` — base path for the generic JSON API (use the study password as a
  Bearer token).

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


## Local development

```bash
cd server
npm install
DATABASE_URL=postgres://localhost/studytrace ADMIN_TOKEN=dev npm start
```

Run the protocol smoke test (uses an in-memory Postgres, no DB needed):

```bash
npm test
```

## Security notes

- All study endpoints require a valid `{study_id}/{password}` pair.
- The admin endpoint requires the `x-admin-token` header to match `ADMIN_TOKEN`.
  Keep that token secret and rotate it if exposed.
- Table names from the client are constrained to a safe charset and prefixed
  with `aware_`, so they cannot inject SQL or collide with metadata tables.
- This server accepts data over HTTPS only in practice, because Railway serves
  the public domain over TLS and the app refuses non-HTTPS servers.
