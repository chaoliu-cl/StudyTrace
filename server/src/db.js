// PostgreSQL access layer for the AWARE-compatible server.
//
// AWARE clients create one table per sensor on demand (create_table) and then
// POST batches of JSON rows (insert). We don't know each sensor's columns ahead
// of time and they vary by AWARE version, so each table stores the immutable
// identifying columns plus the full original row as JSONB. This preserves every
// field the client sends without brittle per-sensor schemas.

import pg from 'pg';

const { Pool } = pg;

// The pool is created lazily so tests can inject an alternative (e.g. an
// in-memory Postgres) before the first query. Production uses DATABASE_URL.
let pool;

export function setPool(injectedPool) {
  pool = injectedPool;
}

export function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      console.error('FATAL: DATABASE_URL is not set. Add a PostgreSQL plugin in Railway.');
      process.exit(1);
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
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS studies (
      study_id   TEXT PRIMARY KEY,
      password   TEXT NOT NULL,
      name       TEXT NOT NULL DEFAULT 'StudyTrace Study',
      config     JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
}

// Create a sensor data table on demand. Idempotent.
export async function createSensorTable(table) {
  // Skip re-creating when it already exists. Besides avoiding redundant DDL,
  // this keeps the hot insert path (which calls this defensively) from issuing
  // a CREATE on every batch.
  if (await tableExists(table)) {
    return;
  }
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id         BIGSERIAL PRIMARY KEY,
      device_id  TEXT,
      timestamp  DOUBLE PRECISION,
      data       JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Index creation is a non-essential optimization; ignore failures so a
  // re-create on an existing table never blocks an insert.
  try {
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS ${table}_device_ts_idx ON ${table} (device_id, timestamp);`
    );
  } catch {
    // Index already present (or backend rejected a redundant IF NOT EXISTS).
  }
}

// Bulk-insert an array of JSON rows into a sensor table.
export async function insertRows(table, deviceId, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const values = [];
  const placeholders = rows.map((row, i) => {
    const ts = typeof row.timestamp === 'number'
      ? row.timestamp
      : Number(row.timestamp) || null;
    const base = i * 3;
    values.push(deviceId, ts, JSON.stringify(row));
    return `($${base + 1}, $${base + 2}, $${base + 3})`;
  });
  await getPool().query(
    `INSERT INTO ${table} (device_id, timestamp, data) VALUES ${placeholders.join(',')}`,
    values
  );
  return rows.length;
}

// Latest row for a device/table, used by the client for incremental sync.
export async function latestRow(table, deviceId) {
  try {
    const { rows } = await getPool().query(
      `SELECT data FROM ${table} WHERE device_id = $1 ORDER BY timestamp DESC NULLS LAST LIMIT 1`,
      [deviceId]
    );
    return rows.length ? rows[0].data : null;
  } catch {
    // Table may not exist yet; treated as "no data".
    return null;
  }
}

export async function clearTable(table, deviceId) {
  await getPool().query(`DELETE FROM ${table} WHERE device_id = $1`, [deviceId]);
}

export async function upsertDevice(deviceId, studyId, participant) {
  await getPool().query(
    `INSERT INTO devices (device_id, study_id, participant)
     VALUES ($1, $2, $3)
     ON CONFLICT (device_id, study_id)
     DO UPDATE SET last_seen = now(),
                   participant = COALESCE(EXCLUDED.participant, devices.participant)`,
    [deviceId, studyId, participant || null]
  );
}

export async function getStudy(studyId) {
  const { rows } = await getPool().query(
    `SELECT study_id, password, name, config FROM studies WHERE study_id = $1`,
    [studyId]
  );
  return rows.length ? rows[0] : null;
}

export async function tableExists(table) {
  const { rows } = await getPool().query(`SELECT to_regclass($1) AS reg`, [table]);
  return rows[0].reg !== null;
}
