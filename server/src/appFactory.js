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
import { getPool } from './db.js';
import { createAwareRouter } from './awareApi.js';
import { createGenericApiRouter } from './genericApi.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', true);

  // AWARE posts application/x-www-form-urlencoded ("device_id=..&data=<json>");
  // the generic API uses JSON. Accept both. Payloads can be large.
  app.use(express.urlencoded({ extended: false, limit: '25mb' }));
  app.use(express.json({ limit: '25mb' }));

  let publicBaseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const getPublicBaseUrl = () => publicBaseUrl;

  // ---- Health check (Railway) -----------------------------------------------
  app.get('/', (_req, res) =>
    res.json({
      ok: true,
      service: 'studytrace-server',
      ingestion: ['aware', 'generic-json'],
    })
  );
  app.get('/health', (_req, res) => res.json({ ok: true }));

  // ---- Admin: provision a study ---------------------------------------------
  // POST /admin/studies  (header: x-admin-token: $ADMIN_TOKEN)
  //   body (JSON): { "study_id": "...", "password": "...", "name": "..." }
  app.post('/admin/studies', async (req, res) => {
    const adminToken = process.env.ADMIN_TOKEN;
    if (!adminToken || req.get('x-admin-token') !== adminToken) {
      return res.status(403).json({ error: 'forbidden' });
    }
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

  // ---- Ingestion front-ends (shared storage) --------------------------------
  app.use('/', createAwareRouter(getPublicBaseUrl));
  app.use('/api/v1', createGenericApiRouter());

  return app;
}
