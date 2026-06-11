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
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id         BIGSERIAL,
      study_id   TEXT,
      device_id  TEXT,
      timestamp  DOUBLE PRECISION,
      data       JSONB,
      created_at TIMESTAMPTZ
    );
  `);
  // Migrate older installs that created sensor tables before study_id existed.
  await getPool().query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS study_id TEXT`);
  // Index creation is a non-essential optimization; ignore failures so a
  // re-create on an existing table never blocks an insert.
  try {
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS ${table}_study_device_ts_idx ON ${table} (study_id, device_id, timestamp);`
    );
  } catch {
    // Index already present (or backend rejected a redundant IF NOT EXISTS).
  }
}

// Bulk-insert an array of JSON rows into a sensor table.
export async function insertRows(table, studyId, deviceId, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const values = [];
  const placeholders = rows.map((row, i) => {
    const ts = typeof row.timestamp === 'number'
      ? row.timestamp
      : Number(row.timestamp) || null;
    const base = i * 5;
    values.push(studyId, deviceId, ts, JSON.stringify(row), new Date().toISOString());
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
  });
  await getPool().query(
    `INSERT INTO ${table} (study_id, device_id, timestamp, data, created_at) VALUES ${placeholders.join(',')}`,
    values
  );
  return rows.length;
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
    `SELECT study_id, password, name, config, created_at FROM studies WHERE study_id = $1`,
    [studyId]
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
      count(d.device_id)::int AS device_count,
      max(d.last_seen) AS last_seen
    FROM studies s
    LEFT JOIN devices d ON d.study_id = s.study_id
    GROUP BY s.study_id, s.name, s.created_at
    ORDER BY s.created_at DESC
  `);
  return rows;
}

export async function listStudyDevices(studyId) {
  const { rows } = await getPool().query(
    `SELECT device_id, participant, first_seen, last_seen
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

  return {
    study: {
      study_id: study.study_id,
      name: study.name,
      created_at: study.created_at || null,
      config: study.config || {},
    },
    summary: {
      device_count: devices.length,
      sensor_count: sensors.length,
      total_rows: totalRows,
      last_seen: devices[0]?.last_seen || null,
    },
    devices,
    sensors,
  };
}

// Page through rows of a sensor table for export. Returns the stored JSON rows
// plus their device_id/timestamp, ordered for stable pagination.
export async function exportRows(table, { studyId, deviceId, limit, offset } = {}) {
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
     ORDER BY id ASC ${limitClause} ${offsetClause}`,
    params
  );
  return rows;
}
