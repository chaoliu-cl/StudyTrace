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
//     POST {studyURL}/{table}/clear_table  body: device_id=<uuid>  (disabled:
//          the study password is shared by every participant, so it must not
//          authorize deletion; researchers delete via the dashboard instead)

import express from 'express';
import { parse as parseQueryString } from 'node:querystring';
import {
  safeTableName,
  createSensorTable,
  insertRows,
  latestRow,
  upsertDevice,
  getStudy,
} from './db.js';
import { buildStudyConfig } from './studyConfig.js';
import { CONSENT_TABLE, consentForParticipant, publishedConsent } from './consent.js';
import {
  isRateLimited,
  recordAuthFailure,
  sendRateLimited,
  studyAcceptsParticipantPassword,
} from './auth.js';

export function createAwareRouter(getPublicBaseUrl) {
  const router = express.Router();

  // Matches .../index.php/webservice/index/{study_id}/{password}
  const STUDY_PREFIX = '/index.php/webservice/index/:studyId/:password';

  async function requireStudy(req, res, next) {
    try {
      if (isRateLimited(req)) return sendRateLimited(res);
      const { studyId, password } = req.params;
      const study = await getStudy(studyId);
      if (!studyAcceptsParticipantPassword(study, password)) {
        recordAuthFailure(req);
        return res.status(403).json({ error: 'invalid study id or password' });
      }
      req.study = study;
      next();
    } catch (err) {
      next(err);
    }
  }

  function webserviceUrlFor(req) {
    const base = getPublicBaseUrl() || `${req.protocol}://${req.get('host')}`;
    return `${base}/index.php/webservice/index/${encodeURIComponent(req.params.studyId)}/${encodeURIComponent(req.params.password)}`;
  }

  // ---- Join / configuration -------------------------------------------------
  router.post(STUDY_PREFIX, requireStudy, async (req, res, next) => {
    try {
      const deviceId = req.body.device_id;
      const participant = participantLabel(req.query.participant);
      if (deviceId) {
        await upsertDevice(deviceId, req.params.studyId, participant);
      }
      const config = buildStudyConfig({
        studyId: req.params.studyId,
        studyName: req.study.name,
        webserviceUrl: webserviceUrlFor(req),
      });
      res.json(config);
    } catch (err) {
      next(err);
    }
  });

  // ---- Informed consent ----------------------------------------------------
  // The app fetches this before joining and joins only if the participant
  // agrees; it then records the agreement below.
  router.get(`${STUDY_PREFIX}/consent`, requireStudy, (req, res) => {
    const consent = consentForParticipant(req.study);
    if (!consent) {
      return res.status(404).json({
        error: 'consent_not_published',
        message: 'This study has not published its consent form yet.',
      });
    }
    res.json({ ok: true, consent });
  });

  //   body (JSON): { device_id, version, accepted_at (epoch ms) }
  router.post(`${STUDY_PREFIX}/consent`, requireStudy, async (req, res, next) => {
    try {
      const body = normalizeAwareBody(req.body);
      const deviceId = String(body.device_id || '').trim();
      if (!deviceId) return res.status(400).json({ error: 'device_id is required' });
      const consent = publishedConsent(req.study);
      if (!consent) return res.status(404).json({ error: 'consent_not_published' });
      const version = Number(body.version);
      if (version !== Number(consent.version)) {
        // Consent changed after the app fetched it: the app shows the new one.
        return res.status(409).json({ error: 'consent_version_outdated', current_version: consent.version });
      }
      const now = Date.now();
      const claimed = Number(body.accepted_at);
      const acceptedAt = Number.isFinite(claimed) && claimed > 0 ? Math.min(claimed, now) : now;
      const table = safeTableName(CONSENT_TABLE);
      await createSensorTable(table);
      const inserted = await insertRows(table, req.params.studyId, deviceId, [{
        timestamp: acceptedAt,
        dedupe_key: `consent:${version}`,
        consent_version: version,
        consent_title: consent.title,
        consent_published_at: consent.published_at,
        participant: participantLabel(req.query.participant) || null,
      }]);
      res.status(201).json({ ok: true, recorded: inserted === 1, version });
    } catch (err) {
      next(err);
    }
  });

  router.get(`${STUDY_PREFIX}/esm/config`, requireStudy, async (req, res) => {
    const config = req.study.config || {};
    const esmSchedule = Array.isArray(config.esm_schedule) ? config.esm_schedule : [];
    const batterySchedule = Array.isArray(config.battery_screenshot_schedule) ? config.battery_screenshot_schedule : [];
    const activitySchedule = Array.isArray(config.screen_time_activity_schedule) ? config.screen_time_activity_schedule : [];
    res.json([...esmSchedule, ...batterySchedule, ...activitySchedule]);
  });

  // ---- Per-sensor actions ---------------------------------------------------
  const ACTION_PREFIX = `${STUDY_PREFIX}/:table/:action`;

  router.post(ACTION_PREFIX, requireStudy, async (req, res) => {
    const { table: rawTable, action } = req.params;
    const table = safeTableName(rawTable);
    if (!table) {
      return res.status(400).json({ error: 'invalid table name' });
    }
    const body = normalizeAwareBody(req.body);
    const deviceId = body.device_id || null;

    try {
      switch (action) {
        case 'create_table': {
          await createSensorTable(table);
          return res.json({ status: true });
        }
        case 'insert': {
          await createSensorTable(table); // ensure exists; client may skip create
          let rows = [];
          if (body.data) {
            try {
              rows = JSON.parse(body.data);
            } catch {
              return res.status(400).json({ error: 'data is not valid JSON' });
            }
          }
          const n = await insertRows(table, req.params.studyId, deviceId, rows);
          if (deviceId) await upsertDevice(deviceId, req.params.studyId, req.query.participant);
          return res.json({ status: true, inserted: n, duplicates: rows.length - n });
        }
        case 'latest': {
          const row = await latestRow(table, req.params.studyId, deviceId);
          return res.json(row ? [row] : []);
        }
        case 'clear_table': {
          return res.status(403).json({
            status: false,
            error: 'clear_table is disabled; deletion requests go through the research team',
          });
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

// AWARE builds sensor URLs by appending paths to the study URL, query string
// included, so a join link's ?participant=P001 arrives as
// "P001/aware_device/create_table". Keep the label the research team set.
export function participantLabel(value) {
  if (typeof value !== 'string') return undefined;
  const label = value.split('/')[0].trim().slice(0, 128);
  return label || undefined;
}

function normalizeAwareBody(body) {
  if (!body) return {};
  if (typeof body === 'string') {
    return parseQueryString(body);
  }
  if (Buffer.isBuffer(body)) {
    return parseQueryString(body.toString('utf8'));
  }
  return body;
}
