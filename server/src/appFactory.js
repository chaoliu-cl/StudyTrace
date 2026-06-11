// Express app factory.
//
// The server stores time-series study data in PostgreSQL (see db.js) and
// exposes it through interchangeable ingestion front-ends that share the same
// storage:
//
//   - AWARE protocol front-end (awareApi.js) — what the StudyTrace iOS client
//     speaks out of the box. Mounted at /index.php/webservice/...
//   - Generic JSON API (genericApi.js) — a protocol-neutral REST interface for
//     any other data source. Mounted at /api/v1.
//
// Researchers are free to use either front-end, or to point the app at a
// completely different AWARE-compatible server; this deployment is just one
// reference option. Kept separate from boot logic (index.js) so the smoke test
// can drive it against an injected in-memory database.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getPool,
  listSensorTables,
  exportRows,
  safeTableName,
  listStudies,
  getStudyOverview,
  getStudy,
} from './db.js';
import { createAwareRouter } from './awareApi.js';
import { createGenericApiRouter } from './genericApi.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', true);
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

  // AWARE posts application/x-www-form-urlencoded ("device_id=..&data=<json>");
  // the generic API uses JSON. Accept both. Payloads can be large.
  app.use(express.urlencoded({ extended: false, limit: '25mb' }));
  app.use(express.json({ limit: '25mb' }));
  app.use(express.static(publicDir));

  let publicBaseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const getPublicBaseUrl = () => publicBaseUrl;

  // ---- Health check (Railway) -----------------------------------------------
  app.get('/status', (_req, res) =>
    res.json({
      ok: true,
      service: 'studytrace-server',
      ingestion: ['aware', 'generic-json'],
    })
  );
  app.get('/health', (_req, res) => res.json({ ok: true }));

  // ---- Admin: provision a study ---------------------------------------------
  // Shared admin auth guard (header: x-admin-token: $ADMIN_TOKEN).
  function requireAdmin(req, res, next) {
    const adminToken = process.env.ADMIN_TOKEN;
    if (!adminToken || req.get('x-admin-token') !== adminToken) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  }

  async function requireStudyPassword(req, res, next) {
    const auth = req.get('authorization');
    const password = req.get('x-study-password') || (
      auth && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : ''
    );
    if (!password) {
      return res.status(401).json({
        error: 'missing credentials: send Authorization: Bearer <password> or x-study-password header',
      });
    }

    const study = await getStudy(req.params.studyId);
    if (!study || study.password !== password) {
      return res.status(403).json({ error: 'invalid study id or password' });
    }
    req.study = study;
    next();
  }

  // POST /admin/studies  (header: x-admin-token: $ADMIN_TOKEN)
  //   body (JSON): { "study_id": "...", "password": "...", "name": "..." }
  app.post('/admin/studies', requireAdmin, async (req, res) => {
    const { study_id, password, name } = req.body || {};
    if (!study_id || !password) {
      return res.status(400).json({ error: 'study_id and password are required' });
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(study_id)) {
      return res.status(400).json({ error: 'study_id must be 1-64 chars [A-Za-z0-9_-]' });
    }
    await getPool().query(
      `INSERT INTO studies (study_id, password, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (study_id) DO UPDATE SET password = EXCLUDED.password, name = EXCLUDED.name`,
      [study_id, password, name || 'StudyTrace Study']
    );
    const base = publicBaseUrl || `${req.protocol}://${req.get('host')}`;
    res.json({
      status: true,
      study_id,
      // AWARE-protocol study URL (paste/QR into the StudyTrace app).
      study_url: `${base}/index.php/webservice/index/${study_id}/${password}`,
      // Generic-API base for any other client.
      api_base: `${base}/api/v1/studies/${study_id}`,
    });
  });

  // ---- Admin: data export ---------------------------------------------------
  // GET /admin/sensors  -> list sensor tables with row counts.
  app.get('/admin/sensors', requireAdmin, async (_req, res) => {
    try {
      const sensors = await listSensorTables();
      res.json({ ok: true, sensors });
    } catch (err) {
      console.error('[admin sensors]', err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.get('/admin/studies', requireAdmin, async (_req, res) => {
    try {
      const studies = await listStudies();
      res.json({ ok: true, studies });
    } catch (err) {
      console.error('[admin studies]', err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.get('/admin/studies/:studyId', requireAdmin, async (req, res) => {
    try {
      const overview = await getStudyOverview(req.params.studyId);
      if (!overview) return res.status(404).json({ error: 'study not found' });
      res.json({ ok: true, ...overview });
    } catch (err) {
      console.error(`[admin study ${req.params.studyId}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  // GET /admin/export/:sensor?format=json|csv&device_id=&limit=&offset=
  //   Exports stored rows for one sensor. JSON (default) returns an array of
  //   { id, device_id, timestamp, data, created_at }. CSV flattens the JSON
  //   `data` object into columns (union of keys across the returned page).
  app.get('/admin/export/:sensor', requireAdmin, async (req, res) => {
    const table = safeTableName(req.params.sensor);
    if (!table) return res.status(400).json({ error: 'invalid sensor name' });
    const { format = 'json', study_id: studyId, device_id: deviceId, limit, offset } = req.query;
    try {
      const rows = await exportRows(table, { studyId, deviceId, limit, offset });
      if (format === 'csv') {
        const csv = rowsToCsv(rows);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${req.params.sensor}.csv"`);
        return res.send(csv);
      }
      return res.json({ ok: true, sensor: req.params.sensor, count: rows.length, rows });
    } catch (err) {
      console.error(`[admin export ${req.params.sensor}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  // ---- Researcher dashboard API --------------------------------------------
  app.get('/api/v1/studies/:studyId/dashboard/summary', requireStudyPassword, async (req, res) => {
    try {
      const overview = await getStudyOverview(req.params.studyId);
      if (!overview) return res.status(404).json({ error: 'study not found' });
      res.json({ ok: true, ...overview });
    } catch (err) {
      console.error(`[dashboard summary ${req.params.studyId}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.get('/api/v1/studies/:studyId/export/:sensor', requireStudyPassword, async (req, res) => {
    const table = safeTableName(req.params.sensor);
    if (!table) return res.status(400).json({ error: 'invalid sensor name' });
    const { format = 'json', device_id: deviceId, limit, offset } = req.query;
    try {
      const rows = await exportRows(table, {
        studyId: req.params.studyId,
        deviceId,
        limit,
        offset,
      });
      if (format === 'csv') {
        const csv = rowsToCsv(rows);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${req.params.studyId}-${req.params.sensor}.csv"`);
        return res.send(csv);
      }
      return res.json({ ok: true, sensor: req.params.sensor, count: rows.length, rows });
    } catch (err) {
      console.error(`[dashboard export ${req.params.studyId}/${req.params.sensor}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  // ---- Ingestion front-ends (shared storage) --------------------------------
  app.use('/', createAwareRouter(getPublicBaseUrl));
  app.use('/api/v1', createGenericApiRouter());

  return app;
}

// Flatten exported rows into CSV. Columns are id, study_id, device_id,
// timestamp, plus
// the union of keys found in each row's JSON `data`, then created_at. Values
// containing commas/quotes/newlines are quoted per RFC 4180.
function rowsToCsv(rows) {
  const dataKeys = new Set();
  for (const r of rows) {
    if (r.data && typeof r.data === 'object') {
      for (const k of Object.keys(r.data)) dataKeys.add(k);
    }
  }
  const dataCols = [...dataKeys].sort();
  const header = ['id', 'study_id', 'device_id', 'timestamp', ...dataCols, 'created_at'];

  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [header.join(',')];
  for (const r of rows) {
    const d = r.data && typeof r.data === 'object' ? r.data : {};
    const line = [
      esc(r.id), esc(r.study_id), esc(r.device_id), esc(r.timestamp),
      ...dataCols.map((k) => esc(d[k])),
      esc(r.created_at),
    ];
    lines.push(line.join(','));
  }
  return lines.join('\r\n');
}
