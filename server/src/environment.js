import express from 'express';
import { createSensorTable, dedupeKeyForRow, getPool, insertRows, getStudy, safeTableName, upsertDevice } from './db.js';

export const ENVIRONMENT_SENSOR = 'environment_measures';
const cache = new Map();
const hourMs = 3600000;

export function environmentSettings(study) {
  return { enabled: study?.config?.environment_collection?.enabled === true,
    air_quality_enabled: study?.config?.environment_collection?.air_quality_enabled === true,
    provider: 'open-meteo', interval_minutes: 60,
    temperature_unit: 'celsius', cloud_cover_unit: 'percent',
    air_pollutant_unit: 'µg/m³', air_quality_indices: ['us_aqi', 'european_aqi'],
    outdoor_light_unit: 'W/m²', device_light_unit: 'lux',
    note: 'Weather, air quality, and outdoor solar radiation are outdoor model estimates at rounded GPS coordinates. Air quality requires both environment collection and its separate opt-in. Android light is a device sensor reading when available. iOS has no public ambient-light sensor API.' };
}

export function createEnvironmentRouter({ requireResearcher, requireParticipant }) {
  const router = express.Router();
  router.get('/studies/:studyId/environment-settings', requireResearcher, (req, res) => res.json(environmentSettings(req.study)));
  router.put('/studies/:studyId/environment-settings', requireResearcher, async (req, res, next) => {
    try {
      if (typeof req.body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
      if (req.body.air_quality_enabled !== undefined && typeof req.body.air_quality_enabled !== 'boolean') {
        return res.status(400).json({ error: 'air_quality_enabled must be a boolean' });
      }
      const { updateStudyConfig } = await import('./db.js');
      const settings = { ...req.study.config?.environment_collection, enabled: req.body.enabled };
      // Older dashboards omit the new field; preserve the explicit opt-in.
      if (req.body.air_quality_enabled !== undefined) settings.air_quality_enabled = req.body.air_quality_enabled;
      const study = await updateStudyConfig(req.params.studyId, { environment_collection: settings });
      res.json(environmentSettings(study));
    } catch (error) { next(error); }
  });
  router.get('/studies/:studyId/environment-config', requireParticipant, (req, res) => res.json(environmentSettings(req.study)));
  return router;
}

export function weatherPoint(row) {
  if (!row || (row.double_latitude ?? row.latitude) == null || (row.double_longitude ?? row.longitude) == null || (row.double_latitude ?? row.latitude) === '' || (row.double_longitude ?? row.longitude) === '') return null;
  const latitude = Number(row.double_latitude ?? row.latitude);
  const longitude = Number(row.double_longitude ?? row.longitude);
  let timestamp = Number(row.timestamp);
  if (timestamp > 0 && timestamp < 1e11) timestamp *= 1000;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  return { latitude: Math.round(latitude * 100) / 100, longitude: Math.round(longitude * 100) / 100,
    timestamp, hour: Math.floor(timestamp / hourMs) * hourMs };
}

export async function fetchWeather(point, fetcher = fetch) {
  const date = new Date(point.hour).toISOString().slice(0, 10);
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({ latitude: String(point.latitude), longitude: String(point.longitude),
    hourly: 'temperature_2m,cloud_cover,weather_code,shortwave_radiation', timezone: 'GMT',
    timeformat: 'unixtime', start_date: date, end_date: date }).toString();
  const response = await fetcher(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`weather provider HTTP ${response.status}`);
  const payload = await response.json();
  const i = payload.hourly?.time?.findIndex((time) => Number(time) * 1000 === point.hour) ?? -1;
  if (i < 0) throw new Error('weather provider did not return the requested hour');
  const numeric = (key) => {
    const value = payload.hourly[key]?.[i];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  if (numeric('temperature_2m') === null) throw new Error('weather temperature unavailable');
  return { temperature_c: numeric('temperature_2m'), cloud_cover_percent: numeric('cloud_cover'),
    weather_code: numeric('weather_code'), shortwave_radiation_w_m2: numeric('shortwave_radiation'),
    weather_observed_at: point.hour, source: 'open_meteo', measurement_type: 'outdoor_model_estimate',
    light_lux: null, light_lux_status: 'not_measured',
    attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)' };
}

export async function fetchAirQuality(point, fetcher = fetch) {
  const date = new Date(point.hour).toISOString().slice(0, 10);
  const url = new URL('https://air-quality-api.open-meteo.com/v1/air-quality');
  const pollutants = ['pm2_5', 'pm10', 'carbon_monoxide', 'nitrogen_dioxide', 'sulphur_dioxide', 'ozone'];
  url.search = new URLSearchParams({ latitude: String(point.latitude), longitude: String(point.longitude),
    hourly: [...pollutants, 'us_aqi', 'european_aqi'].join(','), domains: 'auto', timezone: 'GMT',
    timeformat: 'unixtime', start_date: date, end_date: date }).toString();
  const response = await fetcher(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`air quality provider HTTP ${response.status}`);
  const payload = await response.json();
  const i = payload.hourly?.time?.findIndex(time => Number(time) * 1000 === point.hour) ?? -1;
  if (i < 0) throw new Error('air quality provider did not return the requested hour');
  const numeric = key => {
    const value = payload.hourly[key]?.[i];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  };
  const values = Object.fromEntries(pollutants.map(key => [`${key}_ug_m3`, numeric(key)]));
  values.us_aqi = numeric('us_aqi');
  values.european_aqi = numeric('european_aqi');
  if (Object.values(values).every(value => value === null)) throw new Error('air quality values unavailable');
  return { ...values, air_quality_observed_at: point.hour,
    air_quality_domain_selection: 'auto', air_quality_model: 'CAMS via Open-Meteo',
    air_quality_grid_latitude: typeof payload.latitude === 'number' ? payload.latitude : null,
    air_quality_grid_longitude: typeof payload.longitude === 'number' ? payload.longitude : null,
    source: 'open_meteo_air_quality', measurement_type: 'outdoor_model_estimate',
    attribution: 'Air quality data by CAMS ENSEMBLE data providers / Copernicus Atmosphere Monitoring Service, via Open-Meteo.com.' };
}

async function cachedEnvironment(kind, point) {
  const key = `${kind}:${point.latitude}|${point.longitude}|${point.hour}`;
  let result = cache.get(key);
  if (!result) {
    result = kind === 'weather' ? fetchWeather(point) : fetchAirQuality(point);
    cache.set(key, result);
    if (cache.size > 256) cache.delete(cache.keys().next().value);
    result.catch(() => { if (cache.get(key) === result) cache.delete(key); });
  }
  return result;
}

// Called by both ingestion protocols after locations have been stored. Failed
// provider requests never reject a sensor upload; the next location retries.
export async function collectEnvironment(study, deviceId, rows) {
  if (!deviceId || !environmentSettings(study).enabled) return;
  try {
    const now = Date.now();
    const points = rows.map(weatherPoint).filter((p) => p && p.timestamp <= now + 300000 && p.timestamp >= now - 2 * 86400000);
    const point = points.sort((a, b) => b.timestamp - a.timestamp)[0];
    if (!point) return;
    const table = safeTableName(ENVIRONMENT_SENSOR);
    await createSensorTable(table);
    const kinds = environmentSettings(study).air_quality_enabled ? ['weather', 'air_quality'] : ['weather'];
    const keys = kinds.map(kind => dedupeKeyForRow({ dedupe_key: `${kind}:${point.hour}` }));
    // Check each provider's exact key, since light/air rows can be newer than
    // weather. Separate keys also let a failed provider retry independently.
    const { rows: stored } = await getPool().query(
      `SELECT dedupe_key FROM ${table} WHERE study_id = $1 AND device_id = $2 AND dedupe_key IN (${keys.map((_, i) => `$${i + 3}`).join(',')})`,
      [study.study_id, deviceId, ...keys]
    );
    const existing = new Set(stored.map(row => row.dedupe_key));
    await Promise.all(kinds.map(async (kind, index) => {
      if (existing.has(keys[index])) return;
      try {
        const values = await cachedEnvironment(kind, point);
        // Honor opt-out while either independent provider request was running.
        const current = environmentSettings(await getStudy(study.study_id));
        if (!current.enabled || (kind === 'air_quality' && !current.air_quality_enabled)) return;
        const sourceRow = rows.find(row => weatherPoint(row)?.timestamp === point.timestamp);
        await insertRows(table, study.study_id, deviceId, [{ ...values, timestamp: point.timestamp,
          location_timestamp: point.timestamp, latitude_rounded: point.latitude, longitude_rounded: point.longitude,
          location_precision_degrees: 0.01, fetched_at: Date.now(), timezone: sourceRow?.timezone || '',
          dedupe_key: `${kind}:${point.hour}` }]);
        await upsertDevice(deviceId, study.study_id);
      } catch (error) {
        console.warn(`[environment] ${kind === 'weather' ? 'Weather' : 'Air quality'} enrichment deferred:`, error.message);
      }
    }));
  } catch (error) {
    console.warn('[environment] Environment enrichment deferred:', error.message);
  }
}
