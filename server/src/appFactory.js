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
} from './db.js';
import { createAwareRouter } from './awareApi.js';
import { createGenericApiRouter } from './genericApi.js';

const BATTERY_USAGE_EXPORT_SENSOR = 'battery_usage_apps';
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
  'extraction_status',
  'extraction_method',
  'ocr_confidence',
  'parse_notes',
  'ocr_text',
];
const BATTERY_USAGE_EXPORT_LIMIT = 10000;

export function createApp() {
  const app = express();
  app.set('trust proxy', true);
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

  // AWARE posts application/x-www-form-urlencoded ("device_id=..&data=<json>");
  // the generic API uses JSON. Accept both. Payloads can be large.
  app.use(express.urlencoded({ extended: false, limit: '25mb' }));
  app.use(express.json({ limit: '25mb' }));
  app.use(express.text({ type: '*/*', limit: '25mb' }));
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
      res.json(scheduleResponse(study));
    } catch (err) {
      console.error(`[admin get esm schedule ${req.params.studyId}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.put('/admin/studies/:studyId/esm-schedule', requireAdmin, async (req, res) => {
    try {
      const study = await getStudy(req.params.studyId);
      if (!study) return res.status(404).json({ error: 'study not found' });

      const esmSchedule = buildEsmScheduleFromRequest(req.body || {});
      const updated = await updateStudyConfig(req.params.studyId, { esm_schedule: esmSchedule });
      res.json(scheduleResponse(updated));
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
  app.get('/api/v1/studies/:studyId/dashboard/summary', requireStudyPassword, async (req, res) => {
    try {
      const overview = await getStudyOverview(req.params.studyId);
      if (!overview) return res.status(404).json({ error: 'study not found' });
      await attachStudyDerivedSensors(overview, req.params.studyId);
      res.json({ ok: true, ...overview });
    } catch (err) {
      console.error(`[dashboard summary ${req.params.studyId}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.get('/api/v1/studies/:studyId/export/:sensor', requireStudyPassword, async (req, res) => {
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

  app.get('/api/v1/studies/:studyId/esm-schedule', requireStudyPassword, async (req, res) => {
    try {
      res.json(scheduleResponse(req.study));
    } catch (err) {
      console.error(`[researcher get esm schedule ${req.params.studyId}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.put('/api/v1/studies/:studyId/esm-schedule', requireStudyPassword, async (req, res) => {
    try {
      const esmSchedule = buildEsmScheduleFromRequest(req.body || {});
      const updated = await updateStudyConfig(req.params.studyId, { esm_schedule: esmSchedule });
      res.json(scheduleResponse(updated));
    } catch (err) {
      if (err.statusCode) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      console.error(`[researcher save esm schedule ${req.params.studyId}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.get('/api/v1/studies/:studyId/dashboard/esm-responses', requireStudyPassword, async (req, res) => {
    try {
      const rows = await findEsmResponseRows(req.params.studyId, req.query.limit);
      return res.json({ ok: true, count: rows.length, rows });
    } catch (err) {
      console.error(`[dashboard esm responses ${req.params.studyId}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.get('/api/v1/studies/:studyId/dashboard/battery-usage', requireStudyPassword, async (req, res) => {
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

  app.get('/api/v1/studies/:studyId/media/:sensor/:rowId/image', requireStudyPassword, async (req, res) => {
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

  app.get('/api/v1/studies/:studyId/media/esms/:rowId/image', requireStudyPassword, async (req, res) => {
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

  // ---- Ingestion front-ends (shared storage) --------------------------------
  app.use('/', createAwareRouter(getPublicBaseUrl));
  app.use('/api/v1', createGenericApiRouter());

  return app;
}

async function listAdminSensorsForDashboard() {
  const sensors = filterLegacyScreenTimeSensors(await listSensorTables());
  const batteryDiagnostics = await findBatteryUsageDiagnostics({ limit: BATTERY_USAGE_EXPORT_LIMIT });
  upsertVirtualSensor(sensors, BATTERY_USAGE_EXPORT_SENSOR, batteryDiagnostics.appRows.length, 'derived_from_battery_screenshot_esm');
  return sensors.sort((a, b) => String(a.sensor).localeCompare(String(b.sensor)));
}

async function attachStudyDerivedSensors(overview, studyId) {
  const batteryDiagnostics = await findBatteryUsageDiagnostics({ studyId, limit: BATTERY_USAGE_EXPORT_LIMIT });

  overview.sensors = filterLegacyScreenTimeSensors(overview.sensors || []);
  upsertVirtualSensor(overview.sensors, BATTERY_USAGE_EXPORT_SENSOR, batteryDiagnostics.appRows.length, 'derived_from_battery_screenshot_esm');
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

  const table = safeTableName(sensor);
  if (!table) throw httpError(400, 'invalid sensor name');
  return exportRows(table, { studyId, deviceId, limit, offset });
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

function scheduleResponse(study) {
  const schedule = Array.isArray(study?.config?.esm_schedule) ? study.config.esm_schedule : [];
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

function buildEsmScheduleFromRequest(body) {
  const mode = body.mode === 'random' ? 'random' : 'fixed';
  const promptTimes = parsePromptTimes(body.times || body.hours);
  const randomMinutes = mode === 'random'
    ? clampInteger(body.randomize_minutes, 1, 180, 30)
    : 0;
  const scheduleId = sanitizeScheduleId(body.schedule_id || `studytrace_${mode}_battery_screenshot`);
  const esms = parseEsmQuestions(body);

  return [
    {
      schedule_id: scheduleId,
      hours: promptTimes.hours,
      times: promptTimes.times,
      studytrace_prompt_type: 'battery_usage_screenshot',
      studytrace_delivery_mode: mode,
      randomize: randomMinutes,
      expiration: clampInteger(body.expiration_minutes, 0, 1440, mode === 'random' ? randomMinutes * 2 : 120),
      start_date: normalizeDateString(body.start_date),
      end_date: normalizeDateString(body.end_date),
      notification_title: String(body.notification_title || 'StudyTrace survey available'),
      notification_body: String(body.notification_body || 'Please complete your scheduled study survey.'),
      interface: 0,
      esms,
    },
  ];
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

function parseEsmQuestions(body) {
  if (Array.isArray(body.esms)) return normalizeEsmArray(body.esms);
  if (body.esms_json) {
    try {
      const parsed = JSON.parse(body.esms_json);
      return normalizeEsmArray(parsed);
    } catch {
      throw httpError(400, 'esms_json must be valid JSON');
    }
  }
  return normalizeEsmArray(defaultEsmQuestions());
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

function defaultEsmQuestions() {
  return [
    {
      esm_type: 2,
      esm_title: 'Current activity',
      esm_instructions: 'What are you doing right now?',
      esm_radios: ['Working or studying', 'Resting', 'Commuting', 'Socializing', 'Other'],
      esm_trigger: 'current_activity',
      esm_submit: 'Next',
      esm_na: true,
    },
    {
      esm_type: 14,
      esm_title: 'Battery usage screenshot',
      esm_instructions: 'Open iPhone Settings → Battery → View All Battery Usage. Take a screenshot showing app battery usage and screen time, then upload that screenshot here.',
      esm_trigger: 'battery_usage_screenshot',
      esm_submit: 'Submit',
      esm_na: true,
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

async function findEsmResponseRows(studyId, rawLimit) {
  const limit = Math.min(Math.max(Number(rawLimit) || 50, 1), 200);
  const sensors = await listStudySensorTables(studyId);
  const esmSensors = [];

  for (const sensor of sensors) {
    if (isKnownEsmSensor(sensor.sensor)) {
      esmSensors.push(sensor.sensor);
      continue;
    }

    const sample = await exportRows(sensor.table, { studyId, limit: 5 });
    if (sample.some((row) => isEsmDataRow(row.data))) {
      esmSensors.push(sensor.sensor);
    }
  }

  const rows = [];
  for (const sensor of [...new Set(esmSensors)]) {
    const table = safeTableName(sensor);
    if (!table) continue;
    const sensorRows = await exportRows(table, { studyId, limit });
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
    ? (await exportRows(table, { studyId, limit })).map(batteryUsageAppRowFromExport)
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

    const image = decodeImageAnswer(source.data?.esm_user_answer);
    const ocr = image
      ? await extractBatteryUsageOcrText(source.data, image.buffer)
      : { text: '', confidence: null, method: 'none', status: 'no_image' };
    const parsedRows = parseBatteryUsageOcrText(ocr.text);
    const sourceImageUrl = `/api/v1/studies/${encodeURIComponent(source.study_id)}/media/${encodeURIComponent(source.sensor)}/${encodeURIComponent(source.id)}/image`;
    const base = {
      source_sensor: source.sensor,
      source_row_id: String(source.id),
      source_image_url: sourceImageUrl,
      extraction_method: ocr.method,
      ocr_confidence: ocr.confidence,
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

    inserted += await insertRows(table, source.study_id, source.device_id, rowsToInsert.map((row) => ({
      timestamp: source.timestamp,
      ...row,
    })));
  }

  return { screenshots: screenshotRows.length, inserted, skipped };
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
      const sensorRows = await exportRows(sensor.table, { limit });
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
    const worker = await tesseract.createWorker('eng');
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
    /(\d{1,2})\s*(?:h|hr|hrs|hour|hours)\s*(\d{1,2})?\s*(?:m|min|mins|minute|minutes)?/i,
    /(\d{1,3})\s*(?:m|min|mins|minute|minutes)\b/i,
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
  const match = String(value || '').match(/\b(\d{1,3})\s*%/);
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
  return String(value || '')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[^A-Za-z0-9).]+$/, '')
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
  if (!/[A-Za-z]/.test(text)) return false;
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
