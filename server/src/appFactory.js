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

const SCREEN_TIME_EXPORT_SENSOR = 'screentime_app_usage';
const SCREEN_TIME_RAW_EXPORT_SENSOR = 'screentime_raw_log';
const SCREEN_TIME_EXPORT_COLUMNS = [
  'type',
  'target_kind',
  'target_index',
  'target_label',
  'app_name',
  'bundle_identifier',
  'duration_seconds',
  'duration_minutes',
  'pickups',
  'notifications',
  'threshold_minutes',
  'event_name',
  'activity',
  'interval_start',
  'interval_end',
];
const SCREEN_TIME_RAW_EXPORT_COLUMNS = [
  'raw_class',
  'raw_event',
  'raw_message',
  'parsed',
  'parse_reason',
];

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
      await attachStudyScreenTimeSensor(overview, req.params.studyId);
      res.json({ ok: true, ...overview });
    } catch (err) {
      console.error(`[admin study ${req.params.studyId}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.get('/admin/screentime', requireAdmin, async (req, res) => {
    try {
      const rows = await findScreenTimeRows({ limit: req.query.limit });
      res.json({ ok: true, count: rows.length, rows });
    } catch (err) {
      console.error('[admin screentime]', err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.put('/admin/studies/:studyId/esm-schedule', requireAdmin, async (req, res) => {
    try {
      const study = await getStudy(req.params.studyId);
      if (!study) return res.status(404).json({ error: 'study not found' });

      const esmSchedule = buildEsmScheduleFromRequest(req.body || {});
      const updated = await updateStudyConfig(req.params.studyId, { esm_schedule: esmSchedule });
      res.json({ ok: true, study_id: updated.study_id, esm_schedule: esmSchedule });
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
      await attachStudyScreenTimeSensor(overview, req.params.studyId);
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

  app.get('/api/v1/studies/:studyId/dashboard/esm-responses', requireStudyPassword, async (req, res) => {
    try {
      const rows = await findEsmResponseRows(req.params.studyId, req.query.limit);
      return res.json({ ok: true, count: rows.length, rows });
    } catch (err) {
      console.error(`[dashboard esm responses ${req.params.studyId}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.get('/api/v1/studies/:studyId/dashboard/screentime', requireStudyPassword, async (req, res) => {
    try {
      const rows = await findScreenTimeRows({
        studyId: req.params.studyId,
        limit: req.query.limit,
      });
      return res.json({ ok: true, count: rows.length, rows });
    } catch (err) {
      console.error(`[dashboard screentime ${req.params.studyId}]`, err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.get('/api/v1/studies/:studyId/dashboard/screentime-diagnostics', requireStudyPassword, async (req, res) => {
    try {
      const diagnostics = await findScreenTimeDiagnostics({
        studyId: req.params.studyId,
        limit: req.query.limit,
      });
      return res.json({ ok: true, ...diagnostics });
    } catch (err) {
      console.error(`[dashboard screentime diagnostics ${req.params.studyId}]`, err);
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
  const sensors = await listSensorTables();
  const diagnostics = await findScreenTimeDiagnostics({ limit: 10000 });
  upsertVirtualSensor(sensors, SCREEN_TIME_RAW_EXPORT_SENSOR, diagnostics.rawRows.length);
  upsertVirtualSensor(sensors, SCREEN_TIME_EXPORT_SENSOR, diagnostics.appRows.length);
  return sensors.sort((a, b) => String(a.sensor).localeCompare(String(b.sensor)));
}

async function attachStudyScreenTimeSensor(overview, studyId) {
  const diagnostics = await findScreenTimeDiagnostics({ studyId, limit: 10000 });

  const previousTotal = Number(overview.summary?.total_rows || 0);
  overview.sensors = [...(overview.sensors || [])];
  upsertVirtualSensor(overview.sensors, SCREEN_TIME_RAW_EXPORT_SENSOR, diagnostics.rawRows.length);
  upsertVirtualSensor(overview.sensors, SCREEN_TIME_EXPORT_SENSOR, diagnostics.appRows.length);
  overview.sensors.sort((a, b) => Number(b.rows || 0) - Number(a.rows || 0) || String(a.sensor).localeCompare(String(b.sensor)));
  overview.summary = {
    ...(overview.summary || {}),
    sensor_count: overview.sensors.length,
    total_rows: previousTotal + diagnostics.rawRows.length + diagnostics.appRows.length,
  };
  return overview;
}

function upsertVirtualSensor(sensors, sensorName, rows) {
  const existing = sensors.find((sensor) => sensor.sensor === sensorName);
  if (existing) {
    existing.rows = rows;
    existing.table = 'virtual_screen_time_from_ios_aware_log';
    return;
  }
  sensors.push({
    sensor: sensorName,
    table: 'virtual_screen_time_from_ios_aware_log',
    rows,
  });
}

function exportColumnsForSensor(sensor) {
  if (sensor === SCREEN_TIME_EXPORT_SENSOR) return SCREEN_TIME_EXPORT_COLUMNS;
  if (sensor === SCREEN_TIME_RAW_EXPORT_SENSOR) return SCREEN_TIME_RAW_EXPORT_COLUMNS;
  return [];
}

async function exportDashboardSensorRows(sensor, { studyId, deviceId, limit, offset } = {}) {
  if (sensor === SCREEN_TIME_RAW_EXPORT_SENSOR) {
    const diagnostics = await findScreenTimeDiagnostics({ studyId, limit: 10000 });
    const filtered = diagnostics.rawRows
      .filter((row) => !deviceId || row.device_id === deviceId)
      .sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
    const start = Math.max(Number(offset) || 0, 0);
    const pageSize = Math.min(Math.max(Number(limit) || 1000, 1), 10000);
    return filtered.slice(start, start + pageSize).map(screenTimeRawRowToExportRow);
  }

  if (sensor === SCREEN_TIME_EXPORT_SENSOR) {
    const diagnostics = await findScreenTimeDiagnostics({ studyId, limit: 10000 });
    const filtered = diagnostics.appRows
      .filter((row) => !deviceId || row.device_id === deviceId)
      .sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
    const start = Math.max(Number(offset) || 0, 0);
    const pageSize = Math.min(Math.max(Number(limit) || 1000, 1), 10000);
    return filtered.slice(start, start + pageSize).map(screenTimeRowToExportRow);
  }

  const table = safeTableName(sensor);
  if (!table) throw httpError(400, 'invalid sensor name');
  return exportRows(table, { studyId, deviceId, limit, offset });
}

function screenTimeRawRowToExportRow(row) {
  return {
    id: row.id,
    study_id: row.study_id,
    device_id: row.device_id,
    timestamp: row.timestamp,
    created_at: row.created_at,
    data: {
      raw_class: row.raw_class || '',
      raw_event: row.raw_event || '',
      raw_message: row.raw_message || '',
      parsed: row.parsed ? 'true' : 'false',
      parse_reason: row.parse_reason || '',
    },
  };
}

function isAppSpecificScreenTimeRow(row) {
  return row?.target_kind === 'app' && (
    row.type === 'app_usage_summary' ||
    row.type === 'usage_threshold'
  );
}

function screenTimeRowToExportRow(row) {
  return {
    id: row.id,
    study_id: row.study_id,
    device_id: row.device_id,
    timestamp: row.timestamp,
    created_at: row.created_at,
    data: {
      type: row.type || '',
      target_kind: row.target_kind || '',
      target_index: row.target_index ?? '',
      target_label: row.target_label || '',
      app_name: row.app_name || row.target_label || '',
      bundle_identifier: row.bundle_identifier || '',
      duration_seconds: row.duration_seconds ?? '',
      duration_minutes: row.duration_seconds === undefined ? '' : Math.round(Number(row.duration_seconds || 0) / 60),
      pickups: row.pickups ?? '',
      notifications: row.notifications ?? '',
      threshold_minutes: row.threshold_minutes ?? '',
      event_name: row.event_name || '',
      activity: row.activity || '',
      interval_start: row.interval_start ?? '',
      interval_end: row.interval_end ?? '',
    },
  };
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

function buildEsmScheduleFromRequest(body) {
  const mode = body.mode === 'random' ? 'random' : 'fixed';
  const hours = parseHours(body.hours);
  const randomMinutes = mode === 'random'
    ? clampInteger(body.randomize_minutes, 1, 180, 30)
    : 0;
  const scheduleId = sanitizeScheduleId(body.schedule_id || `studytrace_${mode}_survey`);
  const esms = parseEsmQuestions(body);

  return [
    {
      schedule_id: scheduleId,
      hours,
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

function parseHours(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || '').split(/[,\s]+/);
  const hours = [...new Set(values
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 0 && item <= 23))];
  if (!hours.length) throw httpError(400, 'hours must include at least one integer from 0 to 23');
  return hours.sort((a, b) => a - b);
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
      esm_title: 'Context photo',
      esm_instructions: 'Please take a photo of your current context.',
      esm_trigger: 'context_photo',
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

async function findScreenTimeRows({ studyId, limit: rawLimit } = {}) {
  const limit = Math.min(Math.max(Number(rawLimit) || 100, 1), 10000);
  const diagnostics = await findScreenTimeDiagnostics({ studyId, limit });
  return diagnostics.parsedRows.slice(0, limit);
}

async function findScreenTimeDiagnostics({ studyId, limit: rawLimit } = {}) {
  const limit = Math.min(Math.max(Number(rawLimit) || 100, 1), 10000);
  const table = safeTableName('ios_aware_log');
  if (!table || !(await tableExists(table))) {
    return { rawRows: [], parsedRows: [], appRows: [] };
  }

  const rows = await exportRows(table, { studyId, limit: Math.min(limit * 5, 10000) });
  const rawRows = rows
    .map(screenTimeRawRowFromLog)
    .filter(Boolean)
    .sort((a, b) => Number(b.timestamp || b.id || 0) - Number(a.timestamp || a.id || 0))
    .slice(0, limit);
  const parsedRows = rawRows
    .map((row) => row.parsed_row)
    .filter(Boolean)
    .sort((a, b) => Number(b.timestamp || b.id || 0) - Number(a.timestamp || a.id || 0));
  const appRows = parsedRows
    .filter(isAppSpecificScreenTimeRow)
    .sort(sortAppUsageRows);

  return { rawRows, parsedRows, appRows };
}

function screenTimeRawRowFromLog(row) {
  const message = parseLogMessage(row.data?.log_message);
  const rawMessage = stringifyRawLogMessage(row.data?.log_message);
  if (!looksLikeScreenTimeLog(message, rawMessage)) return null;

  const parsedRow = screenTimeRowFromLog(row);
  return {
    id: row.id,
    study_id: row.study_id,
    device_id: row.device_id,
    timestamp: row.timestamp,
    created_at: row.created_at,
    raw_class: screenTimeValue(message, ['class', 'source', 'logger']) || '',
    raw_event: screenTimeValue(message, ['event', 'name', 'notification', 'type']) || '',
    raw_message: rawMessage,
    parsed: Boolean(parsedRow),
    parse_reason: parsedRow ? 'parsed' : screenTimeParseReason(message),
    parsed_row: parsedRow,
  };
}

function screenTimeRowFromLog(row) {
  const message = parseLogMessage(row.data?.log_message);
  if (!message || typeof message !== 'object') return null;

  const event = normalizedScreenTimeEvent(message);

  if (event === 'screen_time_threshold_reached' || hasAnyScreenTimeKey(message, ['threshold_minutes', 'thresholdMinutes'])) {
    const targetKind = normalizeScreenTimeTargetKind(screenTimeValue(message, ['target_kind', 'targetKind', 'kind']));
    const targetIndex = parseOptionalInteger(screenTimeValue(message, ['target_index', 'targetIndex', 'index']));
    return {
      id: row.id,
      study_id: row.study_id,
      device_id: row.device_id,
      timestamp: parseOptionalNumber(screenTimeValue(message, ['event_timestamp', 'eventTimestamp', 'timestamp'])) || row.timestamp,
      created_at: row.created_at,
      type: 'usage_threshold',
      target_kind: targetKind,
      target_index: targetIndex,
      target_label: screenTimeValue(message, ['target_label', 'targetLabel', 'label', 'app_name', 'appName']) || screenTimeTargetLabel(targetKind, targetIndex),
      threshold_minutes: parseOptionalNumber(screenTimeValue(message, ['threshold_minutes', 'thresholdMinutes'])) || 0,
      event_name: screenTimeValue(message, ['screen_time_event', 'screenTimeEvent', 'event_name', 'eventName']) || '',
      activity: screenTimeValue(message, ['activity', 'activity_name', 'activityName']) || '',
      raw: message,
    };
  }

  if (event === 'screen_time_selection_updated') {
    return {
      id: row.id,
      study_id: row.study_id,
      device_id: row.device_id,
      timestamp: row.timestamp,
      created_at: row.created_at,
      type: 'selection_updated',
      target_kind: 'selection',
      target_index: null,
      target_label: 'Tracked selection changed',
      selected_app_count: parseOptionalNumber(screenTimeValue(message, ['selected_app_count', 'selectedAppCount', 'application_count', 'applicationCount'])) || 0,
      selected_category_count: parseOptionalNumber(screenTimeValue(message, ['selected_category_count', 'selectedCategoryCount', 'category_count', 'categoryCount'])) || 0,
      selected_web_count: parseOptionalNumber(screenTimeValue(message, ['selected_web_count', 'selectedWebCount', 'web_count', 'webCount'])) || 0,
      raw: message,
    };
  }

  if (event === 'screen_time_labels_updated') {
    return {
      id: row.id,
      study_id: row.study_id,
      device_id: row.device_id,
      timestamp: row.timestamp,
      created_at: row.created_at,
      type: 'labels_updated',
      target_kind: 'selection',
      target_index: null,
      target_label: 'Participant app labels updated',
      labels: parseJsonArray(screenTimeValue(message, ['labels_json', 'labelsJson', 'labels'])),
      raw: message,
    };
  }

  if (event === 'screen_time_report_app_usage' || looksLikeAppUsageSummary(message)) {
    const rawTargetKind = screenTimeValue(message, ['target_kind', 'targetKind', 'kind']);
    const targetKind = rawTargetKind
      ? normalizeScreenTimeTargetKind(rawTargetKind)
      : 'app';
    const targetIndex = parseOptionalInteger(screenTimeValue(message, ['target_index', 'targetIndex', 'index']));
    const appName = screenTimeValue(message, ['app_name', 'appName', 'localizedDisplayName', 'displayName', 'applicationName', 'name']);
    const bundleIdentifier = screenTimeValue(message, ['bundle_identifier', 'bundleIdentifier', 'bundleId', 'applicationIdentifier']);
    const durationSeconds = parseDurationSeconds(screenTimeValue(message, [
      'duration_seconds',
      'durationSeconds',
      'totalActivityDuration',
      'total_activity_duration',
      'usage_seconds',
      'usageSeconds',
      'seconds',
      'duration',
    ]));
    return {
      id: row.id,
      study_id: row.study_id,
      device_id: row.device_id,
      timestamp: parseOptionalNumber(screenTimeValue(message, ['event_timestamp', 'eventTimestamp', 'timestamp'])) || row.timestamp,
      created_at: row.created_at,
      type: 'app_usage_summary',
      target_kind: targetKind,
      target_index: targetIndex,
      target_label: screenTimeValue(message, ['target_label', 'targetLabel', 'label']) || appName || bundleIdentifier || screenTimeTargetLabel(targetKind, targetIndex),
      app_name: appName || '',
      bundle_identifier: bundleIdentifier || '',
      duration_seconds: durationSeconds || 0,
      pickups: parseOptionalNumber(screenTimeValue(message, ['pickups', 'numberOfPickups', 'pickup_count', 'pickupCount'])) || 0,
      notifications: parseOptionalNumber(screenTimeValue(message, ['notifications', 'numberOfNotifications', 'notification_count', 'notificationCount'])) || 0,
      interval_start: parseOptionalNumber(screenTimeValue(message, ['interval_start', 'intervalStart', 'start', 'start_time', 'startTime'])) || null,
      interval_end: parseOptionalNumber(screenTimeValue(message, ['interval_end', 'intervalEnd', 'end', 'end_time', 'endTime'])) || null,
      raw: message,
    };
  }

  return null;
}

function looksLikeScreenTimeLog(message, rawMessage) {
  if (screenTimeValue(message, ['class']) === 'SpecificAppUsageManager') return true;
  if (looksLikeAppUsageSummary(message)) return true;
  const text = String(rawMessage || '').toLowerCase();
  return text.includes('screen_time') ||
    text.includes('screentime') ||
    text.includes('specificappusagemanager') ||
    text.includes('deviceactivity') ||
    text.includes('familyactivity');
}

function screenTimeParseReason(message) {
  if (!message) return 'log_message is not valid JSON';
  const event = screenTimeValue(message, ['event', 'name', 'notification', 'type']);
  const klass = screenTimeValue(message, ['class', 'source', 'logger']);
  if (!event && !looksLikeAppUsageSummary(message)) return `no recognizable Screen Time event; class=${klass || 'missing'}`;
  return `unrecognized event: ${event || 'missing'}; class=${klass || 'missing'}`;
}

function stringifyRawLogMessage(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizedScreenTimeEvent(message) {
  return String(screenTimeValue(message, ['event', 'name', 'type']) || '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
}

function looksLikeAppUsageSummary(message) {
  if (!message || typeof message !== 'object') return false;
  const event = normalizedScreenTimeEvent(message);
  if (event.includes('screen_time_report_app_usage') ||
      event.includes('app_usage_summary') ||
      event.includes('report_app_usage')) {
    return true;
  }
  const hasDuration = hasAnyScreenTimeKey(message, [
    'duration_seconds',
    'durationSeconds',
    'totalActivityDuration',
    'total_activity_duration',
    'usage_seconds',
    'usageSeconds',
    'seconds',
    'duration',
  ]);
  const hasAppIdentity = hasAnyScreenTimeKey(message, [
    'app_name',
    'appName',
    'localizedDisplayName',
    'displayName',
    'applicationName',
    'bundle_identifier',
    'bundleIdentifier',
    'bundleId',
    'applicationIdentifier',
    'target_label',
    'targetLabel',
  ]);
  return hasDuration && hasAppIdentity;
}

function hasAnyScreenTimeKey(message, keys) {
  return Boolean(screenTimeValue(message, keys) !== undefined);
}

function screenTimeValue(message, keys) {
  if (!message || typeof message !== 'object') return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(message, key)) return message[key];
  }
  const lowerMap = new Map(Object.keys(message).map((key) => [key.toLowerCase(), key]));
  for (const key of keys) {
    const actual = lowerMap.get(String(key).toLowerCase());
    if (actual) return message[actual];
  }
  return undefined;
}

function parseOptionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseDurationSeconds(value) {
  const number = parseOptionalNumber(value);
  if (number === null) return null;
  // DeviceActivity reports seconds. If a future client sends milliseconds,
  // normalize obviously large sub-day values to seconds.
  return number > 86400 ? number / 1000 : number;
}

function sortAppUsageRows(a, b) {
  const durationDiff = Number(b.duration_seconds || 0) - Number(a.duration_seconds || 0);
  if (durationDiff !== 0) return durationDiff;
  return Number(b.timestamp || b.id || 0) - Number(a.timestamp || a.id || 0);
}

function parseLogMessage(value) {
  if (!value) return null;
  let current = value;
  for (let i = 0; i < 4; i += 1) {
    if (current && typeof current === 'object') return current;
    if (typeof current !== 'string') return null;
    const trimmed = current.trim();
    if (!trimmed) return null;
    try {
      current = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  return current && typeof current === 'object' ? current : null;
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeScreenTimeTargetKind(value) {
  const kind = String(value || '').toLowerCase();
  if (['app', 'category', 'web', 'aggregate', 'selection'].includes(kind)) return kind;
  return 'aggregate';
}

function parseOptionalInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function screenTimeTargetLabel(kind, index) {
  if (kind === 'aggregate') return 'Selected apps total';
  const number = Number.isInteger(index) ? index + 1 : '';
  if (kind === 'app') return `App ${number}`.trim();
  if (kind === 'category') return `Category ${number}`.trim();
  if (kind === 'web') return `Website ${number}`.trim();
  return 'Selection';
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
