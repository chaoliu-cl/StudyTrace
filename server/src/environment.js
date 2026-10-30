import express from 'express';
import { createSensorTable, dedupeKeyForRow, getPool, insertRows, getStudy, safeTableName, upsertDevice } from './db.js';
import { defaultTimeZoneForStudy, isValidTimeZone, localDateFor } from './localTime.js';
import { fetchGreenSpace, greenSpacePoint } from './greenSpace.js';

export const ENVIRONMENT_SENSOR = 'environment_measures';
const cache = new Map();
const hourMs = 3600000;

export function environmentSettings(study) {
  return { enabled: study?.config?.environment_collection?.enabled === true,
    air_quality_enabled: study?.config?.environment_collection?.air_quality_enabled === true,
    context_questions_enabled: study?.config?.environment_collection?.context_questions_enabled === true,
    green_space_enabled: study?.config?.environment_collection?.green_space_enabled === true,
    green_space_provider: 'ESA WorldCover 2021 v200', green_space_interval_minutes: 15,
    device_light_enabled: false,
    provider: 'open-meteo', interval_minutes: 60,
    temperature_unit: 'celsius', cloud_cover_unit: 'percent', humidity_unit: 'percent',
    wind_speed_unit: 'm/s', precipitation_unit: 'mm', daylight_duration_unit: 'seconds',
    air_pollutant_unit: 'µg/m³', air_quality_indices: ['us_aqi', 'european_aqi'],
    outdoor_light_unit: 'W/m²', device_light_unit: 'lux',
    note: 'Weather, daylight timing, air quality, and solar radiation are outdoor estimates. Green-space context uses the historical 2021 land-cover map. Air quality, context questions, and map context have separate opt-ins under the master control. Personal light and indoor exposure sensing are disabled for this protocol.' };
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
      if (req.body.context_questions_enabled !== undefined && typeof req.body.context_questions_enabled !== 'boolean') {
        return res.status(400).json({ error: 'context_questions_enabled must be a boolean' });
      }
      if (req.body.green_space_enabled !== undefined && typeof req.body.green_space_enabled !== 'boolean') {
        return res.status(400).json({ error: 'green_space_enabled must be a boolean' });
      }
      const { updateStudyConfig } = await import('./db.js');
      const settings = { ...req.study.config?.environment_collection, enabled: req.body.enabled };
      // Older dashboards omit the new field; preserve the explicit opt-in.
      if (req.body.air_quality_enabled !== undefined) settings.air_quality_enabled = req.body.air_quality_enabled;
      if (req.body.context_questions_enabled !== undefined) settings.context_questions_enabled = req.body.context_questions_enabled;
      if (req.body.green_space_enabled !== undefined) settings.green_space_enabled = req.body.green_space_enabled;
      const study = await updateStudyConfig(req.params.studyId, { environment_collection: settings });
      res.json(environmentSettings(study));
    } catch (error) { next(error); }
  });
  router.get('/studies/:studyId/environment-config', requireParticipant, (req, res) => {
    const settings = environmentSettings(req.study);
    // Existing Android clients use `enabled` specifically to run their light
    // sensor. Keep that stream off without requiring an app update. Weather
    // uses the study master setting on the server, exposed explicitly here.
    res.json({ ...settings, environment_enabled: settings.enabled, enabled: false });
  });
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
    hourly: 'temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,precipitation,cloud_cover,weather_code,shortwave_radiation', timezone: 'GMT',
    temperature_unit: 'celsius', wind_speed_unit: 'ms', precipitation_unit: 'mm',
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
    relative_humidity_percent: numeric('relative_humidity_2m') !== null && numeric('relative_humidity_2m') >= 0 && numeric('relative_humidity_2m') <= 100 ? numeric('relative_humidity_2m') : null,
    apparent_temperature_c: numeric('apparent_temperature'),
    wind_speed_m_s: numeric('wind_speed_10m') !== null && numeric('wind_speed_10m') >= 0 ? numeric('wind_speed_10m') : null,
    precipitation_mm: numeric('precipitation') !== null && numeric('precipitation') >= 0 ? numeric('precipitation') : null,
    weather_code: numeric('weather_code'), shortwave_radiation_w_m2: numeric('shortwave_radiation'),
    weather_observed_at: point.hour, source: 'open_meteo', measurement_type: 'outdoor_model_estimate',
    light_lux: null, light_lux_status: 'not_measured',
    attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)' };
}

export async function fetchDaylight(point, fetcher = fetch) {
  const timezone = isValidTimeZone(point.timezone) ? point.timezone : 'UTC';
  const date = localDateFor(point.timestamp ?? point.hour, timezone);
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({ latitude: String(point.latitude), longitude: String(point.longitude),
    daily: 'sunrise,sunset,daylight_duration', timezone, timeformat: 'unixtime', start_date: date, end_date: date }).toString();
  const response = await fetcher(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`daylight provider HTTP ${response.status}`);
  const payload = await response.json();
  const daily = payload.daily || {};
  const i = daily.time?.findIndex(time => localDateFor(Number(time) * 1000, timezone) === date) ?? -1;
  if (i < 0) throw new Error('daylight provider did not return the local date');
  const numeric = key => {
    const value = daily[key]?.[i];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  };
  const duration = numeric('daylight_duration');
  if (duration === null || duration > 86400) throw new Error('daylight duration unavailable');
  const sunrise = numeric('sunrise');
  const sunset = numeric('sunset');
  // Polar day/night can have no sunrise/sunset; preserve that as missing.
  return { sunrise_at: sunrise > 0 ? sunrise * 1000 : null, sunset_at: sunset > 0 ? sunset * 1000 : null,
    daylight_duration_seconds: duration, daylight_local_date: date, daylight_timezone: timezone,
    source: 'open_meteo_daylight', measurement_type: 'astronomical_estimate',
    attribution: 'Daylight timing by Open-Meteo.com (CC BY 4.0)' };
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
  if (kind === 'green_space') return fetchGreenSpace(point);
  const period = kind === 'daylight' ? `${point.timezone}:${localDateFor(point.timestamp, point.timezone)}` : point.hour;
  const key = `${kind}:${point.latitude}|${point.longitude}|${period}`;
  let result = cache.get(key);
  if (!result) {
    result = kind === 'weather' ? fetchWeather(point) : kind === 'daylight' ? fetchDaylight(point) : fetchAirQuality(point);
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
    const sourceRow = rows.find(row => weatherPoint(row)?.timestamp === point.timestamp);
    point.timezone = isValidTimeZone(sourceRow?.timezone) ? sourceRow.timezone : defaultTimeZoneForStudy(study);
    const table = safeTableName(ENVIRONMENT_SENSOR);
    await createSensorTable(table);
    const settings = environmentSettings(study);
    const jobs = [{ kind: 'weather', point }, { kind: 'daylight', point }];
    if (settings.air_quality_enabled) jobs.push({ kind: 'air_quality', point });
    if (settings.green_space_enabled) jobs.push({ kind: 'green_space', point: { ...greenSpacePoint(sourceRow), timezone: point.timezone } });
    const identities = jobs.map(({ kind, point: p }) => kind === 'daylight'
      ? `daylight:${p.timezone}:${localDateFor(p.timestamp, p.timezone)}`
      : kind === 'green_space' ? `green_space:${Math.floor(p.timestamp / 900000)}:${p.green_space_status === 'eligible' ? 'map' : p.green_space_status}` : `${kind}:${p.hour}`);
    const keys = identities.map(dedupe_key => dedupeKeyForRow({ dedupe_key }));
    // Check each provider's exact key, since light/air rows can be newer than
    // weather. Separate keys also let a failed provider retry independently.
    const { rows: stored } = await getPool().query(
      `SELECT dedupe_key FROM ${table} WHERE study_id = $1 AND device_id = $2 AND dedupe_key IN (${keys.map((_, i) => `$${i + 3}`).join(',')})`,
      [study.study_id, deviceId, ...keys]
    );
    const existing = new Set(stored.map(row => row.dedupe_key));
    await Promise.all(jobs.map(async ({ kind, point: p }, index) => {
      if (existing.has(keys[index])) return;
      try {
        const values = await cachedEnvironment(kind, p);
        // Honor opt-out while either independent provider request was running.
        const current = environmentSettings(await getStudy(study.study_id));
        if (!current.enabled || (kind === 'air_quality' && !current.air_quality_enabled) || (kind === 'green_space' && !current.green_space_enabled)) return;
        await insertRows(table, study.study_id, deviceId, [{ ...values, timestamp: p.timestamp,
          location_timestamp: p.timestamp, latitude_rounded: p.latitude, longitude_rounded: p.longitude,
          location_precision_degrees: kind === 'green_space' ? 0.001 : 0.01, fetched_at: Date.now(), timezone: p.timezone,
          dedupe_key: identities[index] }]);
        await upsertDevice(deviceId, study.study_id);
      } catch (error) {
        console.warn(`[environment] ${kind === 'weather' ? 'Weather' : kind === 'daylight' ? 'Daylight' : kind === 'green_space' ? 'Green space' : 'Air quality'} enrichment deferred:`, error.message);
      }
    }));
  } catch (error) {
    console.warn('[environment] Environment enrichment deferred:', error.message);
  }
}
