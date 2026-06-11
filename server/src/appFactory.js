// Express app factory for the AWARE-compatible server. Kept separate from the
// boot logic (index.js) so it can be exercised by the smoke test against an
// injected in-memory database.
//
// Implements the subset of the AWARE REST protocol that the bundled
// AWAREFramework (1.14.x) uses. URL shapes produced by the client:
//
//   Study URL (join/config):
//     POST {BASE}/index.php/webservice/index/{STUDY_ID}/{PASSWORD}?participant={ID}
//        body: device_id=<uuid>  -> returns study configuration JSON (array)
//
//   Per-sensor data (SyncExecutor / DBTableCreator):
//     POST {studyURL}/{table}/create_table
//     POST {studyURL}/{table}/insert       body: device_id=<uuid>&data=<JSON array>
//     POST {studyURL}/{table}/latest       body: device_id=<uuid>
//     POST {studyURL}/{table}/clear_table  body: device_id=<uuid>

import express from 'express';
import {
  safeTableName,
  createSensorTable,
  insertRows,
  latestRow,
  clearTable,
  upsertDevice,
  getStudy,
  getPool,
} from './db.js';
import { buildStudyConfig } from './studyConfig.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', true);

  // AWARE posts application/x-www-form-urlencoded ("device_id=..&data=<json>").
  // data payloads can be large, so raise the limit.
  app.use(express.urlencoded({ extended: false, limit: '25mb' }));
  app.use(express.json({ limit: '25mb' }));

  const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

  // ---- Health check (Railway) -----------------------------------------------
  app.get('/', (_req, res) => res.json({ ok: true, service: 'studytrace-aware-server' }));
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
    const base = PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const studyUrl = `${base}/index.php/webservice/index/${study_id}/${password}`;
    res.json({ status: true, study_url: studyUrl });
  });

  // ---- Study path prefix ----------------------------------------------------
  const STUDY_PREFIX = '/index.php/webservice/index/:studyId/:password';

  async function requireStudy(req, res, next) {
    const { studyId, password } = req.params;
    const study = await getStudy(studyId);
    if (!study || study.password !== password) {
      return res.status(403).json({ error: 'invalid study id or password' });
    }
    req.study = study;
    next();
  }

  function webserviceUrlFor(req) {
    const base = PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    return `${base}/index.php/webservice/index/${req.params.studyId}/${req.params.password}`;
  }

  // ---- Join / configuration -------------------------------------------------
  app.post(STUDY_PREFIX, requireStudy, async (req, res) => {
    const deviceId = req.body.device_id;
    const participant = req.query.participant;
    if (deviceId) {
      await upsertDevice(deviceId, req.params.studyId, participant);
    }
    const config = buildStudyConfig({
      studyId: req.params.studyId,
      studyName: req.study.name,
      webserviceUrl: webserviceUrlFor(req),
    });
    res.json(config);
  });

  // ---- Per-sensor actions ---------------------------------------------------
  const ACTION_PREFIX = `${STUDY_PREFIX}/:table/:action`;

  app.post(ACTION_PREFIX, requireStudy, async (req, res) => {
    const { table: rawTable, action } = req.params;
    const table = safeTableName(rawTable);
    if (!table) {
      return res.status(400).json({ error: 'invalid table name' });
    }
    const deviceId = req.body.device_id || null;

    try {
      switch (action) {
        case 'create_table': {
          await createSensorTable(table);
          return res.json({ status: true });
        }
        case 'insert': {
          await createSensorTable(table); // ensure exists; client may skip create
          let rows = [];
          if (req.body.data) {
            try {
              rows = JSON.parse(req.body.data);
            } catch {
              return res.status(400).json({ error: 'data is not valid JSON' });
            }
          }
          const n = await insertRows(table, deviceId, rows);
          if (deviceId) await upsertDevice(deviceId, req.params.studyId, req.query.participant);
          return res.json({ status: true, inserted: n });
        }
        case 'latest': {
          const row = await latestRow(table, deviceId);
          return res.json(row ? [row] : []);
        }
        case 'clear_table': {
          if (deviceId) await clearTable(table, deviceId);
          return res.json({ status: true });
        }
        default:
          return res.status(404).json({ error: `unknown action: ${action}` });
      }
    } catch (err) {
      console.error(`[${rawTable}/${action}]`, err);
      return res.status(500).json({ error: 'server error' });
    }
  });

  return app;
}
