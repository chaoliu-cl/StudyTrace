// Generic, protocol-neutral ingestion API.
//
// This router exposes the same underlying storage as the AWARE-compatible
// routes, but with a plain JSON/REST shape that is not tied to AWARE's URL
// conventions or form-encoding. It lets researchers point any data source
// (a custom app, a script, another framework) at this server without speaking
// the AWARE protocol. The AWARE routes remain available for the StudyTrace
// iOS client; this is an additional, equivalent door into the same data.
//
// Auth: ingestion requests carry the participant study password as a Bearer
// token (`Authorization: Bearer <password>`) or `x-study-password` header.
// Destructive calls (DELETE) require the researcher password instead, sent as
// `x-researcher-password` or Bearer. The study id is in the path.
//
// Endpoints (all under the mount point, e.g. /api/v1):
//   POST   /studies/:studyId/sensors/:sensor/data
//            body: { "device_id": "...", "rows": [ {...}, ... ] }
//                  (also accepts a bare array, or a single object)
//   GET    /studies/:studyId/sensors/:sensor/latest?device_id=...
//   DELETE /studies/:studyId/sensors/:sensor/data?device_id=...
//   GET    /studies/:studyId/sensors/:sensor/count?device_id=...
//   POST   /studies/:studyId/withdrawal
//            body: { "device_id": "...", "delete_data": true|false,
//                    "withdrawn_at": <epoch ms, optional> }

import express from 'express';
import {
  safeTableName,
  createSensorTable,
  insertRows,
  latestRow,
  clearTable,
  upsertDevice,
  markDeviceWithdrawn,
  getStudy,
  countRows,
  deleteDeviceData,
  getDeviceParticipant,
  recordWithdrawal,
} from './db.js';
import {
  isRateLimited,
  participantPasswordFrom,
  recordAuthFailure,
  researcherPasswordFrom,
  sendRateLimited,
  studyAcceptsParticipantPassword,
  studyAcceptsResearcherPassword,
} from './auth.js';

export function createGenericApiRouter() {
  // mergeParams so :studyId from the mount path is visible here.
  const router = express.Router({ mergeParams: true });

  // Authenticate every generic-API request. Either credential is accepted;
  // req.authRole records which one matched so handlers can require more.
  router.use('/studies/:studyId', async (req, res, next) => {
    try {
      if (isRateLimited(req)) return sendRateLimited(res);
      const participantPassword = participantPasswordFrom(req);
      const researcherPassword = researcherPasswordFrom(req);
      if (!participantPassword && !researcherPassword) {
        return res.status(401).json({
          error: 'missing credentials: send Authorization: Bearer <password> or x-study-password header',
        });
      }
      const study = await getStudy(req.params.studyId);
      if (studyAcceptsResearcherPassword(study, researcherPassword)) {
        req.authRole = 'researcher';
      } else if (studyAcceptsParticipantPassword(study, participantPassword)) {
        req.authRole = 'participant';
      } else {
        recordAuthFailure(req);
        return res.status(403).json({ error: 'invalid study id or password' });
      }
      req.study = study;
      next();
    } catch (err) {
      next(err);
    }
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
      const n = await insertRows(table, req.params.studyId, deviceId, rows);
      if (deviceId) await upsertDevice(deviceId, req.params.studyId, req.query.participant);
      return res.status(201).json({ ok: true, inserted: n, duplicates: rows.length - n });
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
      const row = await latestRow(table, req.params.studyId, deviceId);
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
      const count = await countRows(table, { studyId: req.params.studyId, deviceId });
      return res.json({ ok: true, count });
    } catch (err) {
      console.error(`[api count ${req.params.sensor}]`, err);
      return res.status(500).json({ error: 'server error' });
    }
  });

  // ---- Clear data -----------------------------------------------------------
  router.delete('/studies/:studyId/sensors/:sensor/data', async (req, res) => {
    if (req.authRole !== 'researcher') {
      return res.status(403).json({ error: 'deleting data requires the researcher password' });
    }
    const table = safeTableName(req.params.sensor);
    if (!table) return res.status(400).json({ error: 'invalid sensor name' });
    const deviceId = deviceIdFrom(req);
    if (!deviceId) {
      return res.status(400).json({ error: 'device_id is required to clear data' });
    }
    try {
      await clearTable(table, req.params.studyId, deviceId);
      return res.json({ ok: true });
    } catch (err) {
      console.error(`[api clear ${req.params.sensor}]`, err);
      return res.status(500).json({ error: 'server error' });
    }
  });

  // ---- Participant withdrawal ----------------------------------------------
  // Called by the app when a participant quits. Always logged; when
  // delete_data is true, every row this device uploaded up to withdrawn_at is
  // removed. The app queues and retries this request when offline, so the
  // cutoff keeps a late retry from deleting data sent after a re-join.
  router.post('/studies/:studyId/withdrawal', async (req, res) => {
    const deviceId = deviceIdFrom(req);
    if (!deviceId) {
      return res.status(400).json({ error: 'device_id is required' });
    }
    const deleteData = req.body?.delete_data === true || req.body?.delete_data === 'true';
    const now = Date.now();
    const claimed = Number(req.body?.withdrawn_at);
    const withdrawnAt = Number.isFinite(claimed) && claimed > 0 ? Math.min(claimed, now) : now;
    try {
      const participant = await getDeviceParticipant(req.params.studyId, deviceId);
      const rowsDeleted = deleteData
        ? await deleteDeviceData(req.params.studyId, deviceId, { before: withdrawnAt })
        : 0;
      // Without deletion the device stays listed with its data but no longer
      // counts as enrolled; with deletion its registration is already gone.
      await markDeviceWithdrawn(req.params.studyId, deviceId, withdrawnAt);
      await recordWithdrawal({
        studyId: req.params.studyId,
        deviceId,
        participant,
        source: req.authRole === 'researcher' ? 'researcher' : 'participant',
        deleteData,
        rowsDeleted,
        requestedAt: withdrawnAt,
      });
      return res.json({ ok: true, deleted: deleteData, rows_deleted: rowsDeleted });
    } catch (err) {
      console.error(`[api withdrawal ${req.params.studyId}]`, err);
      return res.status(500).json({ error: 'server error' });
    }
  });

  return router;
}
