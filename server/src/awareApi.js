// AWARE-protocol front-end.
//
// Implements the subset of the AWARE REST protocol that the bundled
// AWAREFramework (1.14.x) in the StudyTrace iOS client uses. This is ONE of the
// ingestion front-ends over the shared storage layer (see genericApi.js for a
// protocol-neutral alternative); researchers are free to use either, or point
// the app at any other AWARE-compatible server entirely.
//
// URL shapes produced by the client:
//   Study URL (join/config):
//     POST {BASE}/index.php/webservice/index/{STUDY_ID}/{PASSWORD}?participant={ID}
//        body: device_id=<uuid>  -> returns study configuration JSON (array)
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
} from './db.js';
import { buildStudyConfig } from './studyConfig.js';

export function createAwareRouter(getPublicBaseUrl) {
  const router = express.Router();

  // Matches .../index.php/webservice/index/{study_id}/{password}
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
    const base = getPublicBaseUrl() || `${req.protocol}://${req.get('host')}`;
    return `${base}/index.php/webservice/index/${req.params.studyId}/${req.params.password}`;
  }

  // ---- Join / configuration -------------------------------------------------
  router.post(STUDY_PREFIX, requireStudy, async (req, res) => {
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

  router.post(ACTION_PREFIX, requireStudy, async (req, res) => {
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
          const n = await insertRows(table, req.params.studyId, deviceId, rows);
          if (deviceId) await upsertDevice(deviceId, req.params.studyId, req.query.participant);
          return res.json({ status: true, inserted: n });
        }
        case 'latest': {
          const row = await latestRow(table, req.params.studyId, deviceId);
          return res.json(row ? [row] : []);
        }
        case 'clear_table': {
          if (deviceId) await clearTable(table, req.params.studyId, deviceId);
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

  return router;
}
