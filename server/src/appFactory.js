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
  listStudySensorTables,
  exportRows,
  createSensorTable,
  insertRows,
  safeTableName,
  listStudies,
  getStudyOverview,
  getStudy,
  updateStudyConfig,
  tableExists,
  isDatabaseConfigured,
  upsertStudy,
  deleteDeviceData,
  getDeviceParticipant,
  recordWithdrawal,
  listWithdrawals,
  listStudyDevices,
  rowsSince,
} from './db.js';
import { ZipWriter } from './zip.js';
import { describeColumn } from './codebook.js';
import {
  buildTimeZoneResolver,
  defaultTimeZoneForStudy,
  isValidTimeZone,
  localDateFor,
  localMidnight,
  nextDate,
} from './localTime.js';
import {
  isRateLimited,
  MIN_RESEARCHER_PASSWORD_LENGTH,
  participantPasswordFrom,
  recordAuthFailure,
  researcherPasswordFrom,
  safeEqual,
  sendRateLimited,
  studyAcceptsParticipantPassword,
  studyAcceptsResearcherPassword,
} from './auth.js';
import { createAwareRouter } from './awareApi.js';
import { createGenericApiRouter } from './genericApi.js';

const BATTERY_USAGE_EXPORT_SENSOR = 'battery_usage_apps';
const SCREEN_TIME_ACTIVITY_SENSOR = 'screen_time_activity';
const PHONE_USE_DAILY_SENSOR = 'phone_use_daily';
const APP_USAGE_COMBINED_SENSOR = 'app_usage_combined';
const APP_USAGE_COMBINED_COLUMNS = [
  'date',
  'timezone',
  'platform',
  'construct',
  'usage_window',
  'app_name',
  'package_name',
  'seconds',
  'source',
  'extraction_method',
  'participant_edited',
];
const PHONE_USE_DAILY_COLUMNS = [
  'date',
  'timezone',
  'platform',
  'pickups',
  'total_use_seconds',
  'session_count',
  'median_session_seconds',
  'short_session_share',
  'long_session_count',
  'night_use_seconds',
  'first_use_at',
  'last_use_at',
  'source_rows',
];
// Night-time use window, local time: [00:00, 05:00).
const NIGHT_END_HOUR = 5;
const SHORT_SESSION_SECONDS = 60;
const LONG_SESSION_SECONDS = 15 * 60;
// iOS measures a session from the previous lock-state change; a value this
// long means the app was not running in between, not a real session.
const MAX_SESSION_SECONDS = 6 * 60 * 60;
const BATTERY_PROMPT = 'battery_usage_screenshot';
const ACTIVITY_PROMPT = 'screen_time_activity_screenshot';
const LOCATION_DAILY_SUMMARY_SENSOR = 'location_daily_summary';
const SURVEY_QUALITY_SENSOR = 'survey_quality';
const PARTICIPANT_HEALTH_SENSOR = 'participant_health';
const CLIENT_EVENTS_SENSOR = 'client_events';
const DEVICE_STATE_SENSOR = 'device_state';
const LEGACY_SCREEN_TIME_SENSORS = new Set([
  'screentime_apps',
  'screentime_raw_log',
  'screentime_app_usage',
]);
const BATTERY_USAGE_EXPORT_COLUMNS = [
  'source_sensor',
  'source_row_id',
  'source_image_url',
  'app_name',
  'screen_time_seconds',
  'screen_time_text',
  'battery_percent',
  'battery_percent_text',
  'usage_window',
  'captured_at',
  'participant_edited',
  'extraction_status',
  'extraction_method',
  'ocr_confidence',
  'needs_review',
  'qa_reason',
  'parse_notes',
  'ocr_text',
];
const SCREEN_TIME_ACTIVITY_COLUMNS = [
  'source_sensor',
  'source_row_id',
  'source_image_url',
  'row_type',
  'activity_date',
  'app_name',
  'screen_time_seconds',
  'total_screen_time_seconds',
  'pickups',
  'notifications',
  'captured_at',
  'participant_edited',
  'extraction_status',
  'extraction_method',
  'needs_review',
  'qa_reason',
  'ocr_text',
];
const LOCATION_DAILY_SUMMARY_COLUMNS = [
  'date',
  'timezone',
  'location_rows',
  'first_location_at',
  'last_location_at',
  'coverage_minutes',
  'distance_meters',
  'radius_of_gyration_meters',
  'stop_count',
  'mean_accuracy_meters',
  'max_accuracy_meters',
];
const SURVEY_QUALITY_COLUMNS = [
  'source_sensor',
  'source_row_id',
  'question_title',
  'question_trigger',
  'question_type',
  'answered',
  'esm_status',
  'status_label',
  'answer_kind',
  'answer_length',
  'response_latency_seconds',
  'submitted_at',
  'local_date',
  'timezone',
  'quality_flags',
];
const PARTICIPANT_HEALTH_COLUMNS = [
  'participant',
  'platform',
  'last_seen',
  'last_client_event',
  'last_heartbeat',
  'max_telemetry_gap_hours_24h',
  'last_launch_reason',
  'last_device_state',
  'timezone',
  'notification_authorization',
  'location_authorization',
  'location_accuracy_authorization',
  'background_refresh_status',
  'battery_level',
  'low_power_mode_enabled',
  'prompts_delivered_7d',
  'survey_sessions_7d',
  'compliance_rate_7d',
  'surveys_dismissed_7d',
  'surveys_expired_7d',
  'telemetry_missing_7d',
  'permission_changes_7d',
  'location_rows',
  'esm_rows',
  'battery_screenshot_rows',
  'battery_app_rows',
  'android_app_usage_rows',
  'upload_failures_24h',
  'notification_taps_24h',
  'health_status',
  'notes',
];
const BATTERY_USAGE_EXPORT_LIMIT = 10000;

export function createApp() {
  const app = express();
  // Trust only the platform's own proxy hop(s) so X-Forwarded-For cannot be
  // spoofed to dodge the failed-login limiter. Railway uses a single edge hop.
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));
  app.disable('x-powered-by');
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

  // AWARE posts application/x-www-form-urlencoded ("device_id=..&data=<json>");
  // the generic API uses JSON. Accept both. Payloads can be large.
  app.use(express.urlencoded({ extended: false, limit: '25mb' }));
  app.use(express.json({ limit: '25mb' }));
  app.use(express.text({ type: '*/*', limit: '25mb' }));
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "img-src 'self' blob: data:",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; '));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.use(express.static(publicDir));

  let publicBaseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const getPublicBaseUrl = () => publicBaseUrl;

  // ---- Health check (Railway) -----------------------------------------------
  app.get('/status', (_req, res) =>
    res.json({
      ok: true,
      service: 'studytrace-server',
      database: isDatabaseConfigured() ? 'configured' : 'missing',
      ingestion: ['aware', 'generic-json'],
    })
  );
  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use((req, res, next) => {
    const needsDatabase =
      req.path.startsWith('/admin') ||
      req.path.startsWith('/api/v1') ||
      req.path.startsWith('/index.php/webservice');
    if (needsDatabase && !isDatabaseConfigured()) {
      return res.status(503).json({
        ok: false,
        error: 'database_not_configured',
        message: 'Add a PostgreSQL database service in Railway, then link its DATABASE_URL variable to this service.',
      });
    }
    next();
  });

  // ---- Auth guards -----------------------------------------------------------
  // Admin: header x-admin-token: $ADMIN_TOKEN.
  function requireAdmin(req, res, next) {
    if (isRateLimited(req)) return sendRateLimited(res);
    const adminToken = process.env.ADMIN_TOKEN;
    if (!adminToken || !safeEqual(req.get('x-admin-token') || '', adminToken)) {
      recordAuthFailure(req);
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  }

  // Researcher: x-researcher-password header (or Bearer). The participant
  // study password is deliberately NOT accepted here, because every phone
  // holds it in its join URL.
  async function requireResearcher(req, res, next) {
    try {
      if (isRateLimited(req)) return sendRateLimited(res);
      const password = researcherPasswordFrom(req);
      if (!password) {
        return res.status(401).json({
          error: 'missing credentials: send the researcher password as x-researcher-password or Authorization: Bearer',
        });
      }
      const study = await getStudy(req.params.studyId);
      if (study && !study.researcher_password_hash) {
        return res.status(403).json({
          error: 'researcher_password_not_set',
          message: 'An administrator must set a researcher password for this study in /admin/ before the researcher dashboard can be used.',
        });
      }
      if (!studyAcceptsResearcherPassword(study, password)) {
        recordAuthFailure(req);
        return res.status(403).json({ error: 'invalid study id or researcher password' });
      }
      req.study = study;
      next();
    } catch (err) {
      next(err);
    }
  }

  // Participant: the study password from the join URL, for ingestion only.
  async function requireParticipant(req, res, next) {
    try {
      if (isRateLimited(req)) return sendRateLimited(res);
      const password = req.params.password || participantPasswordFrom(req);
      if (!password) {
        return res.status(401).json({
          error: 'missing credentials: send Authorization: Bearer <password> or x-study-password header',
        });
      }
      const study = await getStudy(req.params.studyId);
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

  // ---- Admin: provision / update a study -------------------------------------
  // POST /admin/studies  (header: x-admin-token: $ADMIN_TOKEN)
  //   body (JSON): { "study_id", "password", "researcher_password", "name" }
  //   New studies need both passwords. For an existing study, only the fields
  //   provided are changed, so setting a researcher password never rotates the
  //   participant password (which would break every enrolled phone).
  app.post('/admin/studies', requireAdmin, async (req, res, next) => {
    try {
      const { study_id, password, researcher_password: researcherPassword, name, timezone } = req.body || {};
      if (!study_id) {
        return res.status(400).json({ error: 'study_id is required' });
      }
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(study_id)) {
        return res.status(400).json({ error: 'study_id must be 1-64 chars [A-Za-z0-9_-]' });
      }
      if (researcherPassword && String(researcherPassword).length < MIN_RESEARCHER_PASSWORD_LENGTH) {
        return res.status(400).json({ error: `researcher_password must be at least ${MIN_RESEARCHER_PASSWORD_LENGTH} characters` });
      }
      if (timezone && !isValidTimeZone(timezone)) {
        return res.status(400).json({ error: 'timezone must be an IANA time zone such as America/New_York' });
      }
      if (password && researcherPassword && password === researcherPassword) {
        return res.status(400).json({ error: 'researcher_password must differ from the participant study password' });
      }
      const existing = await getStudy(study_id);
      if (!existing && (!password || !researcherPassword)) {
        return res.status(400).json({ error: 'new studies require both password and researcher_password' });
      }
      if (existing && password && studyAcceptsResearcherPassword(existing, password)) {
        return res.status(400).json({ error: 'participant password must differ from the researcher password' });
      }
      if (existing && researcherPassword && studyAcceptsParticipantPassword(existing, researcherPassword)) {
        return res.status(400).json({ error: 'researcher_password must differ from the participant study password' });
      }

      const { study, created } = await upsertStudy(study_id, {
        password,
        researcherPassword,
        name: name || (existing ? undefined : 'StudyTrace Study'),
      });
      if (timezone) await updateStudyConfig(study_id, { timezone });
      const base = publicBaseUrl || `${req.protocol}://${req.get('host')}`;
      const response = {
        status: true,
        created,
        study_id,
        researcher_password_set: Boolean(study.researcher_password_hash),
        timezone: timezone || study.config?.timezone || null,
        // Generic-API base for any other client.
        api_base: `${base}/api/v1/studies/${encodeURIComponent(study_id)}`,
      };
      if (password) {
        // AWARE-protocol study URL (paste/QR into the StudyTrace app). Only
        // returned when the participant password was supplied in this call,
        // since the server stores it hashed.
        response.study_url = `${base}/index.php/webservice/index/${encodeURIComponent(study_id)}/${encodeURIComponent(password)}`;
      }
      res.json(response);
    } catch (err) {
      next(err);
    }
  });

  // GET /admin/studies/:studyId/export.zip?images=1
  app.get('/admin/studies/:studyId/export.zip', requireAdmin, async (req, res, next) => {
    try {
      if (!(await getStudy(req.params.studyId))) return res.status(404).json({ error: 'study not found' });
      await writeStudyExportZip(res, req.params.studyId, { includeImages: req.query.images === '1' });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /admin/studies/:studyId/participants/:deviceId
  app.delete('/admin/studies/:studyId/participants/:deviceId', requireAdmin, async (req, res, next) => {
    try {
      const result = await deleteParticipantData(req.params.studyId, req.params.deviceId, 'admin');
      res.json({ ok: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  // ---- Admin: data export ---------------------------------------------------
  // GET /admin/sensors  -> list sensor tables with row counts.
  app.get('/admin/sensors', requireAdmin, async (_req, res) => {
    try {
      const sensors = await listAdminSensorsForDashboard();
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
      await attachStudyDerivedSensors(overview, req.params.studyId);
      res.json({ ok: true, ...overview });
    } catch (err) {
      console.error(`[admin study ${req.params.studyId}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.get('/admin/battery-usage', requireAdmin, async (req, res) => {
    try {
      const diagnostics = await findBatteryUsageDiagnostics({ limit: req.query.limit });
      res.json({ ok: true, ...diagnostics });
    } catch (err) {
      console.error('[admin battery usage]', err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.get('/admin/studies/:studyId/esm-schedule', requireAdmin, async (req, res) => {
    try {
      const study = await getStudy(req.params.studyId);
      if (!study) return res.status(404).json({ error: 'study not found' });
      res.json(scheduleResponse(study, 'esm_schedule'));
    } catch (err) {
      console.error(`[admin get esm schedule ${req.params.studyId}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.put('/admin/studies/:studyId/esm-schedule', requireAdmin, async (req, res) => {
    try {
      const study = await getStudy(req.params.studyId);
      if (!study) return res.status(404).json({ error: 'study not found' });

      const esmSchedule = buildEsmScheduleFromRequest(req.body || {}, 'esm_survey');
      const updated = await updateStudyConfig(req.params.studyId, { esm_schedule: esmSchedule });
      res.json(scheduleResponse(updated, 'esm_schedule'));
    } catch (err) {
      if (err.statusCode) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      console.error(`[admin esm schedule ${req.params.studyId}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  // GET /admin/export/:sensor?format=json|csv&device_id=&limit=&offset=
  //   Exports stored rows for one sensor. JSON (default) returns an array of
  //   { id, device_id, timestamp, data, created_at }. CSV flattens the JSON
  //   `data` object into columns (union of keys across the returned page).
  app.get('/admin/export/:sensor', requireAdmin, async (req, res) => {
    const { format = 'json', study_id: studyId, device_id: deviceId, limit, offset } = req.query;
    try {
      const rows = await exportDashboardSensorRows(req.params.sensor, { studyId, deviceId, limit, offset });
      if (format === 'csv') {
        const csv = rowsToCsv(rows, exportColumnsForSensor(req.params.sensor));
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${req.params.sensor}.csv"`);
        return res.send(csv);
      }
      return res.json({ ok: true, sensor: req.params.sensor, count: rows.length, rows });
    } catch (err) {
      if (err.statusCode) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      console.error(`[admin export ${req.params.sensor}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  // ---- Researcher dashboard API --------------------------------------------
  app.get('/api/v1/studies/:studyId/dashboard/summary', requireResearcher, async (req, res) => {
    try {
      const overview = await getStudyOverview(req.params.studyId);
      if (!overview) return res.status(404).json({ error: 'study not found' });
      await attachStudyDerivedSensors(overview, req.params.studyId);
      overview.withdrawals = await listWithdrawals(req.params.studyId);
      res.json({ ok: true, ...overview });
    } catch (err) {
      console.error(`[dashboard summary ${req.params.studyId}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.get('/api/v1/studies/:studyId/export/:sensor', requireResearcher, async (req, res) => {
    const { format = 'json', device_id: deviceId, limit, offset } = req.query;
    try {
      const rows = await exportDashboardSensorRows(req.params.sensor, {
        studyId: req.params.studyId,
        deviceId,
        limit,
        offset,
      });
      if (format === 'csv') {
        const csv = rowsToCsv(rows, exportColumnsForSensor(req.params.sensor));
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${req.params.studyId}-${req.params.sensor}.csv"`);
        return res.send(csv);
      }
      return res.json({ ok: true, sensor: req.params.sensor, count: rows.length, rows });
    } catch (err) {
      if (err.statusCode) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      console.error(`[dashboard export ${req.params.studyId}/${req.params.sensor}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.get('/api/v1/studies/:studyId/esm-schedule', requireResearcher, async (req, res) => {
    try {
      res.json(scheduleResponse(req.study, 'esm_schedule'));
    } catch (err) {
      console.error(`[researcher get esm schedule ${req.params.studyId}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.put('/api/v1/studies/:studyId/esm-schedule', requireResearcher, async (req, res) => {
    try {
      const esmSchedule = buildEsmScheduleFromRequest(req.body || {}, 'esm_survey');
      const updated = await updateStudyConfig(req.params.studyId, { esm_schedule: esmSchedule });
      res.json(scheduleResponse(updated, 'esm_schedule'));
    } catch (err) {
      if (err.statusCode) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      console.error(`[researcher save esm schedule ${req.params.studyId}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.get('/api/v1/studies/:studyId/battery-screenshot-schedule', requireResearcher, async (req, res) => {
    try {
      res.json(scheduleResponse(req.study, 'battery_screenshot_schedule'));
    } catch (err) {
      console.error(`[researcher get battery screenshot schedule ${req.params.studyId}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.put('/api/v1/studies/:studyId/battery-screenshot-schedule', requireResearcher, async (req, res) => {
    try {
      const batterySchedule = buildEsmScheduleFromRequest(req.body || {}, 'battery_usage_screenshot');
      const updated = await updateStudyConfig(req.params.studyId, {
        battery_screenshot_schedule: batterySchedule,
        esm_schedule: scheduleForKey(req.study, 'esm_schedule'),
      });
      res.json(scheduleResponse(updated, 'battery_screenshot_schedule'));
    } catch (err) {
      if (err.statusCode) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      console.error(`[researcher save battery screenshot schedule ${req.params.studyId}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.get('/api/v1/studies/:studyId/screen-time-activity-schedule', requireResearcher, async (req, res, next) => {
    try {
      res.json(scheduleResponse(req.study, 'screen_time_activity_schedule'));
    } catch (err) {
      next(err);
    }
  });

  app.put('/api/v1/studies/:studyId/screen-time-activity-schedule', requireResearcher, async (req, res, next) => {
    try {
      const activitySchedule = buildEsmScheduleFromRequest(req.body || {}, ACTIVITY_PROMPT);
      const updated = await updateStudyConfig(req.params.studyId, { screen_time_activity_schedule: activitySchedule });
      res.json(scheduleResponse(updated, 'screen_time_activity_schedule'));
    } catch (err) {
      next(err);
    }
  });

  // Unified screenshot upload (Battery or Screen Time "See All Activity").
  app.post('/api/v1/studies/:studyId/usage-screenshots', requireParticipant, async (req, res) => {
    try {
      return await handleUsageScreenshotUpload(req, res, req.params.studyId);
    } catch (err) {
      console.error(`[usage screenshot upload ${req.params.studyId}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.get('/api/v1/studies/:studyId/dashboard/screen-time-activity', requireResearcher, async (req, res, next) => {
    try {
      await processScreenTimeActivityUploads({ studyId: req.params.studyId, limit: req.query.limit });
      const table = safeTableName(SCREEN_TIME_ACTIVITY_SENSOR);
      const rows = (await tableExists(table))
        ? await exportRows(table, { studyId: req.params.studyId, limit: req.query.limit || 200, order: 'desc' })
        : [];
      res.json({ ok: true, count: rows.length, rows: rows.map(rowForDashboard) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/studies/:studyId/battery-screenshots', requireParticipant, async (req, res) => {
    try {
      return await handleBatteryScreenshotUpload(req, res, req.params.studyId);
    } catch (err) {
      console.error(`[battery screenshot upload ${req.params.studyId}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.post('/index.php/webservice/index/:studyId/:password/battery-screenshots', requireParticipant, async (req, res) => {
    try {
      return await handleBatteryScreenshotUpload(req, res, req.params.studyId);
    } catch (err) {
      console.error(`[battery screenshot upload ${req.params.studyId}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.get('/api/v1/studies/:studyId/dashboard/esm-responses', requireResearcher, async (req, res) => {
    try {
      const rows = await findEsmResponseRows(req.params.studyId, req.query.limit);
      return res.json({ ok: true, count: rows.length, rows });
    } catch (err) {
      console.error(`[dashboard esm responses ${req.params.studyId}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.get('/api/v1/studies/:studyId/dashboard/battery-usage', requireResearcher, async (req, res) => {
    try {
      const diagnostics = await findBatteryUsageDiagnostics({
        studyId: req.params.studyId,
        limit: req.query.limit,
      });
      return res.json({ ok: true, ...diagnostics });
    } catch (err) {
      console.error(`[dashboard battery usage ${req.params.studyId}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.get('/api/v1/studies/:studyId/dashboard/participant-health', requireResearcher, async (req, res) => {
    try {
      const rows = await deriveParticipantHealthRows({ studyId: req.params.studyId });
      return res.json({ ok: true, count: rows.length, rows: rows.map(rowForDashboard) });
    } catch (err) {
      console.error(`[dashboard participant health ${req.params.studyId}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.get('/api/v1/studies/:studyId/dashboard/location-daily-summary', requireResearcher, async (req, res) => {
    try {
      const rows = await deriveLocationDailySummaries({
        studyId: req.params.studyId,
        limit: req.query.limit,
      });
      return res.json({ ok: true, count: rows.length, rows: rows.map(rowForDashboard) });
    } catch (err) {
      console.error(`[dashboard location summary ${req.params.studyId}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  // Whole-study export: every raw table, every derived export, devices,
  // withdrawals, a codebook, and a README, as CSVs in one ZIP.
  app.get('/api/v1/studies/:studyId/export.zip', requireResearcher, async (req, res, next) => {
    try {
      await writeStudyExportZip(res, req.params.studyId, { includeImages: req.query.images === '1' });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/v1/studies/:studyId/dashboard/phone-use-daily', requireResearcher, async (req, res, next) => {
    try {
      const rows = await derivePhoneUseDaily({ studyId: req.params.studyId, limit: req.query.limit });
      res.json({ ok: true, count: rows.length, rows: rows.map(rowForDashboard) });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/v1/studies/:studyId/dashboard/survey-quality', requireResearcher, async (req, res) => {
    try {
      const rows = await deriveSurveyQualityRows({
        studyId: req.params.studyId,
        limit: req.query.limit,
      });
      return res.json({ ok: true, count: rows.length, rows: rows.map(rowForDashboard) });
    } catch (err) {
      console.error(`[dashboard survey quality ${req.params.studyId}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.get('/api/v1/studies/:studyId/media/:sensor/:rowId/image', requireResearcher, async (req, res) => {
    try {
      const image = await imageFromEsmRow(req.params.studyId, req.params.sensor, req.params.rowId);
      if (!image) return res.status(404).json({ error: 'image not found' });
      res.setHeader('Content-Type', image.contentType);
      res.setHeader('Content-Disposition', `inline; filename="studytrace-esm-${req.params.rowId}.${image.extension}"`);
      return res.send(image.buffer);
    } catch (err) {
      console.error(`[dashboard esm image ${req.params.studyId}/${req.params.rowId}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.get('/api/v1/studies/:studyId/media/esms/:rowId/image', requireResearcher, async (req, res) => {
    try {
      const image = await imageFromEsmRow(req.params.studyId, 'esms', req.params.rowId);
      if (!image) return res.status(404).json({ error: 'image not found' });
      res.setHeader('Content-Type', image.contentType);
      res.setHeader('Content-Disposition', `inline; filename="studytrace-esm-${req.params.rowId}.${image.extension}"`);
      return res.send(image.buffer);
    } catch (err) {
      console.error(`[dashboard esm image ${req.params.studyId}/${req.params.rowId}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  // DELETE /api/v1/studies/:studyId/participants/:deviceId (researcher)
  //   Removes every row the device uploaded, across all sensor tables, and
  //   logs the deletion in the withdrawals audit table.
  app.delete('/api/v1/studies/:studyId/participants/:deviceId', requireResearcher, async (req, res, next) => {
    try {
      const result = await deleteParticipantData(req.params.studyId, req.params.deviceId, 'researcher');
      res.json({ ok: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  // ---- Ingestion front-ends (shared storage) --------------------------------
  app.use('/', createAwareRouter(getPublicBaseUrl));
  app.use('/api/v1', createGenericApiRouter());

  // Async failures (e.g. a transient DB error) become a 500 instead of an
  // unhandled rejection that would take the process down.
  app.use((err, req, res, _next) => {
    console.error(`[${req.method} ${req.path}]`, err);
    if (res.headersSent) return;
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload too large' });
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'server error' });
  });

  return app;
}

async function deleteParticipantData(studyId, deviceId, source) {
  const participant = await getDeviceParticipant(studyId, deviceId);
  const rowsDeleted = await deleteDeviceData(studyId, deviceId);
  await recordWithdrawal({ studyId, deviceId, participant, source, deleteData: true, rowsDeleted });
  return { device_id: deviceId, rows_deleted: rowsDeleted };
}

async function listAdminSensorsForDashboard() {
  const sensors = filterLegacyScreenTimeSensors(await listSensorTables());
  const batteryDiagnostics = await findBatteryUsageDiagnostics({ limit: BATTERY_USAGE_EXPORT_LIMIT });
  upsertVirtualSensor(sensors, BATTERY_USAGE_EXPORT_SENSOR, batteryDiagnostics.appRows.length, 'derived_from_battery_screenshot_esm');
  const locationRows = await deriveLocationDailySummaries({ limit: BATTERY_USAGE_EXPORT_LIMIT });
  const surveyRows = await deriveSurveyQualityRows({ limit: BATTERY_USAGE_EXPORT_LIMIT });
  const healthRows = await deriveParticipantHealthRows({});
  upsertVirtualSensor(sensors, PHONE_USE_DAILY_SENSOR, (await derivePhoneUseDaily({ limit: BATTERY_USAGE_EXPORT_LIMIT })).length, 'virtual_derived_sensor');
  upsertVirtualSensor(sensors, APP_USAGE_COMBINED_SENSOR, (await deriveAppUsageCombined({})).length, 'virtual_derived_sensor');
  upsertVirtualSensor(sensors, SCREEN_TIME_ACTIVITY_SENSOR, await countDerivedActivityRows({}), 'derived_from_screen_time_screenshot_esm');
  upsertVirtualSensor(sensors, LOCATION_DAILY_SUMMARY_SENSOR, locationRows.length, 'virtual_derived_sensor');
  upsertVirtualSensor(sensors, SURVEY_QUALITY_SENSOR, surveyRows.length, 'virtual_derived_sensor');
  upsertVirtualSensor(sensors, PARTICIPANT_HEALTH_SENSOR, healthRows.length, 'virtual_derived_sensor');
  return sensors.sort((a, b) => String(a.sensor).localeCompare(String(b.sensor)));
}

async function attachStudyDerivedSensors(overview, studyId) {
  const batteryDiagnostics = await findBatteryUsageDiagnostics({ studyId, limit: BATTERY_USAGE_EXPORT_LIMIT });
  const locationRows = await deriveLocationDailySummaries({ studyId, limit: BATTERY_USAGE_EXPORT_LIMIT });
  const surveyRows = await deriveSurveyQualityRows({ studyId, limit: BATTERY_USAGE_EXPORT_LIMIT });
  const healthRows = await deriveParticipantHealthRows({ studyId });

  overview.sensors = filterLegacyScreenTimeSensors(overview.sensors || []);
  upsertVirtualSensor(overview.sensors, BATTERY_USAGE_EXPORT_SENSOR, batteryDiagnostics.appRows.length, 'derived_from_battery_screenshot_esm');
  upsertVirtualSensor(overview.sensors, SCREEN_TIME_ACTIVITY_SENSOR, await countDerivedActivityRows({ studyId }), 'derived_from_screen_time_screenshot_esm');
  upsertVirtualSensor(overview.sensors, PHONE_USE_DAILY_SENSOR, (await derivePhoneUseDaily({ studyId, limit: BATTERY_USAGE_EXPORT_LIMIT })).length, 'virtual_derived_sensor');
  upsertVirtualSensor(overview.sensors, APP_USAGE_COMBINED_SENSOR, (await deriveAppUsageCombined({ studyId })).length, 'virtual_derived_sensor');
  upsertVirtualSensor(overview.sensors, LOCATION_DAILY_SUMMARY_SENSOR, locationRows.length, 'virtual_derived_sensor');
  upsertVirtualSensor(overview.sensors, SURVEY_QUALITY_SENSOR, surveyRows.length, 'virtual_derived_sensor');
  upsertVirtualSensor(overview.sensors, PARTICIPANT_HEALTH_SENSOR, healthRows.length, 'virtual_derived_sensor');
  overview.sensors.sort((a, b) => Number(b.rows || 0) - Number(a.rows || 0) || String(a.sensor).localeCompare(String(b.sensor)));
  const totalRows = overview.sensors.reduce((sum, sensor) => sum + Number(sensor.rows || 0), 0);
  overview.summary = {
    ...(overview.summary || {}),
    sensor_count: overview.sensors.length,
    total_rows: totalRows,
  };
  return overview;
}

function filterLegacyScreenTimeSensors(sensors) {
  return [...(sensors || [])].filter((sensor) => !isLegacyScreenTimeSensor(sensor?.sensor));
}

function isLegacyScreenTimeSensor(sensor) {
  return LEGACY_SCREEN_TIME_SENSORS.has(String(sensor || '').toLowerCase());
}

function upsertVirtualSensor(sensors, sensorName, rows, tableName = 'virtual_derived_sensor') {
  const existing = sensors.find((sensor) => sensor.sensor === sensorName);
  if (existing) {
    existing.rows = rows;
    existing.table = tableName;
    return;
  }
  sensors.push({
    sensor: sensorName,
    table: tableName,
    rows,
  });
}

function exportColumnsForSensor(sensor) {
  if (sensor === BATTERY_USAGE_EXPORT_SENSOR) return BATTERY_USAGE_EXPORT_COLUMNS;
  if (sensor === SCREEN_TIME_ACTIVITY_SENSOR) return SCREEN_TIME_ACTIVITY_COLUMNS;
  if (sensor === PHONE_USE_DAILY_SENSOR) return PHONE_USE_DAILY_COLUMNS;
  if (sensor === APP_USAGE_COMBINED_SENSOR) return APP_USAGE_COMBINED_COLUMNS;
  if (sensor === LOCATION_DAILY_SUMMARY_SENSOR) return LOCATION_DAILY_SUMMARY_COLUMNS;
  if (sensor === SURVEY_QUALITY_SENSOR) return SURVEY_QUALITY_COLUMNS;
  if (sensor === PARTICIPANT_HEALTH_SENSOR) return PARTICIPANT_HEALTH_COLUMNS;
  return [];
}

async function exportDashboardSensorRows(sensor, { studyId, deviceId, limit, offset } = {}) {
  if (isLegacyScreenTimeSensor(sensor)) {
    throw httpError(404, 'retired app-usage export has been removed; use battery_usage_apps');
  }

  if (sensor === BATTERY_USAGE_EXPORT_SENSOR) {
    await processBatteryScreenshotUploads({ studyId, limit: BATTERY_USAGE_EXPORT_LIMIT });
    const table = safeTableName(BATTERY_USAGE_EXPORT_SENSOR);
    if (!table) throw httpError(400, 'invalid sensor name');
    return exportRows(table, { studyId, deviceId, limit, offset });
  }

  if (sensor === SCREEN_TIME_ACTIVITY_SENSOR) {
    await processScreenTimeActivityUploads({ studyId, limit: BATTERY_USAGE_EXPORT_LIMIT });
    const table = safeTableName(SCREEN_TIME_ACTIVITY_SENSOR);
    if (!(await tableExists(table))) return [];
    return exportRows(table, { studyId, deviceId, limit, offset });
  }

  if (sensor === APP_USAGE_COMBINED_SENSOR) {
    return derivedRowsForExport(await deriveAppUsageCombined({ studyId, deviceId }), { studyId, deviceId, offset });
  }

  if (sensor === PHONE_USE_DAILY_SENSOR) {
    return derivedRowsForExport(await derivePhoneUseDaily({ studyId, deviceId, limit }), { studyId, deviceId, offset });
  }

  if (sensor === LOCATION_DAILY_SUMMARY_SENSOR) {
    return derivedRowsForExport(await deriveLocationDailySummaries({ studyId, deviceId, limit }), { studyId, deviceId, offset });
  }

  if (sensor === SURVEY_QUALITY_SENSOR) {
    return derivedRowsForExport(await deriveSurveyQualityRows({ studyId, deviceId, limit }), { studyId, deviceId, offset });
  }

  if (sensor === PARTICIPANT_HEALTH_SENSOR) {
    return derivedRowsForExport(await deriveParticipantHealthRows({ studyId, deviceId }), { studyId, deviceId, offset });
  }

  const table = safeTableName(sensor);
  if (!table) throw httpError(400, 'invalid sensor name');
  return exportRows(table, { studyId, deviceId, limit, offset });
}

function derivedRowsForExport(rows, { studyId, deviceId, offset } = {}) {
  const start = Math.max(Number(offset) || 0, 0);
  return rows
    .filter((row) => !studyId || row.study_id === studyId)
    .filter((row) => !deviceId || row.device_id === deviceId)
    .slice(start)
    .map((row, index) => ({
      id: index + 1 + start,
      study_id: row.study_id,
      device_id: row.device_id,
      timestamp: row.timestamp || null,
      data: { ...(row.data || {}) },
      created_at: row.created_at || new Date().toISOString(),
    }));
}

function rowForDashboard(row) {
  return {
    id: row.id,
    study_id: row.study_id,
    device_id: row.device_id,
    timestamp: row.timestamp,
    created_at: row.created_at,
    ...(row.data || {}),
  };
}

async function deriveLocationDailySummaries({ studyId, deviceId, limit: rawLimit } = {}) {
  const limit = Math.min(Math.max(Number(rawLimit) || 1000, 1), BATTERY_USAGE_EXPORT_LIMIT);
  const sourceRows = await rowsForSensorCandidates(['locations', 'fused_locations', 'google_fused_location'], { studyId, deviceId, limit: BATTERY_USAGE_EXPORT_LIMIT });
  const resolveZone = await timeZoneResolverFor({ studyId, deviceId });
  const points = sourceRows
    .map((row) => locationPointFromRow(row, resolveZone))
    .filter(Boolean)
    .sort((a, b) => a.timestampMs - b.timestampMs);
  const groups = new Map();

  for (const point of points) {
    const key = `${point.study_id}::${point.device_id || ''}::${point.date}::${point.timezone}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(point);
  }

  const summaries = [];
  for (const groupPoints of groups.values()) {
    summaries.push(locationDailySummaryFromPoints(groupPoints));
  }

  return summaries
    .sort((a, b) => String(b.data.date).localeCompare(String(a.data.date)) || String(a.device_id).localeCompare(String(b.device_id)))
    .slice(0, limit);
}

async function deriveSurveyQualityRows({ studyId, deviceId, limit: rawLimit } = {}) {
  const limit = Math.min(Math.max(Number(rawLimit) || 200, 1), BATTERY_USAGE_EXPORT_LIMIT);
  const rows = studyId
    ? await findEsmResponseRows(studyId, limit)
    : await allEsmResponseRows(limit);
  const resolveZone = await timeZoneResolverFor({ studyId, deviceId });

  return rows
    .filter((row) => !deviceId || row.device_id === deviceId)
    .map((row) => {
      const esmJson = parseEsmJson(row.data?.esm_json);
      const answer = row.data?.esm_user_answer;
      const answered = answer !== null && answer !== undefined && String(answer).trim() !== '';
      const answerKind = answerKindFor(answer, esmJson);
      const answerLength = answer === null || answer === undefined
        ? 0
        : (typeof answer === 'string' ? answer.length : JSON.stringify(answer).length);
      const responseLatency = responseLatencySeconds(row);
      const status = row.data?.esm_status === undefined || row.data?.esm_status === null || row.data?.esm_status === ''
        ? ''
        : Number(row.data.esm_status);
      const flags = [];
      if (status === 1) flags.push('dismissed');
      if (status === 3) flags.push('expired');
      if (!answered && status !== 1 && status !== 3) flags.push('missing_answer');
      if (answerKind === 'photo') flags.push('photo_response');
      if (responseLatency !== null && responseLatency > 60 * 60) flags.push('long_latency');
      if (esmJson.studytrace_required === true && !answered) flags.push('required_missing');

      return {
        study_id: row.study_id,
        device_id: row.device_id,
        timestamp: row.timestamp,
        created_at: row.created_at,
        data: {
          source_sensor: row.sensor || '',
          source_row_id: String(row.id),
          question_title: esmJson.esm_title || '',
          question_trigger: row.data?.esm_trigger || esmJson.esm_trigger || '',
          question_type: Number(esmJson.esm_type || 0) || '',
          answered,
          esm_status: status,
          status_label: ESM_STATUS_LABELS[status] || '',
          answer_kind: answerKind,
          answer_length: answerLength,
          response_latency_seconds: responseLatency,
          submitted_at: submittedAt(row),
          ...localDateFields(row, resolveZone),
          quality_flags: flags.join(';'),
        },
      };
    })
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
    .slice(0, limit);
}

async function deriveParticipantHealthRows({ studyId, deviceId } = {}) {
  const studies = studyId
    ? [{ study_id: studyId }]
    : await listStudies();
  const rows = [];

  for (const study of studies) {
    const overview = await getStudyOverview(study.study_id);
    if (!overview) continue;
    const batteryDiagnostics = await findBatteryUsageDiagnostics({ studyId: study.study_id, limit: BATTERY_USAGE_EXPORT_LIMIT });
    const surveyRows = await deriveSurveyQualityRows({ studyId: study.study_id, limit: BATTERY_USAGE_EXPORT_LIMIT });
    const locationRows = await rowsForSensorCandidates(['locations', 'fused_locations', 'google_fused_location'], { studyId: study.study_id, limit: BATTERY_USAGE_EXPORT_LIMIT });
    // Windowed read (not a row cap) so busy studies keep accurate 7-day metrics.
    const clientEventsTable = safeTableName(CLIENT_EVENTS_SENSOR);
    const clientEvents = (await tableExists(clientEventsTable))
      ? (await rowsSince(clientEventsTable, { studyId: study.study_id, sinceMs: Date.now() - SEVEN_DAYS_MS }))
          .map((row) => ({ ...row, sensor: CLIENT_EVENTS_SENSOR }))
      : [];
    const deviceStates = await rowsForSensorCandidates([DEVICE_STATE_SENSOR], { studyId: study.study_id, limit: BATTERY_USAGE_EXPORT_LIMIT });
    const deviceStateTable = safeTableName(DEVICE_STATE_SENSOR);
    const recentDeviceStates = (await tableExists(deviceStateTable))
      ? await rowsSince(deviceStateTable, { studyId: study.study_id, sinceMs: Date.now() - SEVEN_DAYS_MS })
      : [];
    const androidUsage = await rowsForSensorCandidates(['android_app_usage'], { studyId: study.study_id, limit: BATTERY_USAGE_EXPORT_LIMIT });

    for (const device of overview.devices || []) {
      if (deviceId && device.device_id !== deviceId) continue;
      const latestEvent = latestForDevice(clientEvents, device.device_id);
      const latestState = latestForDevice(deviceStates, device.device_id);
      const recentEvents = rowsInLastHours(clientEvents.filter((row) => row.device_id === device.device_id), 24);
      const locationCount = locationRows.filter((row) => row.device_id === device.device_id).length;
      const esmCount = surveyRows.filter((row) => row.device_id === device.device_id).length;
      const screenshotCount = batteryDiagnostics.screenshotRows.filter((row) => row.device_id === device.device_id).length;
      const appRowsCount = batteryDiagnostics.appRows.filter((row) => row.device_id === device.device_id).length;
      const uploadFailures = recentEvents.filter((row) => String(row.data?.event_name || '').includes('upload_failed')).length;
      const notificationTaps = recentEvents.filter((row) => row.data?.event_name === 'notification_tapped').length;
      const state = latestState?.data || {};
      const deviceEvents = clientEvents.filter((row) => row.device_id === device.device_id);
      // Clients number client_events and device_state rows from one counter.
      const telemetry = telemetryQuality(deviceEvents, [
        ...deviceEvents,
        ...recentDeviceStates.filter((row) => row.device_id === device.device_id),
      ]);
      const platform = platformOf(latestState?.data || {});
      const androidUsageRows = androidUsage.filter((row) => row.device_id === device.device_id).length;
      const compliance = complianceFor({
        events: deviceEvents,
        surveyRows: surveyRows.filter((row) => row.device_id === device.device_id),
      });
      const notes = healthNotes({ device, state, platform, locationCount, esmCount, screenshotCount, androidUsageRows, uploadFailures, telemetry, compliance });

      rows.push({
        study_id: study.study_id,
        device_id: device.device_id,
        timestamp: toEpochMs(device.last_seen) || null,
        created_at: new Date().toISOString(),
        data: {
          participant: device.participant || '',
          platform,
          last_seen: device.last_seen || '',
          last_client_event: latestEvent ? submittedAt(latestEvent) : '',
          last_heartbeat: telemetry.lastHeartbeat ? new Date(telemetry.lastHeartbeat).toISOString() : '',
          max_telemetry_gap_hours_24h: telemetry.maxGapHours24h,
          last_launch_reason: telemetry.lastLaunchReason,
          last_device_state: latestState ? submittedAt(latestState) : '',
          timezone: state.timezone || '',
          notification_authorization: state.notification_authorization || '',
          location_authorization: state.location_authorization || '',
          location_accuracy_authorization: state.location_accuracy_authorization || '',
          background_refresh_status: state.background_refresh_status || '',
          battery_level: state.battery_level ?? '',
          low_power_mode_enabled: state.low_power_mode_enabled ?? '',
          prompts_delivered_7d: compliance.promptsDelivered,
          survey_sessions_7d: compliance.surveySessions,
          compliance_rate_7d: compliance.rate,
          surveys_dismissed_7d: compliance.dismissed,
          surveys_expired_7d: compliance.expired,
          telemetry_missing_7d: telemetry.missingRows,
          permission_changes_7d: telemetry.permissionChanges,
          location_rows: locationCount,
          esm_rows: esmCount,
          battery_screenshot_rows: screenshotCount,
          battery_app_rows: appRowsCount,
          android_app_usage_rows: androidUsageRows,
          upload_failures_24h: uploadFailures,
          notification_taps_24h: notificationTaps,
          health_status: notes.length ? 'needs_attention' : 'ok',
          notes: notes.join('; '),
        },
      });
    }
  }

  return rows.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
}

// ---- Cross-platform app usage ---------------------------------------------
//
// One table for app-level usage from every source, with explicit construct
// and window columns: iOS Battery screenshots (on-screen time over the
// selected window), iOS Screen Time screenshots (one day), and Android
// UsageStats foreground time (one day). They measure different things.
async function deriveAppUsageCombined({ studyId, deviceId } = {}) {
  const resolveZone = await timeZoneResolverFor({ studyId, deviceId });
  const out = [];
  const add = (row, data) => out.push({
    study_id: row.study_id,
    device_id: row.device_id,
    timestamp: row.timestamp,
    created_at: row.created_at,
    data,
  });

  await processBatteryScreenshotUploads({ studyId, limit: BATTERY_USAGE_EXPORT_LIMIT });
  for (const row of await rowsForSensorCandidates([BATTERY_USAGE_EXPORT_SENSOR], { studyId, deviceId, limit: BATTERY_USAGE_EXPORT_LIMIT })) {
    const data = row.data || {};
    if (!data.app_name || !['parsed', 'confirmed'].includes(data.extraction_status)) continue;
    const at = toEpochMs(data.captured_at) || toEpochMs(row.timestamp);
    const timezone = resolveZone(row.study_id, row.device_id, at);
    add(row, {
      date: localDateFor(at, timezone),
      timezone,
      platform: 'ios',
      construct: 'battery_on_screen_time',
      usage_window: data.usage_window || 'unknown',
      app_name: data.app_name,
      package_name: '',
      seconds: data.screen_time_seconds ?? '',
      source: 'battery_screenshot',
      extraction_method: data.extraction_method || '',
      participant_edited: data.participant_edited === true,
    });
  }

  await processScreenTimeActivityUploads({ studyId, limit: BATTERY_USAGE_EXPORT_LIMIT });
  for (const row of await rowsForSensorCandidates([SCREEN_TIME_ACTIVITY_SENSOR], { studyId, deviceId, limit: BATTERY_USAGE_EXPORT_LIMIT })) {
    const data = row.data || {};
    if (data.row_type !== 'app' || !data.app_name) continue;
    const at = toEpochMs(row.timestamp);
    const timezone = resolveZone(row.study_id, row.device_id, at);
    add(row, {
      date: data.activity_date || localDateFor(at, timezone),
      timezone,
      platform: 'ios',
      construct: 'screen_time_app_total',
      usage_window: 'day',
      app_name: data.app_name,
      package_name: '',
      seconds: data.screen_time_seconds ?? '',
      source: 'screen_time_screenshot',
      extraction_method: data.extraction_method || '',
      participant_edited: data.participant_edited === true,
    });
  }

  for (const row of await rowsForSensorCandidates(['android_app_usage'], { studyId, deviceId, limit: BATTERY_USAGE_EXPORT_LIMIT })) {
    const data = row.data || {};
    if (!data.package_name && !data.app_label) continue;
    add(row, {
      date: data.date || '',
      timezone: data.timezone || '',
      platform: 'android',
      construct: 'foreground_time',
      usage_window: 'day',
      app_name: data.app_label || data.package_name,
      package_name: data.package_name || '',
      seconds: data.foreground_seconds ?? '',
      source: 'android_usage_stats',
      extraction_method: 'usage_stats',
      participant_edited: false,
    });
  }

  return out.sort((a, b) => String(b.data.date).localeCompare(String(a.data.date)));
}

const DERIVED_EXPORTS = [
  BATTERY_USAGE_EXPORT_SENSOR,
  SCREEN_TIME_ACTIVITY_SENSOR,
  APP_USAGE_COMBINED_SENSOR,
  PHONE_USE_DAILY_SENSOR,
  LOCATION_DAILY_SUMMARY_SENSOR,
  SURVEY_QUALITY_SENSOR,
  PARTICIPANT_HEALTH_SENSOR,
];
const EXPORT_PAGE = 10000;
const PAGED_DERIVED_EXPORTS = new Set([BATTERY_USAGE_EXPORT_SENSOR, SCREEN_TIME_ACTIVITY_SENSOR]);

async function writeStudyExportZip(res, studyId, { includeImages = false } = {}) {
  const generatedAt = new Date();
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition',
    `attachment; filename="${studyId}-export-${generatedAt.toISOString().slice(0, 10)}.zip"`);
  const zip = new ZipWriter(res);
  const files = [];
  const addCsv = async (name, csv) => {
    files.push({ name, columns: csv.split('\r\n')[0].split(',').filter(Boolean) });
    await zip.addFile(name, csv);
  };

  // Raw tables, paged so large studies are exported completely.
  const derivedTables = new Set(DERIVED_EXPORTS.map((sensor) => safeTableName(sensor)));
  const sensors = filterLegacyScreenTimeSensors(await listStudySensorTables(studyId))
    .filter((sensor) => !derivedTables.has(sensor.table));
  let imageCount = 0;
  for (const sensor of sensors) {
    const rows = [];
    for (let offset = 0; ; offset += EXPORT_PAGE) {
      const page = await exportRows(sensor.table, { studyId, limit: EXPORT_PAGE, offset });
      rows.push(...page);
      if (page.length < EXPORT_PAGE) break;
    }
    for (const row of rows) {
      const image = decodeImageAnswer(row.data?.esm_user_answer);
      if (!image) continue;
      const file = `media/${sensor.sensor}-${row.id}.${image.extension}`;
      row.data = { ...row.data, esm_user_answer: `image:${file}` };
      if (includeImages) {
        await zip.addFile(file, image.buffer);
        imageCount += 1;
      }
    }
    await addCsv(`raw/${sensor.sensor}.csv`, rowsToCsv(rows));
  }

  for (const sensor of DERIVED_EXPORTS) {
    const rows = [];
    for (let offset = 0; ; offset += EXPORT_PAGE) {
      const page = await exportDashboardSensorRows(sensor, { studyId, limit: EXPORT_PAGE, offset });
      rows.push(...page);
      // Only table-backed exports page; the others are computed in one pass.
      if (page.length < EXPORT_PAGE || !PAGED_DERIVED_EXPORTS.has(sensor)) break;
    }
    await addCsv(`${sensor}.csv`, rowsToCsv(rows, exportColumnsForSensor(sensor)));
  }

  await addCsv('devices.csv', objectsToCsv(await listStudyDevices(studyId), ['device_id', 'participant', 'first_seen', 'last_seen']));
  await addCsv('withdrawals.csv', objectsToCsv(await listWithdrawals(studyId),
    ['device_id', 'participant', 'source', 'delete_data', 'rows_deleted', 'requested_at']));

  const codebook = [];
  for (const file of files) {
    for (const column of file.columns) {
      codebook.push({ file: file.name, column, description: describeColumn(file.name, column) });
    }
  }
  await zip.addFile('codebook.csv', objectsToCsv(codebook, ['file', 'column', 'description']));
  await zip.addFile('README.txt', [
    `StudyTrace export for study ${studyId}`,
    `Generated ${generatedAt.toISOString()}`,
    '',
    'raw/            One CSV per table exactly as uploaded by the apps (JSON fields flattened into columns).',
    'root CSVs       Derived exports computed by the server (see codebook.csv for every column).',
    'devices.csv     Device ids and participant labels. withdrawals.csv lists withdrawals and deletions.',
    'codebook.csv    Description of every column in every file.',
    includeImages
      ? `media/          ${imageCount} photo/screenshot answer image(s); answers in raw/ point to them as image:<file>.`
      : 'Images         Not included. Photo answers are shown as image:<file>; request the export with images=1 to include them.',
    '',
    'Times: timestamp columns are epoch milliseconds (UTC); *_at columns are ISO 8601 UTC.',
    'Local days: date/local_date columns use the participant\'s phone-reported time zone (timezone column).',
    'Duplicate uploads were removed on arrival. Data of participants who asked for deletion is not included.',
    'app_usage_combined.csv mixes different constructs (Battery on-screen time, Screen Time daily totals,',
    'Android foreground time); filter by construct and usage_window before comparing.',
    '',
  ].join('\r\n'));
  await zip.finish();
}

function objectsToCsv(rows, columns) {
  const esc = (value) => {
    if (value === null || value === undefined) return '';
    const text = value instanceof Date ? value.toISOString() : (typeof value === 'object' ? JSON.stringify(value) : String(value));
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.join(','), ...rows.map((row) => columns.map((column) => esc(row[column])).join(','))].join('\r\n');
}

// ---- Phone use from lock/unlock events --------------------------------------
//
// iOS (AWARE plugin_device_usage): each lock-state change writes one row.
// elapsed_device_off > 0 marks an unlock (a pickup) after that many ms locked;
// elapsed_device_on > 0 marks a lock ending a session of that many ms.
// Android (android_screen_events): explicit unlock/lock (or screen_on/off)
// events. Both become sessions, split at the participant's local midnight.
async function derivePhoneUseDaily({ studyId, deviceId, limit: rawLimit } = {}) {
  const limit = Math.min(Math.max(Number(rawLimit) || 1000, 1), BATTERY_USAGE_EXPORT_LIMIT);
  const iosRows = await rowsForSensorCandidates(['plugin_device_usage'], { studyId, deviceId, limit: BATTERY_USAGE_EXPORT_LIMIT });
  const androidRows = await rowsForSensorCandidates(['android_screen_events'], { studyId, deviceId, limit: BATTERY_USAGE_EXPORT_LIMIT });
  if (!iosRows.length && !androidRows.length) return [];
  const resolveZone = await timeZoneResolverFor({ studyId, deviceId });

  const byDevice = new Map();
  const deviceEntry = (row, platform) => {
    const key = `${row.study_id}::${row.device_id}`;
    if (!byDevice.has(key)) {
      byDevice.set(key, { study_id: row.study_id, device_id: row.device_id, platform, sessions: [], pickups: [], rows: 0 });
    }
    const entry = byDevice.get(key);
    entry.rows += 1;
    return entry;
  };

  for (const row of iosRows) {
    const at = toEpochMs(row.timestamp ?? row.data?.timestamp);
    if (!at) continue;
    const entry = deviceEntry(row, 'ios');
    const onMs = Number(row.data?.elapsed_device_on ?? row.data?.double_elapsed_device_on) || 0;
    const offMs = Number(row.data?.elapsed_device_off ?? row.data?.double_elapsed_device_off) || 0;
    if (offMs > 0) entry.pickups.push(at);
    if (onMs > 0 && onMs <= MAX_SESSION_SECONDS * 1000) entry.sessions.push([at - onMs, at]);
  }

  const androidByDevice = new Map();
  for (const row of androidRows) {
    const at = toEpochMs(row.timestamp ?? row.data?.timestamp);
    if (!at) continue;
    const key = `${row.study_id}::${row.device_id}`;
    if (!androidByDevice.has(key)) androidByDevice.set(key, []);
    androidByDevice.get(key).push({ row, at, event: String(row.data?.event || '') });
  }
  for (const events of androidByDevice.values()) {
    events.sort((a, b) => a.at - b.at);
    // Prefer keyguard events; fall back to screen on/off on phones with no lock screen.
    const hasKeyguard = events.some((item) => item.event === 'unlock' || item.event === 'lock');
    const startEvent = hasKeyguard ? 'unlock' : 'screen_on';
    const endEvents = hasKeyguard ? ['lock', 'screen_off'] : ['screen_off'];
    let openAt = null;
    for (const item of events) {
      const entry = deviceEntry(item.row, 'android');
      if (item.event === startEvent) {
        entry.pickups.push(item.at);
        openAt = item.at;
      } else if (endEvents.includes(item.event) && openAt !== null) {
        if (item.at - openAt <= MAX_SESSION_SECONDS * 1000) entry.sessions.push([openAt, item.at]);
        openAt = null;
      }
    }
  }

  const days = new Map();
  const dayEntry = (device, timestamp) => {
    const timezone = resolveZone(device.study_id, device.device_id, timestamp);
    const date = localDateFor(timestamp, timezone);
    const key = `${device.study_id}::${device.device_id}::${date}`;
    if (!days.has(key)) {
      days.set(key, {
        study_id: device.study_id,
        device_id: device.device_id,
        platform: device.platform,
        date,
        timezone,
        pickups: 0,
        sessions: [],
        useMs: 0,
        nightMs: 0,
        first: null,
        last: null,
        rows: device.rows,
      });
    }
    return days.get(key);
  };

  for (const device of byDevice.values()) {
    for (const at of device.pickups) dayEntry(device, at).pickups += 1;
    for (const [start, end] of device.sessions) {
      // A session belongs to the day it started for counts and lengths...
      dayEntry(device, start).sessions.push(end - start);
      // ...while use time is split at local midnight.
      let cursor = start;
      while (cursor < end) {
        const day = dayEntry(device, cursor);
        const dayStart = localMidnight(day.date, day.timezone);
        const dayEnd = localMidnight(nextDate(day.date), day.timezone);
        const segmentEnd = Math.min(end, dayEnd);
        day.useMs += segmentEnd - cursor;
        const nightEnd = dayStart + NIGHT_END_HOUR * 3600000;
        day.nightMs += Math.max(0, Math.min(segmentEnd, nightEnd) - Math.max(cursor, dayStart));
        day.first = day.first === null ? cursor : Math.min(day.first, cursor);
        day.last = day.last === null ? segmentEnd : Math.max(day.last, segmentEnd);
        if (segmentEnd <= cursor) break;
        cursor = segmentEnd;
      }
    }
  }

  return [...days.values()]
    .map((day) => {
      const lengths = day.sessions.map((ms) => ms / 1000).sort((a, b) => a - b);
      const median = lengths.length
        ? (lengths.length % 2 ? lengths[(lengths.length - 1) / 2] : (lengths[lengths.length / 2 - 1] + lengths[lengths.length / 2]) / 2)
        : null;
      return {
        study_id: day.study_id,
        device_id: day.device_id,
        timestamp: localMidnight(day.date, day.timezone),
        created_at: new Date().toISOString(),
        data: {
          date: day.date,
          timezone: day.timezone,
          platform: day.platform,
          pickups: day.pickups,
          total_use_seconds: Math.round(day.useMs / 1000),
          session_count: lengths.length,
          median_session_seconds: median === null ? '' : Math.round(median),
          short_session_share: lengths.length ? Math.round((lengths.filter((l) => l < SHORT_SESSION_SECONDS).length / lengths.length) * 100) / 100 : '',
          long_session_count: lengths.filter((l) => l >= LONG_SESSION_SECONDS).length,
          night_use_seconds: Math.round(day.nightMs / 1000),
          first_use_at: day.first === null ? '' : new Date(day.first).toISOString(),
          last_use_at: day.last === null ? '' : new Date(day.last).toISOString(),
          source_rows: day.rows,
        },
      };
    })
    .sort((a, b) => String(b.data.date).localeCompare(String(a.data.date)) || String(a.device_id).localeCompare(String(b.device_id)))
    .slice(0, limit);
}

async function rowsForSensorCandidates(sensors, { studyId, deviceId, limit } = {}) {
  const rows = [];
  for (const sensor of sensors) {
    const table = safeTableName(sensor);
    if (!table || !(await tableExists(table))) continue;
    const sensorRows = await exportRows(table, { studyId, deviceId, limit, order: 'desc' });
    rows.push(...sensorRows.map((row) => ({ ...row, sensor })));
  }
  return rows;
}

async function allEsmResponseRows(limit) {
  const sensors = await listSensorTables();
  const rows = [];
  for (const sensor of sensors) {
    if (!isKnownEsmSensor(sensor.sensor)) continue;
    const table = safeTableName(sensor.sensor);
    if (!table) continue;
    const sensorRows = await exportRows(table, { limit, order: 'desc' });
    for (const row of sensorRows) {
      if (isEsmDataRow(row.data)) rows.push({ ...row, sensor: sensor.sensor });
    }
  }
  return rows;
}

function locationPointFromRow(row, resolveZone = () => 'UTC') {
  const data = row.data || {};
  const latitude = numberFrom(data.double_latitude ?? data.latitude ?? data.lat);
  const longitude = numberFrom(data.double_longitude ?? data.longitude ?? data.lon ?? data.lng);
  if (latitude === null || longitude === null) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  const timestampMs = toEpochMs(row.timestamp ?? data.timestamp ?? row.created_at);
  if (!timestampMs) return null;
  const timezone = resolveZone(row.study_id, row.device_id, timestampMs);
  return {
    study_id: row.study_id,
    device_id: row.device_id,
    timestampMs,
    timezone,
    date: localDateFor(timestampMs, timezone),
    latitude,
    longitude,
    accuracy: numberFrom(data.double_accuracy ?? data.accuracy ?? data.horizontal_accuracy),
  };
}

function locationDailySummaryFromPoints(points) {
  const sorted = [...points].sort((a, b) => a.timestampMs - b.timestampMs);
  let distanceMeters = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const distance = haversineMeters(sorted[i - 1], sorted[i]);
    if (distance < 10000) distanceMeters += distance;
  }
  const centroid = sorted.reduce((acc, point) => ({
    latitude: acc.latitude + point.latitude / sorted.length,
    longitude: acc.longitude + point.longitude / sorted.length,
  }), { latitude: 0, longitude: 0 });
  const radius = Math.sqrt(sorted.reduce((sum, point) => {
    const distance = haversineMeters(point, centroid);
    return sum + distance * distance;
  }, 0) / sorted.length);
  const accuracies = sorted.map((point) => point.accuracy).filter((value) => value !== null);
  return {
    study_id: sorted[0].study_id,
    device_id: sorted[0].device_id,
    timestamp: sorted[0].timestampMs,
    created_at: new Date().toISOString(),
    data: {
      date: sorted[0].date,
      timezone: sorted[0].timezone,
      location_rows: sorted.length,
      first_location_at: new Date(sorted[0].timestampMs).toISOString(),
      last_location_at: new Date(sorted[sorted.length - 1].timestampMs).toISOString(),
      coverage_minutes: Math.round((sorted[sorted.length - 1].timestampMs - sorted[0].timestampMs) / 60000),
      distance_meters: Math.round(distanceMeters),
      radius_of_gyration_meters: Math.round(radius),
      stop_count: estimateStopCount(sorted),
      mean_accuracy_meters: accuracies.length ? Math.round(accuracies.reduce((sum, value) => sum + value, 0) / accuracies.length) : '',
      max_accuracy_meters: accuracies.length ? Math.round(Math.max(...accuracies)) : '',
    },
  };
}

function estimateStopCount(points) {
  if (points.length < 3) return 0;
  let stops = 0;
  let clusterStart = 0;
  for (let i = 1; i < points.length; i += 1) {
    if (haversineMeters(points[clusterStart], points[i]) > 100) {
      const dwellMinutes = (points[i - 1].timestampMs - points[clusterStart].timestampMs) / 60000;
      if (dwellMinutes >= 15) stops += 1;
      clusterStart = i;
    }
  }
  const finalDwell = (points[points.length - 1].timestampMs - points[clusterStart].timestampMs) / 60000;
  if (finalDwell >= 15) stops += 1;
  return stops;
}

function haversineMeters(a, b) {
  const radius = 6371000;
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

function toRadians(value) {
  return Number(value) * Math.PI / 180;
}

function numberFrom(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toEpochMs(value) {
  if (value instanceof Date) return value.getTime();
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) {
    return number < 100000000000 ? number * 1000 : number;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function submittedAt(row) {
  const timestamp = toEpochMs(row.data?.double_esm_user_answer_timestamp ?? row.timestamp ?? row.created_at);
  return timestamp ? new Date(timestamp).toISOString() : '';
}

function responseLatencySeconds(row) {
  const submitted = toEpochMs(row.data?.double_esm_user_answer_timestamp);
  const prompted = toEpochMs(row.timestamp);
  if (!submitted || !prompted || submitted < prompted) return null;
  return Math.round((submitted - prompted) / 1000);
}

function answerKindFor(answer, esmJson) {
  if (answer === null || answer === undefined || String(answer).trim() === '') return 'empty';
  if (Number(esmJson?.esm_type) === 14 || decodeImageAnswer(answer)) return 'photo';
  if (typeof answer === 'object') return 'json';
  return 'text';
}

function latestForDevice(rows, deviceId) {
  return rows
    .filter((row) => row.device_id === deviceId)
    .sort((a, b) => (toEpochMs(b.timestamp ?? b.created_at) || 0) - (toEpochMs(a.timestamp ?? a.created_at) || 0))[0] || null;
}

function rowsInLastHours(rows, hours) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return rows.filter((row) => (toEpochMs(row.timestamp ?? row.created_at) || 0) >= cutoff);
}

function platformOf(state) {
  if (state.platform) return String(state.platform).toLowerCase();
  return /android/i.test(String(state.system_name || '')) ? 'android' : 'ios';
}

function healthNotes({ device, state, platform = 'ios', locationCount, esmCount, screenshotCount, androidUsageRows = 0, uploadFailures, telemetry = {}, compliance = {} }) {
  const notes = [];
  const lastSeen = toEpochMs(device.last_seen);
  if (!lastSeen || Date.now() - lastSeen > 48 * 60 * 60 * 1000) notes.push('device not seen in 48h');
  if (state.notification_authorization && !['authorized', 'provisional', 'ephemeral'].includes(state.notification_authorization)) notes.push('notifications not authorized');
  if (state.location_authorization && state.location_authorization !== 'authorized_always') notes.push('location not always authorized');
  if (locationCount === 0) notes.push('no location rows');
  if (esmCount === 0) notes.push('no ESM responses');
  if (platform === 'android') {
    if (androidUsageRows === 0) notes.push('no Android app usage rows');
    if (state.usage_access && state.usage_access !== 'granted') notes.push('usage access not granted');
  } else if (screenshotCount === 0) {
    notes.push('no Battery screenshots');
  }
  if (uploadFailures > 0) notes.push(`${uploadFailures} upload failure(s) in 24h`);
  if (telemetry.lastHeartbeat && Date.now() - telemetry.lastHeartbeat > 6 * 60 * 60 * 1000) notes.push('no heartbeat in 6h (app may have been killed)');
  if (telemetry.maxGapHours24h !== '' && telemetry.maxGapHours24h >= 12) notes.push(`telemetry gap of ${telemetry.maxGapHours24h}h in last 24h`);
  if (telemetry.missingRows > 0) notes.push(`${telemetry.missingRows} telemetry row(s) missing in 7d`);
  if (state.background_refresh_status && state.background_refresh_status !== 'available') notes.push(`background refresh ${state.background_refresh_status}`);
  if (state.location_accuracy_authorization === 'reduced') notes.push('precise location off');
  if (compliance.rate !== '' && compliance.promptsDelivered >= 4 && compliance.rate < 0.5) notes.push(`survey compliance ${Math.round(compliance.rate * 100)}% (7d)`);
  return notes;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
// AWARE ESM status codes.
const ESM_STATUS_LABELS = { 0: 'new', 1: 'dismissed', 2: 'answered', 3: 'expired' };
const PROMPT_EVENTS = new Set(['notification_delivered', 'notification_presented', 'notification_tapped']);

function eventMetadata(row) {
  const metadata = row?.data?.metadata;
  return metadata && typeof metadata === 'object' ? metadata : {};
}

// Heartbeat recency, the longest silence in the last 24h, and rows lost in
// transit (the client numbers every telemetry row with a sequence number).
function telemetryQuality(events, sequencedRows = events) {
  const now = Date.now();
  const times = events
    .map((row) => toEpochMs(row.timestamp ?? row.created_at))
    .filter(Boolean)
    .sort((a, b) => a - b);
  const heartbeats = events
    .filter((row) => row.data?.event_name === 'heartbeat')
    .map((row) => toEpochMs(row.timestamp))
    .filter(Boolean);
  const dayAgo = now - 24 * 60 * 60 * 1000;
  let maxGapMs = null;
  if (times.length) {
    const windowTimes = [dayAgo, ...times.filter((t) => t >= dayAgo), now];
    maxGapMs = 0;
    for (let i = 1; i < windowTimes.length; i += 1) {
      maxGapMs = Math.max(maxGapMs, windowTimes[i] - windowTimes[i - 1]);
    }
  }
  const seqs = [...new Set(sequencedRows.map((row) => Number(row.data?.seq)).filter(Number.isInteger))].sort((a, b) => a - b);
  const missingRows = seqs.length > 1 ? (seqs[seqs.length - 1] - seqs[0] + 1) - seqs.length : 0;
  const launches = events
    .filter((row) => row.data?.event_name === 'app_launch')
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  return {
    lastHeartbeat: heartbeats.length ? Math.max(...heartbeats) : null,
    maxGapHours24h: maxGapMs === null ? '' : Math.round((maxGapMs / 3600000) * 10) / 10,
    missingRows,
    permissionChanges: events.filter((row) => row.data?.event_name === 'permission_changed').length,
    lastLaunchReason: launches.length ? String(eventMetadata(launches[0]).launch_reason || '') : '',
  };
}

// Survey compliance over 7 days: distinct survey prompts the phone reported
// as delivered/presented/tapped vs. survey sessions answered (ESM answers
// submitted within 15 minutes of each other count as one session).
function complianceFor({ events, surveyRows }) {
  const since = Date.now() - SEVEN_DAYS_MS;
  const prompts = new Set();
  for (const row of events) {
    if (!PROMPT_EVENTS.has(row.data?.event_name)) continue;
    const metadata = eventMetadata(row);
    if (metadata.is_survey_prompt !== true && metadata.is_survey_prompt !== 'true') continue;
    const deliveredAt = toEpochMs(metadata.delivered_at) || toEpochMs(row.timestamp);
    if (!deliveredAt || deliveredAt < since) continue;
    prompts.add(`${metadata.notification_id || ''}|${Math.round(deliveredAt / 60000)}`);
  }
  const answerTimes = surveyRows
    .filter((row) => row.data?.answered)
    .map((row) => toEpochMs(row.data?.submitted_at))
    .filter((t) => t && t >= since)
    .sort((a, b) => a - b);
  let sessions = 0;
  let lastAnswer = -Infinity;
  for (const t of answerTimes) {
    if (t - lastAnswer > 15 * 60 * 1000) sessions += 1;
    lastAnswer = t;
  }
  const recentStatus = (code) => surveyRows.filter((row) => row.data?.esm_status === code &&
    (toEpochMs(row.data?.submitted_at) || toEpochMs(row.timestamp) || 0) >= since).length;
  return {
    promptsDelivered: prompts.size,
    surveySessions: sessions,
    dismissed: recentStatus(1),
    expired: recentStatus(3),
    rate: prompts.size ? Math.round(Math.min(1, sessions / prompts.size) * 100) / 100 : '',
  };
}

// Time-zone resolver for a study (or all studies), fed by the zone the iOS
// client stamps on every telemetry row.
async function timeZoneResolverFor({ studyId, deviceId } = {}) {
  const telemetry = await rowsForSensorCandidates([CLIENT_EVENTS_SENSOR, DEVICE_STATE_SENSOR], {
    studyId,
    deviceId,
    limit: BATTERY_USAGE_EXPORT_LIMIT,
  });
  const defaults = new Map();
  for (const id of new Set([studyId, ...telemetry.map((row) => row.study_id)].filter(Boolean))) {
    defaults.set(id, defaultTimeZoneForStudy(await getStudy(id)));
  }
  return buildTimeZoneResolver(telemetry, (id) => defaults.get(id) || defaultTimeZoneForStudy(null));
}

function localDateFields(row, resolveZone) {
  const at = toEpochMs(row.data?.double_esm_user_answer_timestamp ?? row.timestamp ?? row.created_at);
  if (!at) return { local_date: '', timezone: '' };
  const timezone = resolveZone(row.study_id, row.device_id, at);
  return { local_date: localDateFor(at, timezone), timezone };
}

// Flatten exported rows into CSV. Columns are id, study_id, device_id,
// timestamp, plus
// the union of keys found in each row's JSON `data`, then created_at. Values
// containing commas/quotes/newlines are quoted per RFC 4180.
function rowsToCsv(rows, preferredDataCols = []) {
  const dataKeys = new Set(preferredDataCols);
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

function scheduleResponse(study, key = 'esm_schedule') {
  const schedule = scheduleForKey(study, key);
  return {
    ok: true,
    study_id: study?.study_id,
    esm_schedule: schedule,
    schedule_summary: summarizeEsmSchedule(schedule),
  };
}

function summarizeEsmSchedule(schedule) {
  return schedule.map((item) => ({
    schedule_id: item.schedule_id,
    prompt_type: item.studytrace_prompt_type || '',
    mode: item.studytrace_delivery_mode || (Number(item.randomize || 0) > 0 ? 'random' : 'fixed'),
    times: Array.isArray(item.times) && item.times.length
      ? item.times
      : (Array.isArray(item.hours) ? item.hours.map((hour) => `${String(hour).padStart(2, '0')}:00`) : []),
    randomize_minutes: Number(item.randomize || 0),
    expiration_minutes: Number(item.expiration || 0),
    notification_title: item.notification_title || '',
    notification_body: item.notification_body || '',
    question_count: Array.isArray(item.esms) ? item.esms.length : 0,
  }));
}

function scheduleForKey(study, key = 'esm_schedule') {
  const config = study?.config || {};
  const esmSchedule = Array.isArray(config.esm_schedule) ? config.esm_schedule : [];
  const batterySchedule = Array.isArray(config.battery_screenshot_schedule) ? config.battery_screenshot_schedule : [];
  if (key === 'battery_screenshot_schedule') {
    return batterySchedule.length
      ? batterySchedule.filter((item) => schedulePromptType(item) === BATTERY_PROMPT)
      : esmSchedule.filter((item) => schedulePromptType(item) === BATTERY_PROMPT);
  }
  if (key === 'screen_time_activity_schedule') {
    const activitySchedule = Array.isArray(config.screen_time_activity_schedule) ? config.screen_time_activity_schedule : [];
    return activitySchedule.filter((item) => schedulePromptType(item) === ACTIVITY_PROMPT);
  }
  return esmSchedule.filter((item) => schedulePromptType(item) === 'esm_survey');
}

function schedulePromptType(item) {
  if (item?.studytrace_prompt_type) return normalizePromptType(item.studytrace_prompt_type);
  const scheduleId = String(item?.schedule_id || '').toLowerCase();
  if (scheduleId.includes('screen_time_activity')) return ACTIVITY_PROMPT;
  if (scheduleId.includes('battery_screenshot') || scheduleId.includes('battery_usage')) return BATTERY_PROMPT;
  return 'esm_survey';
}

function buildEsmScheduleFromRequest(body, defaultPromptType = 'esm_survey') {
  const mode = body.mode === 'random' ? 'random' : 'fixed';
  const promptType = normalizePromptType(body.prompt_type || body.studytrace_prompt_type || defaultPromptType);
  const promptTimes = parsePromptTimes(body.times || body.hours);
  const randomMinutes = mode === 'random'
    ? clampInteger(body.randomize_minutes, 1, 180, 30)
    : 0;
  const scheduleId = sanitizeScheduleId(body.schedule_id || `studytrace_${mode}_${scheduleSlugForPrompt(promptType)}`);
  const esms = parseEsmQuestions(body, promptType);

  return [
    {
      schedule_id: scheduleId,
      hours: promptTimes.hours,
      times: promptTimes.times,
      studytrace_prompt_type: promptType,
      studytrace_delivery_mode: mode,
      randomize: randomMinutes,
      expiration: clampInteger(body.expiration_minutes, 0, 1440, mode === 'random' ? randomMinutes * 2 : 120),
      start_date: normalizeDateString(body.start_date),
      end_date: normalizeDateString(body.end_date),
      notification_title: String(body.notification_title || defaultNotificationTitle(promptType)),
      notification_body: String(body.notification_body || defaultNotificationBody(promptType)),
      interface: 0,
      esms,
    },
  ];
}

function normalizePromptType(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'esm' || text === 'esm_survey' || text === 'survey') return 'esm_survey';
  if (text === ACTIVITY_PROMPT || text === 'screen_time_activity') return ACTIVITY_PROMPT;
  return BATTERY_PROMPT;
}

function scheduleSlugForPrompt(promptType) {
  if (promptType === 'esm_survey') return 'esm_survey';
  if (promptType === ACTIVITY_PROMPT) return 'screen_time_activity';
  return 'battery_screenshot';
}

function defaultNotificationTitle(promptType) {
  if (promptType === 'esm_survey') return 'StudyTrace survey available';
  if (promptType === ACTIVITY_PROMPT) return 'StudyTrace Screen Time screenshot';
  return 'StudyTrace Battery screenshot';
}

function defaultNotificationBody(promptType) {
  if (promptType === 'esm_survey') return 'Please complete your scheduled study survey.';
  if (promptType === ACTIVITY_PROMPT) return "Please upload yesterday's Screen Time activity screenshot.";
  return 'Please upload your iOS Battery usage screenshot.';
}

function parsePromptTimes(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || '').split(/[,\s]+/);
  const parsed = values
    .map((item) => parsePromptTime(item))
    .filter(Boolean);
  const uniqueTimes = [...new Map(parsed.map((item) => [item.time, item])).values()]
    .sort((a, b) => a.minutes - b.minutes);
  if (!uniqueTimes.length) {
    throw httpError(400, 'times must include at least one value from 00:00 to 23:59, for example 09:30 or 17');
  }
  return {
    times: uniqueTimes.map((item) => item.time),
    hours: [...new Set(uniqueTimes.map((item) => item.hour))].sort((a, b) => a - b),
  };
}

function parsePromptTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = text.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return {
    hour,
    minute,
    minutes: hour * 60 + minute,
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

function parseEsmQuestions(body, promptType = 'battery_usage_screenshot') {
  if (Array.isArray(body.esms)) return normalizeEsmArray(body.esms);
  if (body.esms_json) {
    try {
      const parsed = JSON.parse(body.esms_json);
      return normalizeEsmArray(parsed);
    } catch {
      throw httpError(400, 'esms_json must be valid JSON');
    }
  }
  return normalizeEsmArray(defaultEsmQuestions(promptType));
}

function normalizeEsmArray(value) {
  if (!Array.isArray(value) || !value.length) {
    throw httpError(400, 'survey must include at least one ESM question');
  }
  return value.map((item, index) => {
    const esm = item?.esm || item;
    if (!esm || typeof esm !== 'object') {
      throw httpError(400, `ESM question ${index + 1} must be an object`);
    }
    if (!Number.isInteger(Number(esm.esm_type))) {
      throw httpError(400, `ESM question ${index + 1} must include numeric esm_type`);
    }
    return {
      esm: {
        esm_submit: index === value.length - 1 ? 'Submit' : 'Next',
        esm_na: true,
        esm_expiration_threshold: 0,
        esm_trigger: `studytrace_q${index + 1}`,
        ...esm,
        esm_type: Number(esm.esm_type),
      },
    };
  });
}

function defaultEsmQuestions(promptType = 'battery_usage_screenshot') {
  if (promptType === 'esm_survey') {
    return [
      {
        esm_type: 2,
        esm_title: 'Current activity',
        esm_instructions: 'What are you doing right now?',
        esm_radios: ['Working or studying', 'Resting', 'Commuting', 'Socializing', 'Other'],
        esm_trigger: 'current_activity',
        esm_submit: 'Submit',
        esm_na: true,
        studytrace_required: true,
        studytrace_randomize_options: false,
        studytrace_branching: {},
      },
    ];
  }
  if (promptType === ACTIVITY_PROMPT) {
    return [
      {
        esm_type: 14,
        esm_title: 'Screen Time activity screenshot',
        esm_instructions: 'Open iPhone Settings → Screen Time → See All App & Website Activity, choose Day, tap yesterday, and take a screenshot showing screen time, pickups, and notifications. Then upload that screenshot here.',
        esm_trigger: ACTIVITY_PROMPT,
        esm_submit: 'Submit',
        esm_na: true,
        studytrace_required: true,
        studytrace_quality_check: 'participant_confirmed',
      },
    ];
  }
  return [
    {
      esm_type: 14,
      esm_title: 'Battery usage screenshot',
      esm_instructions: 'Open iPhone Settings → Battery → View All Battery Usage. Take a screenshot showing app battery usage and screen time, then upload that screenshot here.',
      esm_trigger: 'battery_usage_screenshot',
      esm_submit: 'Submit',
      esm_na: true,
      studytrace_required: true,
      studytrace_quality_check: 'ocr_review',
    },
  ];
}

function sanitizeScheduleId(value) {
  const cleaned = String(value || '').trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return cleaned || 'studytrace_survey';
}

function normalizeDateString(value) {
  const text = String(value || '').trim();
  if (/^\d{2}-\d{2}-\d{4}$/.test(text)) return text;
  return '';
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function handleBatteryScreenshotUpload(req, res, studyId) {
  return handleUsageScreenshotUpload(req, res, studyId, 'battery');
}

const SCREENSHOT_KINDS = {
  battery: {
    trigger: BATTERY_PROMPT,
    esmJson: {
      esm_type: 14,
      esm_title: 'Battery usage screenshot',
      esm_instructions: 'Open Settings > Battery > View All Battery Usage, then upload the screenshot.',
      esm_trigger: BATTERY_PROMPT,
      esm_submit: 'Submit',
      esm_na: true,
    },
  },
  screen_time_activity: {
    trigger: ACTIVITY_PROMPT,
    esmJson: {
      esm_type: 14,
      esm_title: 'Screen Time activity screenshot',
      esm_instructions: 'Open Settings > Screen Time > See All App & Website Activity, choose one day, then upload the screenshot.',
      esm_trigger: ACTIVITY_PROMPT,
      esm_submit: 'Submit',
      esm_na: true,
    },
  },
};

async function handleUsageScreenshotUpload(req, res, studyId, forcedKind) {
  const payload = req.body || {};
  const deviceId = String(payload.device_id || '').trim();
  const screenshotBase64 = normalizeBase64Image(payload.screenshot_base64 || payload.esm_user_answer);
  if (!deviceId) {
    return res.status(400).json({ error: 'device_id is required' });
  }
  if (!screenshotBase64) {
    return res.status(400).json({ error: 'screenshot_base64 is required' });
  }
  const kindName = forcedKind || (payload.screenshot_kind === 'screen_time_activity' ? 'screen_time_activity' : 'battery');
  const kind = SCREENSHOT_KINDS[kindName];

  const timestamp = Number(payload.timestamp) || Date.now();
  const row = {
    timestamp,
    device_id: deviceId,
    screenshot_kind: kindName,
    esm_trigger: kind.trigger,
    esm_json: JSON.stringify(kind.esmJson),
    esm_user_answer: screenshotBase64,
    double_esm_user_answer_timestamp: timestamp,
    esm_status: 2,
  };
  if (payload.battery_usage_ocr_text || payload.ocr_text) {
    row.battery_usage_ocr_text = String(payload.battery_usage_ocr_text || payload.ocr_text);
  }
  // The app's upload queue retries with the same upload_id (a hash of the
  // image), so a retry after a lost response does not store a second copy.
  const uploadId = typeof payload.upload_id === 'string' ? payload.upload_id.trim().slice(0, 128) : '';
  if (uploadId) row.upload_id = uploadId;
  if (isValidTimeZone(payload.timezone)) row.timezone = payload.timezone;
  Object.assign(row, confirmedScreenshotFields(payload, kindName));

  const table = safeTableName('plugin_ios_esm');
  await createSensorTable(table);
  const inserted = await insertRows(table, studyId, deviceId, [row]);
  const source = await findLatestBatteryScreenshotSource(table, { studyId, deviceId, timestamp });
  let processed;
  let feedback;
  if (kindName === 'screen_time_activity') {
    processed = await processScreenTimeActivityUploads({ studyId, limit: 25 });
    feedback = source ? await screenTimeActivityUploadFeedback(source) : null;
  } else {
    processed = await processBatteryScreenshotUploads({ studyId, limit: 25 });
    feedback = source ? await batteryScreenshotUploadFeedback(source) : null;
  }
  feedback = feedback || {
    app_rows_detected: 0,
    needs_review: true,
    qa_reason: 'uploaded screenshot could not be located for OCR feedback',
    message: 'Screenshot uploaded, but StudyTrace could not confirm OCR quality yet.',
  };
  return res.status(inserted ? 201 : 200).json({ ok: true, inserted, duplicate: inserted === 0, processed, feedback });
}

// Values the participant reviewed on the phone (on-device OCR, then edited
// or accepted). Sanitized here because they come straight from the client.
function confirmedScreenshotFields(payload, kindName) {
  const fields = {};
  const window = String(payload.usage_window || '');
  if (['last_24_hours', 'last_10_days'].includes(window)) fields.usage_window = window;
  const capturedAt = Number(payload.captured_at);
  if (Number.isFinite(capturedAt) && capturedAt > 0) fields.captured_at = new Date(capturedAt).toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(payload.activity_date || ''))) fields.activity_date = String(payload.activity_date);
  if (typeof payload.device_ocr_text === 'string') fields.device_ocr_text = payload.device_ocr_text.slice(0, 20000);
  if (!Array.isArray(payload.confirmed_rows)) return fields;

  const maxSeconds = kindName === 'battery' && fields.usage_window === 'last_10_days' ? 10 * 86400 : 86400;
  fields.participant_confirmed = true;
  fields.participant_edited = payload.participant_edited === true;
  fields.confirmed_rows = payload.confirmed_rows.slice(0, 100)
    .map((item) => ({
      app_name: String(item?.app_name || '').trim().slice(0, 80),
      screen_time_seconds: boundedNumber(item?.screen_time_seconds, 0, maxSeconds),
      battery_percent: kindName === 'battery' ? boundedNumber(item?.battery_percent, 0, 100) : null,
    }))
    .filter((item) => item.app_name);
  if (kindName === 'screen_time_activity') {
    const summary = payload.summary || {};
    fields.confirmed_summary = {
      total_screen_time_seconds: boundedNumber(summary.total_screen_time_seconds, 0, 86400),
      pickups: boundedNumber(summary.pickups, 0, 5000),
      notifications: boundedNumber(summary.notifications, 0, 20000),
    };
  }
  return fields;
}

function boundedNumber(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  const number = Math.round(Number(value));
  if (!Number.isFinite(number) || number < min || number > max) return null;
  return number;
}

async function findLatestBatteryScreenshotSource(table, { studyId, deviceId, timestamp }) {
  const { rows } = await getPool().query(
    `SELECT id, study_id, device_id, timestamp, data, created_at
     FROM ${table}
     WHERE study_id = $1
       AND device_id = $2
       AND timestamp = $3
     ORDER BY id DESC
     LIMIT 1`,
    [studyId, deviceId, timestamp]
  );
  if (rows.length) return { ...rows[0], sensor: 'plugin_ios_esm' };
  return null;
}

async function batteryScreenshotUploadFeedback(source) {
  const table = safeTableName(BATTERY_USAGE_EXPORT_SENSOR);
  if (!table || !(await tableExists(table))) {
    return {
      app_rows_detected: 0,
      needs_review: true,
      qa_reason: 'OCR output table unavailable',
      message: 'Screenshot uploaded, but OCR feedback is not available yet.',
    };
  }
  const { rows } = await getPool().query(
    `SELECT data
     FROM ${table}
     WHERE study_id = $1
       AND data->>'source_sensor' = $2
       AND data->>'source_row_id' = $3
     ORDER BY id ASC`,
    [source.study_id, source.sensor, String(source.id)]
  );
  const parsedRows = rows
    .map((row) => row.data || {})
    .filter((row) => ['parsed', 'confirmed'].includes(row.extraction_status) && row.app_name);
  const needsReview = rows.some((row) => row.data?.needs_review === true || row.data?.needs_review === 'true') ||
    parsedRows.length === 0;
  const qaReason = [...new Set(rows.map((row) => row.data?.qa_reason).filter(Boolean))].join('; ');
  return {
    app_rows_detected: parsedRows.length,
    needs_review: needsReview,
    qa_reason: qaReason,
    message: needsReview
      ? 'Screenshot uploaded, but StudyTrace could not confidently read app usage. Please retake it if possible.'
      : `Screenshot uploaded. StudyTrace detected ${parsedRows.length} app usage row${parsedRows.length === 1 ? '' : 's'}.`,
  };
}

async function findEsmResponseRows(studyId, rawLimit) {
  const limit = Math.min(Math.max(Number(rawLimit) || 50, 1), BATTERY_USAGE_EXPORT_LIMIT);
  const sensors = await listStudySensorTables(studyId);
  const esmSensors = [];

  for (const sensor of sensors) {
    if (isKnownEsmSensor(sensor.sensor)) {
      esmSensors.push(sensor.sensor);
      continue;
    }

    const sample = await exportRows(sensor.table, { studyId, limit: 5, order: 'desc' });
    if (sample.some((row) => isEsmDataRow(row.data))) {
      esmSensors.push(sensor.sensor);
    }
  }

  const rows = [];
  for (const sensor of [...new Set(esmSensors)]) {
    const table = safeTableName(sensor);
    if (!table) continue;
    const sensorRows = await exportRows(table, { studyId, limit, order: 'desc' });
    for (const row of sensorRows) {
      if (isEsmDataRow(row.data)) rows.push({ ...row, sensor });
    }
  }

  return rows
    .sort((a, b) => Number(b.timestamp || b.id || 0) - Number(a.timestamp || a.id || 0))
    .slice(0, limit);
}

function isKnownEsmSensor(sensor) {
  return ['esms', 'plugin_ios_esm', 'ios_esm'].includes(String(sensor || '').toLowerCase());
}

function isEsmDataRow(data) {
  return Boolean(data && typeof data === 'object' && (
    'esm_user_answer' in data ||
    'esm_json' in data ||
    'esm_trigger' in data ||
    'double_esm_user_answer_timestamp' in data
  ));
}

async function findBatteryUsageDiagnostics({ studyId, limit: rawLimit } = {}) {
  const limit = Math.min(Math.max(Number(rawLimit) || 100, 1), BATTERY_USAGE_EXPORT_LIMIT);
  const processing = await processBatteryScreenshotUploads({ studyId, limit });
  const screenshotRows = await findBatteryScreenshotRows({ studyId, limit });
  const table = safeTableName(BATTERY_USAGE_EXPORT_SENSOR);
  const appRows = table && await tableExists(table)
    ? (await exportRows(table, { studyId, limit, order: 'desc' })).map(batteryUsageAppRowFromExport)
    : [];
  return {
    screenshotRows,
    appRows,
    processed: processing,
  };
}

async function processBatteryScreenshotUploads({ studyId, limit: rawLimit } = {}) {
  const limit = Math.min(Math.max(Number(rawLimit) || 100, 1), BATTERY_USAGE_EXPORT_LIMIT);
  const screenshotRows = await findBatteryScreenshotRows({ studyId, limit });
  const table = safeTableName(BATTERY_USAGE_EXPORT_SENSOR);
  if (!table) return { screenshots: screenshotRows.length, inserted: 0, skipped: 0 };
  await createSensorTable(table);

  let inserted = 0;
  let skipped = 0;
  for (const source of screenshotRows) {
    if (await batteryUsageSourceAlreadyProcessed(table, source)) {
      skipped += 1;
      continue;
    }

    const sourceImageUrl = `/api/v1/studies/${encodeURIComponent(source.study_id)}/media/${encodeURIComponent(source.sensor)}/${encodeURIComponent(source.id)}/image`;
    if (Array.isArray(source.data?.confirmed_rows)) {
      // Participant reviewed the on-device OCR result; store what they
      // confirmed instead of re-running server OCR.
      inserted += await insertRows(table, source.study_id, source.device_id,
        confirmedBatteryRows(source, sourceImageUrl).map((row, index) => ({
          timestamp: source.timestamp,
          dedupe_key: `battery:${source.sensor}:${source.id}:${index}`,
          ...row,
        })));
      continue;
    }

    const image = decodeImageAnswer(source.data?.esm_user_answer);
    const ocr = image
      ? await extractBatteryUsageOcrText(source.data, image.buffer)
      : { text: '', confidence: null, method: 'none', status: 'no_image' };
    const parsedRows = parseBatteryUsageOcrText(ocr.text);
    const qa = batteryOcrQa({ ocr, parsedRows });
    const base = {
      source_sensor: source.sensor,
      source_row_id: String(source.id),
      source_image_url: sourceImageUrl,
      // Context the phone sends even when nobody reviews the values.
      usage_window: source.data?.usage_window || '',
      captured_at: source.data?.captured_at || '',
      participant_edited: false,
      extraction_method: ocr.method,
      ocr_confidence: ocr.confidence,
      needs_review: qa.needsReview,
      qa_reason: qa.reason,
      ocr_text: ocr.text,
    };

    const rowsToInsert = parsedRows.length
      ? parsedRows.map((row, index) => ({
          ...base,
          app_name: row.app_name,
          screen_time_seconds: row.screen_time_seconds,
          screen_time_text: row.screen_time_text,
          battery_percent: row.battery_percent,
          battery_percent_text: row.battery_percent_text,
          extraction_status: 'parsed',
          parse_notes: row.parse_notes || `parsed row ${index + 1}`,
        }))
      : [{
          ...base,
          app_name: '',
          screen_time_seconds: null,
          screen_time_text: '',
          battery_percent: null,
          battery_percent_text: '',
          extraction_status: ocr.status || (ocr.text ? 'no_app_rows' : 'ocr_unavailable'),
          parse_notes: ocr.text
            ? 'OCR text was captured, but no app/time rows matched the parser.'
            : 'No OCR text was available for this screenshot.',
        }];

    inserted += await insertRows(table, source.study_id, source.device_id, rowsToInsert.map((row, index) => ({
      timestamp: source.timestamp,
      dedupe_key: `battery:${source.sensor}:${source.id}:${index}`,
      ...row,
    })));
  }

  return { screenshots: screenshotRows.length, inserted, skipped };
}

function confirmedBatteryRows(source, sourceImageUrl) {
  const data = source.data || {};
  const base = {
    source_sensor: source.sensor,
    source_row_id: String(source.id),
    source_image_url: sourceImageUrl,
    usage_window: data.usage_window || '',
    captured_at: data.captured_at || '',
    participant_edited: data.participant_edited === true,
    extraction_method: 'participant_confirmed',
    ocr_confidence: null,
    ocr_text: data.device_ocr_text || '',
  };
  if (!data.confirmed_rows.length) {
    return [{
      ...base,
      app_name: '',
      screen_time_seconds: null,
      screen_time_text: '',
      battery_percent: null,
      battery_percent_text: '',
      extraction_status: 'confirmed_empty',
      needs_review: true,
      qa_reason: 'participant confirmed no app rows',
      parse_notes: 'participant confirmed an empty table',
    }];
  }
  return data.confirmed_rows.map((item) => ({
    ...base,
    app_name: item.app_name,
    screen_time_seconds: item.screen_time_seconds,
    screen_time_text: item.screen_time_seconds === null ? '' : formatSecondsText(item.screen_time_seconds),
    battery_percent: item.battery_percent,
    battery_percent_text: item.battery_percent === null ? '' : `${item.battery_percent}%`,
    extraction_status: 'confirmed',
    needs_review: false,
    qa_reason: '',
    parse_notes: data.participant_edited ? 'edited by participant' : 'confirmed by participant',
  }));
}

function formatSecondsText(seconds) {
  const minutes = Math.round(Number(seconds) / 60);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

// ---- Screen Time "See All Activity" screenshots ---------------------------

function isScreenTimeActivityEsmRow(row) {
  const data = row?.data || {};
  if (data.screenshot_kind === 'screen_time_activity' || data.esm_trigger === ACTIVITY_PROMPT) return true;
  return parseEsmJson(data.esm_json).esm_trigger === ACTIVITY_PROMPT;
}

async function findScreenTimeActivityRows({ studyId, limit: rawLimit } = {}) {
  const limit = Math.min(Math.max(Number(rawLimit) || 100, 1), BATTERY_USAGE_EXPORT_LIMIT);
  const rows = [];
  const sensors = studyId ? await listStudySensorTables(studyId) : await listSensorTables();
  for (const sensor of sensors.filter((item) => isKnownEsmSensor(item.sensor))) {
    const sensorRows = await exportRows(sensor.table, { studyId, limit, order: 'desc' });
    for (const row of sensorRows) {
      const candidate = { ...row, sensor: sensor.sensor };
      if (decodeImageAnswer(candidate.data?.esm_user_answer) && isScreenTimeActivityEsmRow(candidate)) rows.push(candidate);
    }
  }
  return rows.slice(0, limit);
}

async function countDerivedActivityRows({ studyId } = {}) {
  const table = safeTableName(SCREEN_TIME_ACTIVITY_SENSOR);
  if (!(await tableExists(table))) return 0;
  await processScreenTimeActivityUploads({ studyId, limit: BATTERY_USAGE_EXPORT_LIMIT });
  const { rows } = await getPool().query(
    `SELECT count(*)::int AS n FROM ${table}${studyId ? ' WHERE study_id = $1' : ''}`,
    studyId ? [studyId] : []
  );
  return rows[0].n;
}

async function processScreenTimeActivityUploads({ studyId, limit } = {}) {
  const sources = await findScreenTimeActivityRows({ studyId, limit });
  const table = safeTableName(SCREEN_TIME_ACTIVITY_SENSOR);
  await createSensorTable(table);
  let inserted = 0;
  for (const source of sources) {
    if (await batteryUsageSourceAlreadyProcessed(table, source)) continue;
    const data = source.data || {};
    const sourceImageUrl = `/api/v1/studies/${encodeURIComponent(source.study_id)}/media/${encodeURIComponent(source.sensor)}/${encodeURIComponent(source.id)}/image`;
    let parsed;
    let method;
    if (Array.isArray(data.confirmed_rows)) {
      parsed = { summary: data.confirmed_summary || {}, apps: data.confirmed_rows };
      method = 'participant_confirmed';
    } else {
      const image = decodeImageAnswer(data.esm_user_answer);
      const ocr = image
        ? await extractBatteryUsageOcrText(data, image.buffer)
        : { text: '', method: 'none' };
      parsed = parseScreenTimeActivityOcrText(ocr.text);
      parsed.ocrText = ocr.text;
      method = ocr.method;
    }
    const summary = parsed.summary || {};
    const needsReview = method !== 'participant_confirmed' &&
      (summary.total_screen_time_seconds == null || !parsed.apps?.length);
    const base = {
      source_sensor: source.sensor,
      source_row_id: String(source.id),
      source_image_url: sourceImageUrl,
      activity_date: data.activity_date || '',
      captured_at: data.captured_at || '',
      participant_edited: data.participant_edited === true,
      extraction_method: method,
      extraction_status: method === 'participant_confirmed' ? 'confirmed' : (needsReview ? 'needs_review' : 'parsed'),
      needs_review: needsReview,
      qa_reason: needsReview ? 'total screen time or app rows not found' : '',
      ocr_text: data.device_ocr_text || parsed.ocrText || '',
    };
    const rows = [{
      ...base,
      row_type: 'summary',
      app_name: '',
      screen_time_seconds: null,
      total_screen_time_seconds: summary.total_screen_time_seconds ?? null,
      pickups: summary.pickups ?? null,
      notifications: summary.notifications ?? null,
      dedupe_key: `activity:${source.sensor}:${source.id}:summary`,
    }, ...(parsed.apps || []).map((app, index) => ({
      ...base,
      row_type: 'app',
      app_name: app.app_name,
      screen_time_seconds: app.screen_time_seconds ?? null,
      total_screen_time_seconds: null,
      pickups: null,
      notifications: null,
      dedupe_key: `activity:${source.sensor}:${source.id}:app:${index}`,
    }))];
    inserted += await insertRows(table, source.study_id, source.device_id,
      rows.map((row) => ({ timestamp: source.timestamp, ...row })));
  }
  return { screenshots: sources.length, inserted };
}

async function screenTimeActivityUploadFeedback(source) {
  const table = safeTableName(SCREEN_TIME_ACTIVITY_SENSOR);
  const { rows } = await getPool().query(
    `SELECT data FROM ${table}
     WHERE study_id = $1 AND data->>'source_sensor' = $2 AND data->>'source_row_id' = $3`,
    [source.study_id, source.sensor, String(source.id)]
  );
  const apps = rows.filter((row) => row.data?.row_type === 'app').length;
  const summary = rows.find((row) => row.data?.row_type === 'summary')?.data || {};
  const needsReview = rows.some((row) => row.data?.needs_review === true);
  return {
    app_rows_detected: apps,
    needs_review: needsReview,
    qa_reason: summary.qa_reason || '',
    message: needsReview
      ? 'Screenshot uploaded, but StudyTrace could not read the screen time totals. Please retake it if possible.'
      : `Screenshot uploaded with ${apps} app${apps === 1 ? '' : 's'}.`,
  };
}

// Parses Settings > Screen Time > See All Activity (one day, English or
// Japanese): total screen time, total pickups/notifications, and the
// "Most Used" app list.
function parseScreenTimeActivityOcrText(text) {
  const lines = String(text || '').split(/\r?\n/).map(cleanOcrLine).filter(Boolean);
  const lower = lines.map((line) => line.toLowerCase());
  const indexOf = (pattern, from = 0) => {
    for (let i = from; i < lower.length; i += 1) if (pattern.test(lower[i])) return i;
    return -1;
  };
  const countNear = (pattern) => {
    const at = indexOf(pattern);
    if (at < 0) return null;
    for (let i = at; i < Math.min(lines.length, at + 4); i += 1) {
      const match = lines[i].replace(/,/g, '').match(/(?:^|\s)(\d{1,5})(?:\s*(?:回|件))?$/);
      if (match && !parseBatteryDuration(lines[i])) return Number(match[1]);
    }
    return null;
  };

  const mostUsed = indexOf(/most used|よく使われた/);
  const pickupsAt = indexOf(/pickup|持ち上げ/);
  const notificationsAt = indexOf(/notification|通知/);
  let total = null;
  for (let i = 0; i < (mostUsed > 0 ? mostUsed : lines.length); i += 1) {
    const duration = parseBatteryDuration(lines[i]);
    if (duration && !/^\d{1,2}:\d{2}$/.test(lines[i])) {
      total = duration.seconds;
      break;
    }
  }

  const apps = [];
  if (mostUsed >= 0) {
    const stop = [pickupsAt, notificationsAt].filter((i) => i > mostUsed).sort((a, b) => a - b)[0] ?? lines.length;
    for (let i = mostUsed + 1; i < stop; i += 1) {
      if (!looksLikeBatteryAppNameLine(lines[i])) continue;
      const next = [lines[i + 1], lines[i + 2]].map((line) => parseBatteryDuration(line)).find(Boolean);
      if (next) apps.push({ app_name: cleanAppName(lines[i]), screen_time_seconds: next.seconds });
    }
  }
  return {
    summary: {
      total_screen_time_seconds: total,
      pickups: countNear(/total pickups|pickups|持ち上げ/),
      notifications: countNear(/notifications|通知/),
    },
    apps,
  };
}

async function batteryUsageSourceAlreadyProcessed(table, source) {
  const { rows } = await getPool().query(
    `SELECT 1
     FROM ${table}
     WHERE study_id = $1
       AND data->>'source_sensor' = $2
       AND data->>'source_row_id' = $3
     LIMIT 1`,
    [source.study_id, source.sensor, String(source.id)]
  );
  return rows.length > 0;
}

async function findBatteryScreenshotRows({ studyId, limit: rawLimit } = {}) {
  const limit = Math.min(Math.max(Number(rawLimit) || 100, 1), BATTERY_USAGE_EXPORT_LIMIT);
  const rows = [];
  if (studyId) {
    const esmRows = await findEsmResponseRows(studyId, Math.min(limit * 3, BATTERY_USAGE_EXPORT_LIMIT));
    for (const row of esmRows) {
      if (isBatteryScreenshotEsmRow(row)) rows.push(row);
    }
  } else {
    const sensors = await listSensorTables();
    const esmSensors = sensors.filter((sensor) => isKnownEsmSensor(sensor.sensor));
    for (const sensor of esmSensors) {
      const sensorRows = await exportRows(sensor.table, { limit, order: 'desc' });
      for (const row of sensorRows) {
        const candidate = { ...row, sensor: sensor.sensor };
        if (isBatteryScreenshotEsmRow(candidate)) rows.push(candidate);
      }
    }
  }
  return rows
    .sort((a, b) => Number(b.timestamp || b.id || 0) - Number(a.timestamp || a.id || 0))
    .slice(0, limit);
}

function isBatteryScreenshotEsmRow(row) {
  if (!row?.data || !decodeImageAnswer(row.data.esm_user_answer)) return false;
  if (isScreenTimeActivityEsmRow(row)) return false;
  const esmJson = parseEsmJson(row.data.esm_json);
  const text = [
    row.data.esm_trigger,
    esmJson.esm_trigger,
    esmJson.esm_title,
    esmJson.esm_instructions,
  ].filter(Boolean).join(' ').toLowerCase();
  return text.includes('battery') ||
    text.includes('screen time screenshot') ||
    text.includes('screentime screenshot') ||
    text.includes('app usage screenshot');
}

function parseEsmJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
}

async function extractBatteryUsageOcrText(data, imageBuffer) {
  const override = data?.battery_usage_ocr_text || data?.batteryUsageOcrText || data?.ocr_text;
  if (typeof override === 'string' && override.trim()) {
    return {
      text: override,
      confidence: 100,
      method: 'provided_text',
      status: 'parsed',
    };
  }

  if (process.env.BATTERY_USAGE_OCR_DISABLED === 'true') {
    return { text: '', confidence: null, method: 'disabled', status: 'ocr_disabled' };
  }

  try {
    const tesseract = await import('tesseract.js');
    // e.g. OCR_LANGUAGES=eng+jpn for Japanese studies (downloads traineddata once).
    const worker = await tesseract.createWorker((process.env.OCR_LANGUAGES || 'eng').split('+'));
    const result = await worker.recognize(imageBuffer);
    await worker.terminate();
    return {
      text: result?.data?.text || '',
      confidence: result?.data?.confidence ?? null,
      method: 'tesseract.js',
      status: result?.data?.text ? 'parsed' : 'ocr_empty',
    };
  } catch (err) {
    return {
      text: '',
      confidence: null,
      method: 'ocr_unavailable',
      status: 'ocr_unavailable',
      error: err?.message || String(err),
    };
  }
}

function batteryOcrQa({ ocr, parsedRows }) {
  const reasons = [];
  if (!ocr?.text) reasons.push('no OCR text');
  if (!parsedRows.length) reasons.push('no parsed app rows');
  if (Number.isFinite(Number(ocr?.confidence)) && Number(ocr.confidence) < 60) reasons.push('low OCR confidence');
  if (ocr?.status && !['parsed'].includes(ocr.status)) reasons.push(ocr.status);
  return {
    needsReview: reasons.length > 0,
    reason: reasons.join('; '),
  };
}

function parseBatteryUsageOcrText(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(cleanOcrLine)
    .filter(Boolean);
  const rows = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i += 1) {
    const inline = parseBatteryUsageLine(lines[i]);
    if (inline && !seen.has(inline.app_name.toLowerCase())) {
      rows.push(inline);
      seen.add(inline.app_name.toLowerCase());
      continue;
    }

    if (!looksLikeBatteryAppNameLine(lines[i])) continue;
    const block = lines.slice(i, i + 5);
    const parsed = parseBatteryUsageBlock(block);
    if (parsed && !seen.has(parsed.app_name.toLowerCase())) {
      rows.push(parsed);
      seen.add(parsed.app_name.toLowerCase());
    }
  }

  return rows;
}

function parseBatteryUsageLine(line) {
  const duration = parseBatteryDuration(line);
  const percent = parseBatteryPercent(line);
  if (!duration && percent === null) return null;
  let appName = line;
  if (duration) appName = appName.replace(duration.matchText, ' ');
  appName = appName
    .replace(/\b(on\s+screen|screen\s+on|background|activity|battery|usage)\b/gi, ' ')
    .replace(/\d{1,3}\s*%/g, ' ');
  appName = cleanAppName(appName);
  if (!isUsableAppName(appName)) return null;
  return {
    app_name: appName,
    screen_time_seconds: duration?.seconds ?? null,
    screen_time_text: duration?.text ?? '',
    battery_percent: percent,
    battery_percent_text: percent === null ? '' : `${percent}%`,
    parse_notes: 'single-line OCR parse',
  };
}

function parseBatteryUsageBlock(lines) {
  const appName = cleanAppName(lines[0]);
  if (!isUsableAppName(appName)) return null;
  const details = lines.slice(1).join(' ');
  const durationCandidates = lines.slice(1)
    .map((line) => ({ line, duration: parseBatteryDuration(line) }))
    .filter((item) => item.duration)
    .sort((a, b) => batteryDurationLinePriority(a.line) - batteryDurationLinePriority(b.line));
  const duration = durationCandidates[0]?.duration || null;
  const percent = parseBatteryPercent(details);
  if (!duration && percent === null) return null;
  return {
    app_name: appName,
    screen_time_seconds: duration?.seconds ?? null,
    screen_time_text: duration?.text ?? '',
    battery_percent: percent,
    battery_percent_text: percent === null ? '' : `${percent}%`,
    parse_notes: 'multi-line OCR parse',
  };
}

function batteryDurationLinePriority(line) {
  const text = String(line || '').toLowerCase();
  if (text.includes('background')) return 3;
  if (text.includes('screen')) return 0;
  return 1;
}

function parseBatteryDuration(value) {
  const text = String(value || '').replace(/[·•]/g, ' ');
  const patterns = [
    // Longest unit first: with `h` first, "1 hour 5 min" stopped at "1 h".
    /(\d{1,2})\s*(?:hours|hour|hrs|hr|h|時間)(?![a-z])\s*(?:(\d{1,2})\s*(?:minutes|minute|mins|min|m|分)(?![a-z]))?/i,
    /(\d{1,3})\s*(?:minutes|minute|mins|min|m|分)(?![a-z])/i,
    /\b(\d{1,2}):(\d{2})\b/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    let seconds = 0;
    if (pattern === patterns[0]) {
      seconds = Number(match[1]) * 3600 + Number(match[2] || 0) * 60;
    } else if (pattern === patterns[1]) {
      seconds = Number(match[1]) * 60;
    } else {
      seconds = Number(match[1]) * 3600 + Number(match[2]) * 60;
    }
    return {
      seconds,
      text: match[0].replace(/\s+/g, ' ').trim(),
      matchText: match[0],
    };
  }
  return null;
}

function parseBatteryPercent(value) {
  const match = String(value || '').match(/(\d{1,3})\s*[%％]/);
  if (!match) return null;
  const valueNumber = Number(match[1]);
  if (!Number.isInteger(valueNumber) || valueNumber < 0 || valueNumber > 100) return null;
  return valueNumber;
}

function cleanOcrLine(value) {
  return String(value || '')
    .replace(/[|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanAppName(value) {
  // Unicode-aware so Japanese app names (e.g. 写真, メッセージ) survive.
  return String(value || '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}).]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeBatteryAppNameLine(line) {
  if (!isUsableAppName(line)) return false;
  if (parseBatteryDuration(line) || parseBatteryPercent(line) !== null) return false;
  return true;
}

function isUsableAppName(value) {
  const text = cleanAppName(value);
  if (text.length < 2 || text.length > 60) return false;
  if (!/\p{L}/u.test(text)) return false;
  const lower = text.toLowerCase();
  return ![
    'settings',
    'battery',
    'battery usage',
    'view all battery usage',
    'last 24 hours',
    'last 10 days',
    'screen on',
    'screen off',
    'activity',
    'usage by app',
    // iOS section headings; without these the heading was parsed as an app
    // and credited with the next app's time and percentage.
    'battery usage by app',
    'activity by app',
    'battery level',
    'insights and suggestions',
    'バッテリー',
    'バッテリーの使用状況',
    'アプリごとのバッテリー使用状況',
    'アプリごとのアクティビティ',
    '過去24時間',
    '過去10日間',
    'アクティビティを表示',
    'バッテリー使用状況を表示',
    '画面オン',
    '画面オフ',
    'バッテリー残量',
    'show activity',
    'show battery usage',
  ].includes(lower);
}

function batteryUsageAppRowFromExport(row) {
  return {
    id: row.id,
    study_id: row.study_id,
    device_id: row.device_id,
    timestamp: row.timestamp,
    created_at: row.created_at,
    ...(row.data || {}),
  };
}

async function imageFromEsmRow(studyId, sensor, rowId) {
  const id = Number(rowId);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const table = safeTableName(sensor);
  if (!table || !(await tableExists(table))) return null;

  const { rows } = await getPool().query(
    `SELECT data
     FROM ${table}
     WHERE study_id = $1 AND id = $2
     LIMIT 1`,
    [studyId, id]
  );
  if (!rows.length) return null;

  const data = rows[0].data || {};
  if (!isPictureEsmRow(data) && !decodeImageAnswer(data.esm_user_answer)) return null;
  return decodeImageAnswer(data.esm_user_answer);
}

function isPictureEsmRow(data) {
  const esmJson = data?.esm_json;
  if (!esmJson) return false;
  try {
    const parsed = typeof esmJson === 'string' ? JSON.parse(esmJson) : esmJson;
    return Number(parsed?.esm_type) === 14;
  } catch {
    return false;
  }
}

function decodeImageAnswer(answer) {
  if (typeof answer !== 'string' || !answer.trim()) return null;
  const trimmed = answer.trim();
  const match = trimmed.match(/^data:(image\/(?:png|jpeg));base64,(.+)$/i);
  const contentType = match?.[1]?.toLowerCase() || 'image/png';
  const base64 = match?.[2] || trimmed;
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(base64)) return null;
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) return null;

  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { buffer, contentType: 'image/png', extension: 'png' };
  }
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return { buffer, contentType: 'image/jpeg', extension: 'jpg' };
  }
  return { buffer, contentType, extension: contentType === 'image/jpeg' ? 'jpg' : 'png' };
}

function normalizeBase64Image(answer) {
  if (typeof answer !== 'string' || !answer.trim()) return '';
  const trimmed = answer.trim();
  const match = trimmed.match(/^data:image\/(?:png|jpeg);base64,(.+)$/i);
  const base64 = (match?.[1] || trimmed).replace(/\s/g, '');
  return decodeImageAnswer(base64) ? base64 : '';
}
