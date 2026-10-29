import express from 'express';
import { createSensorTable, insertRows, getStudy, latestRow, safeTableName, upsertDevice } from './db.js';

export const ENVIRONMENT_SENSOR = 'environment_measures';
const cache = new Map();
const hourMs = 3600000;

export function environmentSettings(study) {
  return { enabled: study?.config?.environment_collection?.enabled === true,
    provider: 'open-meteo', interval_minutes: 60,
    temperature_unit: 'celsius', cloud_cover_unit: 'percent',
    outdoor_light_unit: 'W/m²', device_light_unit: 'lux',
    note: 'Weather and outdoor solar radiation are model estimates at rounded GPS coordinates. Android light is a device sensor reading when available. iOS has no public ambient-light sensor API.' };
}

export function createEnvironmentRouter({ requireResearcher, requireParticipant }) {
  const router = express.Router();
  router.get('/studies/:studyId/environment-settings', requireResearcher, (req, res) => res.json(environmentSettings(req.study)));
  router.put('/studies/:studyId/environment-settings', requireResearcher, async (req, res, next) => {
    try {
      if (typeof req.body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
      const { updateStudyConfig } = await import('./db.js');
      const study = await updateStudyConfig(req.params.studyId, { environment_collection: { enabled: req.body.enabled } });
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

// Called by both ingestion protocols after locations have been stored. Failed
// weather requests never reject a sensor upload; the next location retries.
export async function collectEnvironment(study, deviceId, rows) {
  if (!deviceId || !environmentSettings(study).enabled) return;
  try {
    const now = Date.now();
    const points = rows.map(weatherPoint).filter((p) => p && p.timestamp <= now + 300000 && p.timestamp >= now - 2 * 86400000);
    const point = points.sort((a, b) => b.timestamp - a.timestamp)[0];
    if (!point) return;
    const table = safeTableName(ENVIRONMENT_SENSOR);
    await createSensorTable(table);
    const previous = await latestRow(table, study.study_id, deviceId);
    if (previous?.weather_observed_at === point.hour) return;
    const key = `${point.latitude}|${point.longitude}|${point.hour}`;
    let weather = cache.get(key);
    if (!weather) {
      weather = fetchWeather(point);
      cache.set(key, weather);
      if (cache.size > 256) cache.delete(cache.keys().next().value);
      weather.catch(() => cache.delete(key));
    }
    const values = await weather;
    // Honor a setting change made while the provider was responding.
    if (!environmentSettings(await getStudy(study.study_id)).enabled) return;
    await insertRows(table, study.study_id, deviceId, [{ ...values, timestamp: point.timestamp,
      location_timestamp: point.timestamp, latitude_rounded: point.latitude, longitude_rounded: point.longitude,
      location_precision_degrees: 0.01, fetched_at: Date.now(), timezone: rows[0]?.timezone || '',
      dedupe_key: `weather:${point.hour}` }]);
    await upsertDevice(deviceId, study.study_id);
  } catch (error) {
    console.warn('[environment] Weather enrichment deferred:', error.message);
  }
}
