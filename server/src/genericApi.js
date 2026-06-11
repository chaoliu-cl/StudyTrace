// Generic, protocol-neutral ingestion API.
//
// This router exposes the same underlying storage as the AWARE-compatible
// routes, but with a plain JSON/REST shape that is not tied to AWARE's URL
// conventions or form-encoding. It lets researchers point any data source
// (a custom app, a script, another framework) at this server without speaking
// the AWARE protocol. The AWARE routes remain available for the StudyTrace
// iOS client; this is an additional, equivalent door into the same data.
//
// Auth: every request carries the study password as a Bearer token
//   Authorization: Bearer <password>
// or the header `x-study-password: <password>`. The study id is in the path.
//
// Endpoints (all under the mount point, e.g. /api/v1):
//   POST   /studies/:studyId/sensors/:sensor/data
//            body: { "device_id": "...", "rows": [ {...}, ... ] }
//                  (also accepts a bare array, or a single object)
//   GET    /studies/:studyId/sensors/:sensor/latest?device_id=...
//   DELETE /studies/:studyId/sensors/:sensor/data?device_id=...
//   GET    /studies/:studyId/sensors/:sensor/count?device_id=...

import express from 'express';
import {
  safeTableName,
  createSensorTable,
  insertRows,
  latestRow,
  clearTable,
  upsertDevice,
  getStudy,
  countRows,
} from './db.js';

function extractPassword(req) {
  const auth = req.get('authorization');
  if (auth && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim();
  }
  const header = req.get('x-study-password');
  if (header) return header.trim();
  return null;
}

export function createGenericApiRouter() {
  // mergeParams so :studyId from the mount path is visible here.
  const router = express.Router({ mergeParams: true });

  // Authenticate against study credentials for every generic-API request.
  router.use('/studies/:studyId', async (req, res, next) => {
    const { studyId } = req.params;
    const password = extractPassword(req);
    if (!password) {
      return res.status(401).json({
        error: 'missing credentials: send Authorization: Bearer <password> or x-study-password header',
      });
    }
    const study = await getStudy(studyId);
    if (!study || study.password !== password) {
      return res.status(403).json({ error: 'invalid study id or password' });
    }
    req.study = study;
    next();
  });

  // Normalize the various accepted body shapes into an array of rows.
  function rowsFromBody(body) {
    if (Array.isArray(body)) return body;
    if (body && Array.isArray(body.rows)) return body.rows;
    if (body && typeof body === 'object' && Object.keys(body).length > 0) {
      // A single record object (minus a top-level device_id wrapper).
      const { device_id, rows, ...rest } = body;
      if (rows === undefined && Object.keys(rest).length > 0) return [rest];
      return [];
    }
    return [];
  }

  function deviceIdFrom(req) {
    return (
      req.body?.device_id ||
      req.query.device_id ||
      req.get('x-device-id') ||
      null
    );
  }

  // ---- Insert data ----------------------------------------------------------
  router.post('/studies/:studyId/sensors/:sensor/data', async (req, res) => {
    const table = safeTableName(req.params.sensor);
    if (!table) return res.status(400).json({ error: 'invalid sensor name' });

    const deviceId = deviceIdFrom(req);
    const rows = rowsFromBody(req.body);
    if (rows.length === 0) {
      return res.status(400).json({ error: 'no rows to insert (send {device_id, rows:[...]})' });
    }
    try {
      await createSensorTable(table);
      const n = await insertRows(table, deviceId, rows);
      if (deviceId) await upsertDevice(deviceId, req.params.studyId, req.query.participant);
      return res.status(201).json({ ok: true, inserted: n });
    } catch (err) {
      console.error(`[api insert ${req.params.sensor}]`, err);
      return res.status(500).json({ error: 'server error' });
    }
  });

  // ---- Latest row -----------------------------------------------------------
  router.get('/studies/:studyId/sensors/:sensor/latest', async (req, res) => {
    const table = safeTableName(req.params.sensor);
    if (!table) return res.status(400).json({ error: 'invalid sensor name' });
    const deviceId = deviceIdFrom(req);
    try {
      const row = await latestRow(table, deviceId);
      return res.json({ ok: true, latest: row });
    } catch (err) {
      console.error(`[api latest ${req.params.sensor}]`, err);
      return res.status(500).json({ error: 'server error' });
    }
  });

  // ---- Row count ------------------------------------------------------------
  router.get('/studies/:studyId/sensors/:sensor/count', async (req, res) => {
    const table = safeTableName(req.params.sensor);
    if (!table) return res.status(400).json({ error: 'invalid sensor name' });
    const deviceId = deviceIdFrom(req);
    try {
      const count = await countRows(table, deviceId);
      return res.json({ ok: true, count });
    } catch (err) {
      console.error(`[api count ${req.params.sensor}]`, err);
      return res.status(500).json({ error: 'server error' });
    }
  });

  // ---- Clear data -----------------------------------------------------------
  router.delete('/studies/:studyId/sensors/:sensor/data', async (req, res) => {
    const table = safeTableName(req.params.sensor);
    if (!table) return res.status(400).json({ error: 'invalid sensor name' });
    const deviceId = deviceIdFrom(req);
    if (!deviceId) {
      return res.status(400).json({ error: 'device_id is required to clear data' });
    }
    try {
      await clearTable(table, deviceId);
      return res.json({ ok: true });
    } catch (err) {
      console.error(`[api clear ${req.params.sensor}]`, err);
      return res.status(500).json({ error: 'server error' });
    }
  });

  return router;
}
