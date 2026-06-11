# StudyTrace AWARE Server

A minimal, AWARE-compatible data collection server for the StudyTrace iOS
client, designed to deploy on [Railway](https://railway.app) with a managed
PostgreSQL database.

The StudyTrace app embeds `AWAREFramework` 1.14.x, which uploads sensor data
using the classic AWARE REST protocol. This server implements the subset that
the client actually calls:

| Client action        | Request                                                                 |
|----------------------|-------------------------------------------------------------------------|
| Join / get config    | `POST /index.php/webservice/index/{STUDY_ID}/{PASSWORD}` body `device_id=…` |
| Create sensor table  | `POST …/{STUDY_ID}/{PASSWORD}/{table}/create_table`                      |
| Insert data          | `POST …/{table}/insert` body `device_id=…&data=<JSON array>`            |
| Latest row (sync)    | `POST …/{table}/latest` body `device_id=…`                              |
| Clear table          | `POST …/{table}/clear_table` body `device_id=…`                         |

Each sensor gets its own Postgres table (`aware_<sensor>`), storing the
`device_id`, `timestamp`, and the full original JSON row as `JSONB`. This
preserves every field the client sends without per-sensor schemas.

## Architecture

- **Node.js + Express** — the REST API (`src/appFactory.js`, booted by `src/index.js`).
- **PostgreSQL** — persistence (`src/db.js`), tables created on demand.
- **Study config** — returned on join (`src/studyConfig.js`).

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
  "study_url": "https://YOUR-APP.up.railway.app/index.php/webservice/index/pilot1/choose-a-strong-password"
}
```

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
