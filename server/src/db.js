// PostgreSQL access layer for the AWARE-compatible server.
//
// AWARE clients create one table per sensor on demand (create_table) and then
// POST batches of JSON rows (insert). We don't know each sensor's columns ahead
// of time and they vary by AWARE version, so each table stores the immutable
// identifying columns plus the full original row as JSONB. This preserves every
// field the client sends without brittle per-sensor schemas.

import crypto from 'node:crypto';
import pg from 'pg';
import { hashSecret } from './auth.js';

const { Pool } = pg;

// The pool is created lazily so tests can inject an alternative (e.g. an
// in-memory Postgres) before the first query. Production uses DATABASE_URL.
let pool;

export function setPool(injectedPool) {
  pool = injectedPool;
  ensuredTables.clear();
}

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super('DATABASE_URL is not set. Add a PostgreSQL database service in Railway and link DATABASE_URL to this service.');
    this.name = 'DatabaseNotConfiguredError';
    this.code = 'DATABASE_NOT_CONFIGURED';
  }
}

export function isDatabaseConfigured() {
  return Boolean(pool || process.env.DATABASE_URL);
}

export function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new DatabaseNotConfiguredError();
    }
    // Railway-managed Postgres requires TLS but uses a self-signed chain.
    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 10,
    });
  }
  return pool;
}

// AWARE table names come from sensor identifiers (e.g. "locations",
// "plugin_device_usage"). Constrain to a safe identifier charset and prefix so
// they can never collide with our own metadata tables or inject SQL.
const TABLE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,60}$/;

export function safeTableName(raw) {
  if (typeof raw !== 'string' || !TABLE_NAME_RE.test(raw)) {
    return null;
  }
  return `aware_${raw.toLowerCase()}`;
}

// Metadata tables for studies/participants. Created once at boot.
export async function initSchema() {
  if (!isDatabaseConfigured()) {
    console.warn('DATABASE_URL is not set. Starting in setup mode; data APIs will return 503 until PostgreSQL is configured.');
    return false;
  }
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS studies (
      study_id   TEXT PRIMARY KEY,
      password   TEXT NOT NULL,
      name       TEXT NOT NULL DEFAULT 'StudyTrace Study',
      config     JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Credentials are stored as scrypt hashes. The legacy plaintext `password`
  // column is kept (blanked) so older schemas keep their NOT NULL constraint.
  await getPool().query(`ALTER TABLE studies ADD COLUMN IF NOT EXISTS password_hash TEXT`);
  await getPool().query(`ALTER TABLE studies ADD COLUMN IF NOT EXISTS researcher_password_hash TEXT`);
  await migratePlaintextStudyPasswords();
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id            BIGSERIAL PRIMARY KEY,
      study_id      TEXT NOT NULL,
      device_id     TEXT NOT NULL,
      participant   TEXT,
      source        TEXT NOT NULL,
      delete_data   BOOLEAN NOT NULL DEFAULT false,
      rows_deleted  INTEGER NOT NULL DEFAULT 0,
      requested_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS devices (
      device_id   TEXT NOT NULL,
      study_id    TEXT NOT NULL,
      participant TEXT,
      first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (device_id, study_id)
    );
  `);
  // joined_at: last join/re-join from the app. withdrawn_at: set when the
  // participant withdraws without deleting data, cleared on re-join, so the
  // dashboards count only devices that are still enrolled.
  await getPool().query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ`);
  await getPool().query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ`);
  return true;
}

// Register devices that have stored rows but no devices entry (data uploaded
// before every ingestion path registered its device), so device counts match
// the data. Existing registrations are left untouched.
export async function backfillDevicesFromSensorTables() {
  const countDevices = async () => (await getPool().query(`SELECT count(*)::int AS n FROM devices`)).rows[0].n;
  const before = await countDevices();
  for (const table of await listAwareTables()) {
    await getPool().query(
      `INSERT INTO devices (device_id, study_id, first_seen, last_seen)
       SELECT device_id, study_id, COALESCE(min(created_at), now()), COALESCE(max(created_at), now())
       FROM ${table}
       WHERE study_id IS NOT NULL AND device_id IS NOT NULL AND device_id <> ''
       GROUP BY device_id, study_id
       ON CONFLICT (device_id, study_id) DO NOTHING`
    );
  }
  const added = (await countDevices()) - before;
  if (added > 0) console.log(`Registered ${added} device(s) found in sensor data but missing from the devices table.`);
  return added;
}

async function listAwareTables() {
  const { rows } = await getPool().query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema()`
  );
  return rows
    .map((row) => row.table_name)
    .filter((table) => table.startsWith('aware_') && /^[a-z0-9_]+$/.test(table));
}

// One-time upgrade: hash any study password still stored in plaintext.
export async function migratePlaintextStudyPasswords() {
  const { rows } = await getPool().query(
    `SELECT study_id, password FROM studies WHERE password_hash IS NULL AND password <> ''`
  );
  for (const row of rows) {
    await getPool().query(
      `UPDATE studies SET password_hash = $2, password = '' WHERE study_id = $1`,
      [row.study_id, hashSecret(row.password)]
    );
  }
  if (rows.length) {
    console.log(`Hashed ${rows.length} plaintext study password(s). Researcher passwords must be set by an admin.`);
  }
}

// Tables whose DDL has already run in this process, mapped to whether the
// dedupe index exists. createSensorTable is called on every insert, so the
// schema statements (which take locks) run once per table, not per request.
const ensuredTables = new Map();

// Create a sensor data table on demand. Idempotent.
export async function createSensorTable(table) {
  if (ensuredTables.has(table)) return;
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id         BIGSERIAL,
      study_id   TEXT,
      device_id  TEXT,
      timestamp  DOUBLE PRECISION,
      data       JSONB,
      created_at TIMESTAMPTZ,
      dedupe_key TEXT
    );
  `);
  // Migrate older installs that created sensor tables before these columns.
  await getPool().query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS study_id TEXT`);
  await getPool().query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS dedupe_key TEXT`);
  // Index creation is a non-essential optimization; ignore failures so a
  // re-create on an existing table never blocks an insert.
  try {
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS ${table}_study_device_ts_idx ON ${table} (study_id, device_id, timestamp);`
    );
  } catch {
    // Index already present (or backend rejected a redundant IF NOT EXISTS).
  }
  // Retried uploads carry the same dedupe_key, so the unique index turns a
  // retry into a no-op. Rows stored before this column existed keep NULL,
  // which never conflicts.
  let dedupe = true;
  try {
    await getPool().query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${table}_dedupe_idx ON ${table} (study_id, device_id, dedupe_key);`
    );
  } catch (err) {
    dedupe = false;
    console.warn(`[db] dedupe index unavailable for ${table}; duplicates will not be suppressed`, err.message);
  }
  ensuredTables.set(table, dedupe);
}

// Idempotency key for a row. Clients that retry (the StudyTrace upload queue)
// send a stable event_id / upload_id; otherwise identical rows hash to the
// same key, which collapses AWARE batch re-sends.
export function dedupeKeyForRow(row) {
  for (const field of ['dedupe_key', 'event_id', 'upload_id']) {
    const value = row?.[field];
    if ((typeof value === 'string' && value.trim()) || typeof value === 'number') {
      return `${field}:${String(value).trim().slice(0, 200)}`;
    }
  }
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(row)).digest('hex')}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// Postgres caps a statement at 65,535 bind parameters (6 per row here).
const INSERT_CHUNK_ROWS = 1000;

// Bulk-insert an array of JSON rows into a sensor table. Returns the number
// of rows actually stored; duplicates of already-stored rows are skipped.
export async function insertRows(table, studyId, deviceId, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  if (!ensuredTables.has(table)) await createSensorTable(table);
  const dedupe = ensuredTables.get(table);

  const seen = new Set();
  const unique = [];
  for (const row of rows) {
    const key = dedupeKeyForRow(row);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ row, key });
  }

  let inserted = 0;
  for (let offset = 0; offset < unique.length; offset += INSERT_CHUNK_ROWS) {
    let chunk = unique.slice(offset, offset + INSERT_CHUNK_ROWS);
    if (dedupe && deviceId) {
      // Skip keys already stored so the returned count is exact; ON CONFLICT
      // below still covers two requests racing on the same key. (NULL
      // device_ids never conflict in a unique index, so they are not deduped.)
      const keyParams = chunk.map(({ key }, i) => `$${i + 3}`);
      const { rows: existing } = await getPool().query(
        `SELECT dedupe_key FROM ${table}
         WHERE study_id = $1 AND device_id = $2 AND dedupe_key IN (${keyParams.join(',')})`,
        [studyId, deviceId, ...chunk.map(({ key }) => key)]
      );
      const stored = new Set(existing.map((row) => row.dedupe_key));
      chunk = chunk.filter(({ key }) => !stored.has(key));
      if (!chunk.length) continue;
    }
    const values = [];
    const now = new Date().toISOString();
    const placeholders = chunk.map(({ row, key }, i) => {
      const ts = typeof row.timestamp === 'number'
        ? row.timestamp
        : Number(row.timestamp) || null;
      const base = i * 6;
      values.push(studyId, deviceId, ts, JSON.stringify(row), now, key);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
    });
    const result = await getPool().query(
      `INSERT INTO ${table} (study_id, device_id, timestamp, data, created_at, dedupe_key)
       VALUES ${placeholders.join(',')}
       ${dedupe ? 'ON CONFLICT (study_id, device_id, dedupe_key) DO NOTHING' : ''}`,
      values
    );
    inserted += Math.min(chunk.length, Number.isFinite(result.rowCount) ? result.rowCount : chunk.length);
  }
  return inserted;
}

// Latest row for a device/table, used by the client for incremental sync.
export async function latestRow(table, studyId, deviceId) {
  try {
    const { rows } = await getPool().query(
      `SELECT data
       FROM ${table}
       WHERE study_id = $1 AND device_id = $2
       ORDER BY timestamp DESC NULLS LAST
       LIMIT 1`,
      [studyId, deviceId]
    );
    return rows.length ? rows[0].data : null;
  } catch {
    // Table may not exist yet; treated as "no data".
    return null;
  }
}

export async function clearTable(table, studyId, deviceId) {
  await getPool().query(`DELETE FROM ${table} WHERE study_id = $1 AND device_id = $2`, [studyId, deviceId]);
}

// Row count for a table, optionally scoped to a device. Returns 0 if the table
// does not exist yet.
export async function countRows(table, { studyId, deviceId } = {}) {
  try {
    const params = [];
    const where = [];
    if (studyId) {
      params.push(studyId);
      where.push(`study_id = $${params.length}`);
    }
    if (deviceId) {
      params.push(deviceId);
      where.push(`device_id = $${params.length}`);
    }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM ${table}${clause}`, params);
    return rows[0].n;
  } catch {
    return 0;
  }
}

// Record that a device was seen. `joined` marks a join/re-join from the app,
// which also reverses an earlier withdrawal.
export async function upsertDevice(deviceId, studyId, participant, { joined = false } = {}) {
  if (joined) {
    await getPool().query(
      `INSERT INTO devices (device_id, study_id, participant, joined_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (device_id, study_id)
       DO UPDATE SET last_seen = now(),
                     joined_at = now(),
                     withdrawn_at = NULL,
                     participant = COALESCE(EXCLUDED.participant, devices.participant)`,
      [deviceId, studyId, participant || null]
    );
    return;
  }
  await getPool().query(
    `INSERT INTO devices (device_id, study_id, participant)
     VALUES ($1, $2, $3)
     ON CONFLICT (device_id, study_id)
     DO UPDATE SET last_seen = now(),
                   participant = COALESCE(EXCLUDED.participant, devices.participant)`,
    [deviceId, studyId, participant || null]
  );
}

// Mark a device withdrawn as of `at`, unless it re-joined after that moment
// (a queued withdrawal can be retried after the participant re-enrolled).
export async function markDeviceWithdrawn(studyId, deviceId, at) {
  const when = new Date(at || Date.now()).toISOString();
  await getPool().query(
    `UPDATE devices SET withdrawn_at = $3::timestamptz
     WHERE study_id = $1 AND device_id = $2
       AND (joined_at IS NULL OR joined_at <= $3::timestamptz)`,
    [studyId, deviceId, when]
  );
}

const STUDY_COLUMNS = 'study_id, password_hash, researcher_password_hash, name, config, created_at';

export async function getStudy(studyId) {
  const { rows } = await getPool().query(
    `SELECT ${STUDY_COLUMNS} FROM studies WHERE study_id = $1`,
    [studyId]
  );
  return rows.length ? rows[0] : null;
}

// Create a study, or update only the fields provided for an existing one.
// Returns { study, created }.
export async function upsertStudy(studyId, { password, researcherPassword, name } = {}) {
  const existing = await getStudy(studyId);
  if (!existing) {
    const { rows } = await getPool().query(
      `INSERT INTO studies (study_id, password, password_hash, researcher_password_hash, name)
       VALUES ($1, '', $2, $3, $4)
       RETURNING ${STUDY_COLUMNS}`,
      [studyId, hashSecret(password), researcherPassword ? hashSecret(researcherPassword) : null, name || 'StudyTrace Study']
    );
    return { study: rows[0], created: true };
  }

  const sets = [];
  const params = [studyId];
  if (password) {
    params.push(hashSecret(password));
    sets.push(`password_hash = $${params.length}`);
  }
  if (researcherPassword) {
    params.push(hashSecret(researcherPassword));
    sets.push(`researcher_password_hash = $${params.length}`);
  }
  if (name) {
    params.push(name);
    sets.push(`name = $${params.length}`);
  }
  if (!sets.length) return { study: existing, created: false };
  const { rows } = await getPool().query(
    `UPDATE studies SET ${sets.join(', ')} WHERE study_id = $1 RETURNING ${STUDY_COLUMNS}`,
    params
  );
  return { study: rows[0], created: false };
}

// Delete every row a device contributed to a study, across all sensor tables
// (raw and derived), plus its device registration. Returns rows deleted.
// With `before`, only rows received up to that moment are removed: device IDs
// persist across re-joins, so a withdrawal retried after the participant
// re-enrolled must not delete their new data.
export async function deleteDeviceData(studyId, deviceId, { before } = {}) {
  const cutoff = before ? new Date(before).toISOString() : null;
  let deleted = 0;
  for (const table of await listAwareTables()) {
    const result = cutoff
      ? await getPool().query(
        `DELETE FROM ${table} WHERE study_id = $1 AND device_id = $2 AND created_at <= $3::timestamptz`,
        [studyId, deviceId, cutoff]
      )
      : await getPool().query(
        `DELETE FROM ${table} WHERE study_id = $1 AND device_id = $2`,
        [studyId, deviceId]
      );
    deleted += Number(result.rowCount) || 0;
  }
  if (cutoff) {
    await getPool().query(
      `DELETE FROM devices WHERE study_id = $1 AND device_id = $2 AND last_seen <= $3::timestamptz`,
      [studyId, deviceId, cutoff]
    );
  } else {
    await getPool().query(`DELETE FROM devices WHERE study_id = $1 AND device_id = $2`, [studyId, deviceId]);
  }
  return deleted;
}

export async function getDeviceParticipant(studyId, deviceId) {
  const { rows } = await getPool().query(
    `SELECT participant FROM devices WHERE study_id = $1 AND device_id = $2`,
    [studyId, deviceId]
  );
  return rows.length ? rows[0].participant : null;
}

// Audit record of a withdrawal / deletion. Kept even when data is deleted so
// the research team can document that the request was honored.
export async function recordWithdrawal({ studyId, deviceId, participant, source, deleteData, rowsDeleted, requestedAt }) {
  await getPool().query(
    `INSERT INTO withdrawals (study_id, device_id, participant, source, delete_data, rows_deleted, requested_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
    [
      studyId,
      deviceId,
      participant || null,
      source,
      Boolean(deleteData),
      Number(rowsDeleted) || 0,
      new Date(requestedAt || Date.now()).toISOString(),
    ]
  );
}

export async function listWithdrawals(studyId) {
  const { rows } = await getPool().query(
    `SELECT device_id, participant, source, delete_data, rows_deleted, requested_at
     FROM withdrawals WHERE study_id = $1 ORDER BY requested_at DESC`,
    [studyId]
  );
  return rows;
}

export async function updateStudyConfig(studyId, configPatch) {
  const current = await getStudy(studyId);
  if (!current) return null;
  const nextConfig = { ...(current.config || {}), ...(configPatch || {}) };
  const { rows } = await getPool().query(
    `UPDATE studies
     SET config = $2
     WHERE study_id = $1
     RETURNING ${STUDY_COLUMNS}`,
    [studyId, JSON.stringify(nextConfig)]
  );
  return rows.length ? rows[0] : null;
}

export async function tableExists(table) {
  const { rows } = await getPool().query(`SELECT to_regclass($1) AS reg`, [table]);
  return rows[0].reg !== null;
}

// List the sensor data tables (aware_*) with row counts, for data export/admin.
export async function listSensorTables() {
  const { rows } = await getPool().query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema()
     ORDER BY table_name`
  );
  // Filter to our sensor tables and attach counts.
  const sensors = [];
  for (const r of rows) {
    const t = r.table_name;
    if (!t.startsWith('aware_')) continue;
    const { rows: c } = await getPool().query(`SELECT count(*)::int AS n FROM ${t}`);
    sensors.push({ sensor: t.replace(/^aware_/, ''), table: t, rows: c[0].n });
  }
  return sensors;
}

export async function listStudySensorTables(studyId) {
  const sensors = await listSensorTables();
  const filtered = [];
  for (const sensor of sensors) {
    const rows = await countRows(sensor.table, { studyId });
    if (rows > 0) {
      filtered.push({ ...sensor, rows });
    }
  }
  return filtered.sort((a, b) => b.rows - a.rows || a.sensor.localeCompare(b.sensor));
}

export async function listStudies() {
  const { rows } = await getPool().query(`
    SELECT
      s.study_id,
      s.name,
      s.created_at,
      (s.researcher_password_hash IS NOT NULL) AS researcher_password_set,
      COALESCE(sum(CASE WHEN d.device_id IS NOT NULL AND d.withdrawn_at IS NULL THEN 1 ELSE 0 END), 0)::int AS device_count,
      COALESCE(sum(CASE WHEN d.withdrawn_at IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS withdrawn_device_count,
      max(d.last_seen) AS last_seen
    FROM studies s
    LEFT JOIN devices d ON d.study_id = s.study_id
    GROUP BY s.study_id, s.name, s.created_at, s.researcher_password_hash
    ORDER BY s.created_at DESC
  `);
  return rows;
}

export async function listStudyDevices(studyId) {
  const { rows } = await getPool().query(
    `SELECT device_id, participant, first_seen, last_seen, withdrawn_at
     FROM devices
     WHERE study_id = $1
     ORDER BY last_seen DESC, device_id ASC`,
    [studyId]
  );
  return rows;
}

export async function getStudyOverview(studyId) {
  const study = await getStudy(studyId);
  if (!study) return null;

  const devices = await listStudyDevices(studyId);
  const sensors = await listStudySensorTables(studyId);
  const totalRows = sensors.reduce((sum, sensor) => sum + sensor.rows, 0);
  const enrolled = devices.filter((device) => !device.withdrawn_at);

  return {
    study: {
      study_id: study.study_id,
      name: study.name,
      created_at: study.created_at || null,
      config: study.config || {},
    },
    summary: {
      // Enrolled (not withdrawn) devices; withdrawn ones stay listed with their data.
      device_count: enrolled.length,
      withdrawn_device_count: devices.length - enrolled.length,
      participant_count: new Set(enrolled.map((device) => device.participant).filter(Boolean)).size,
      sensor_count: sensors.length,
      total_rows: totalRows,
      last_seen: devices[0]?.last_seen || null,
    },
    devices,
    sensors,
  };
}

// Rows received for a study since `sinceMs` (epoch ms, by row timestamp),
// newest first. Used for windowed metrics such as 7-day compliance, where a
// fixed row cap would silently truncate busy studies.
export async function rowsSince(table, { studyId, deviceId, sinceMs, limit = 100000 } = {}) {
  const params = [Number(sinceMs) || 0];
  const where = ['timestamp >= $1'];
  if (studyId) {
    params.push(studyId);
    where.push(`study_id = $${params.length}`);
  }
  if (deviceId) {
    params.push(deviceId);
    where.push(`device_id = $${params.length}`);
  }
  params.push(Math.min(Math.max(Number(limit) || 100000, 1), 500000));
  try {
    const { rows } = await getPool().query(
      `SELECT id, study_id, device_id, timestamp, data, created_at
       FROM ${table} WHERE ${where.join(' AND ')}
       ORDER BY timestamp DESC LIMIT $${params.length}`,
      params
    );
    return rows;
  } catch {
    return [];
  }
}

// Page through rows of a sensor table for export. Returns the stored JSON rows
// plus their device_id/timestamp, ordered for stable pagination. Exports page
// oldest-first; dashboards and derived pipelines pass order: 'desc' so that a
// capped read always covers the most recent data.
export async function exportRows(table, { studyId, deviceId, limit, offset, order = 'asc' } = {}) {
  const params = [];
  const where = [];
  if (studyId) {
    params.push(studyId);
    where.push(`study_id = $${params.length}`);
  }
  if (deviceId) {
    params.push(deviceId);
    where.push(`device_id = $${params.length}`);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(Math.min(Math.max(Number(limit) || 1000, 1), 10000));
  const limitClause = `LIMIT $${params.length}`;
  params.push(Math.max(Number(offset) || 0, 0));
  const offsetClause = `OFFSET $${params.length}`;
  const { rows } = await getPool().query(
    `SELECT id, study_id, device_id, timestamp, data, created_at
     FROM ${table} ${whereClause}
     ORDER BY id ${order === 'desc' ? 'DESC' : 'ASC'} ${limitClause} ${offsetClause}`,
    params
  );
  return rows;
}
