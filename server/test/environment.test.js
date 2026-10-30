import assert from 'node:assert/strict';
import test from 'node:test';
import { writeArrayBuffer } from 'geotiff';
import { newDb } from 'pg-mem';
import * as db from '../src/db.js';
import { environmentContextQuestions, withEnvironmentContext } from '../src/environmentContext.js';
import { fetchDaylight, fetchWeather } from '../src/environment.js';
import { fetchGreenSpace, greenSpacePoint, greenSpaceRegions, readWorldCoverRegion, summarizeGreenSpace, worldCoverTile } from '../src/greenSpace.js';

test('context appends exactly five optional items to each ordinary questionnaire only', () => {
  const make = n => Array.from({ length: n }, (_, i) => ({ esm: { esm_type: 2, esm_title: `Original ${i}`, esm_radios: ['A', 'B'], esm_trigger: `original_${i}`, esm_submit: 'Submit' } }));
  const input = [10, 10, 5].map((n, i) => ({ schedule_id: `scale_${i}`, studytrace_prompt_type: 'esm_survey', esms: make(n) }));
  input.push({ schedule_id: 'app_usage_screenshot_evening', studytrace_prompt_type: 'app_usage_screenshot', esms: [{ esm: { esm_type: 14 } }] });
  const before = structuredClone(input);
  const study = { config: { environment_collection: { enabled: true, context_questions_enabled: true } } };
  const result = withEnvironmentContext(study, input);
  assert.deepEqual(result.map(s => s.esms.length), [15, 15, 10, 1]);
  assert.deepEqual(input, before, 'stored schedules and original instrument definitions are untouched');
  assert.deepEqual(result[3], before[3]);
  result.slice(0, 3).forEach((s, i) => {
    const original = structuredClone(before[i].esms);
    original.at(-1).esm.esm_submit = 'Next';
    assert.deepEqual(s.esms.slice(0, original.length), original);
    assert.equal(s.esms.at(-1).esm.esm_submit, 'Submit');
  });
  assert.deepEqual(withEnvironmentContext(study, result), result, 'refreshes do not duplicate context');
  assert.deepEqual(withEnvironmentContext({ config: {} }, input), input);
  assert.deepEqual(withEnvironmentContext({ config: { environment_collection: { enabled: false, context_questions_enabled: true } } }, input), input);
  assert.ok(environmentContextQuestions().every(q => q.esm.esm_type === 2 && q.esm.studytrace_required === false));
});

test('weather preserves zeros and cold temperatures, and explicitly requests SI units', async () => {
  const hour = Date.parse('2026-10-30T12:00:00Z');
  const row = await fetchWeather({ latitude: 40, longitude: -74, hour }, async url => {
    assert.equal(url.searchParams.get('wind_speed_unit'), 'ms');
    assert.equal(url.searchParams.get('precipitation_unit'), 'mm');
    return new Response(JSON.stringify({ hourly: { time: [hour / 1000], temperature_2m: [-5], apparent_temperature: [-9], relative_humidity_2m: [0], wind_speed_10m: [0], precipitation: [-1] } }));
  });
  assert.equal(row.temperature_c, -5);
  assert.equal(row.apparent_temperature_c, -9);
  assert.equal(row.relative_humidity_percent, 0);
  assert.equal(row.wind_speed_m_s, 0);
  assert.equal(row.precipitation_mm, null);
});

test('daylight follows phone-local dates across UTC midnight, DST, and fractional offsets', async () => {
  for (const fixture of [
    ['2026-11-02T01:30:00Z', 'America/New_York', '2026-11-01', '2026-11-01T04:00:00Z'],
    ['2026-10-30T23:00:00Z', 'Asia/Kolkata', '2026-10-31', '2026-10-30T18:30:00Z'],
  ]) {
    const [timestamp, timezone, date, midnight] = fixture;
    const result = await fetchDaylight({ latitude: 40, longitude: -74, timestamp: Date.parse(timestamp), timezone }, async url => {
      assert.equal(url.searchParams.get('start_date'), date);
      assert.equal(url.searchParams.get('timezone'), timezone);
      return new Response(JSON.stringify({ daily: { time: [Date.parse(midnight) / 1000], sunrise: [null], sunset: [null], daylight_duration: [0] } }));
    });
    assert.equal(result.daylight_local_date, date);
    assert.equal(result.daylight_duration_seconds, 0, 'polar night remains zero');
    assert.equal(result.sunrise_at, null);
    assert.equal(result.sunset_at, null);
  }
});

test('map buffers cross tile boundaries and the antimeridian', () => {
  assert.match(worldCoverTile(39, -84), /N39W084_Map.tif$/);
  assert.equal(greenSpaceRegions({ latitude: 0, longitude: 0 }).length, 4);
  const dateline = greenSpaceRegions({ latitude: 40, longitude: 179.999 });
  assert.ok(dateline.some(r => r.west === -180));
  assert.ok(dateline.every(r => r.west >= -180 && r.west < 180));
});

test('land-cover summaries separate vegetation, crops, buildings, water, zeros, and missing coverage', () => {
  const raster = { width: 3, height: 3, west: -0.00015, north: 0.00015, sx: 0.0001, sy: 0.0001, values: [10, 20, 30, 40, 50, 80, 90, 95, 100] };
  const point = { latitude: 0, longitude: 0 };
  const mixed = summarizeGreenSpace(point, [raster]);
  assert.equal(mixed.natural_vegetation_percent_300m, 66.67);
  assert.equal(mixed.cropland_percent_300m, 11.11);
  assert.equal(mixed.water_percent_300m, 11.11);
  const built = summarizeGreenSpace(point, [{ ...raster, values: Array(9).fill(50) }]);
  assert.equal(built.natural_vegetation_percent_300m, 0, 'a real zero stays zero');
  const partial = summarizeGreenSpace(point, [{ ...raster, values: [0, 10, 10, 10, 10, 10, 10, 10, 10] }]);
  assert.equal(partial.green_space_status, 'partial_map_coverage');
  assert.equal(partial.natural_vegetation_percent_300m, null);
  const missing = summarizeGreenSpace(point, [{ ...raster, values: Array(9).fill(0) }]);
  assert.equal(missing.green_space_status, 'no_map_data');
  assert.equal(missing.tree_cover_percent_300m, null);
});

test('poor GPS accuracy records missing map context without any network request', async () => {
  const point = greenSpacePoint({ latitude: 40, longitude: -74, timestamp: Date.now(), accuracy: 150 });
  const result = await fetchGreenSpace(point, () => { throw new Error('must not query a map'); });
  assert.equal(result.green_space_status, 'location_accuracy_poor');
  assert.equal(result.natural_vegetation_percent_300m, null);
  assert.equal(greenSpacePoint({ latitude: 40, longitude: -74, timestamp: Date.now() }).green_space_status, 'location_accuracy_unavailable');
});

test('participant endpoint, both upload protocols, context exports, and actual GeoTIFF range parsing', async () => {
  const mem = newDb();
  mem.public.registerFunction({ name: 'now', returns: 'timestamptz', implementation: () => new Date() });
  mem.public.registerFunction({ name: 'to_regclass', args: ['text'], returns: 'text', implementation: name => mem.public.getTable(name, true) ? name : null });
  const pg = mem.adapters.createPg();
  const pool = new pg.Pool();
  db.setPool(pool);
  await db.initSchema();
  await db.upsertStudy('context-test', { password: 'participant-fixture', researcherPassword: 'researcher-fixture', name: 'Fixture' });
  const schedule = { schedule_id: 'ordinary_fixture', studytrace_prompt_type: 'esm_survey', times: ['12:00'], esms: [{ esm: { esm_type: 2, esm_title: 'Original', esm_trigger: 'original', esm_radios: ['A', 'B'], esm_submit: 'Submit' } }] };
  await db.updateStudyConfig('context-test', { timezone: 'America/New_York', esm_schedule: [schedule], sentinel: true });
  const { createApp } = await import('../src/appFactory.js');
  const server = await new Promise(resolve => { const s = createApp().listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = '/api/v1/studies/context-test';
  const auth = { 'Content-Type': 'application/json', 'x-researcher-password': 'researcher-fixture' };
  const participant = { 'Content-Type': 'application/json', Authorization: 'Bearer participant-fixture' };
  const originalFetch = globalThis.fetch;
  const now = Date.now();
  const hour = Math.floor(now / 3600000) * 3600000;
  const fixture = Buffer.from(writeArrayBuffer(Array(400 * 400).fill(10), {
    width: 400, height: 400, BitsPerSample: [8], SamplesPerPixel: 1,
    GeographicTypeGeoKey: 4326, ModelPixelScale: [1 / 12000, 1 / 12000, 0], ModelTiepoint: [0, 0, 0, -74.03, 40.73, 0],
  }));
  let mapRequests = 0;
  let mapMode = 'ok';
  globalThis.fetch = async (url, options = {}) => {
    const target = new URL(url);
    if (target.hostname === '127.0.0.1') return originalFetch(url, options);
    if (target.hostname === 'api.open-meteo.com') {
      if (target.searchParams.has('daily')) return new Response(JSON.stringify({ daily: { time: [Date.parse(`${target.searchParams.get('start_date')}T12:00:00Z`) / 1000], sunrise: [hour / 1000], sunset: [hour / 1000 + 30000], daylight_duration: [30000] } }));
      return new Response(JSON.stringify({ hourly: { time: [hour / 1000], temperature_2m: [15], relative_humidity_2m: [60], precipitation: [0], wind_speed_10m: [2] } }));
    }
    if (target.hostname === 'esa-worldcover.s3.eu-central-1.amazonaws.com') {
      mapRequests++;
      if (mapMode === 'fail') return new Response('{}', { status: 503 });
      if (mapMode === 'missing') return new Response('{}', { status: 404 });
      assert.ok(!target.search.includes('latitude') && !target.search.includes('participant'));
      const range = Object.entries(options.headers).find(([key]) => key.toLowerCase() === 'range')[1];
      const [, from, to] = /bytes=(\d+)-(\d+)/.exec(range);
      const start = Number(from), end = Math.min(Number(to), fixture.length - 1);
      const bytes = fixture.subarray(start, end + 1);
      return new Response(bytes, { status: 206, headers: { 'content-length': String(bytes.length), 'content-range': `bytes ${start}-${end}/${fixture.length}`, 'content-type': 'image/tiff' } });
    }
    throw new Error(`Unexpected external request in test: ${target.hostname}`);
  };
  async function call(path, options = {}) { const r = await fetch(base + path, options); return { status: r.status, body: await r.json() }; }
  try {
    const invalid = await call(`${api}/environment-settings`, { method: 'PUT', headers: auth, body: JSON.stringify({ enabled: true, context_questions_enabled: 'true' }) });
    assert.equal(invalid.status, 400);
    const enabled = await call(`${api}/environment-settings`, { method: 'PUT', headers: auth, body: JSON.stringify({ enabled: true, context_questions_enabled: true, green_space_enabled: true }) });
    assert.equal(enabled.status, 200);
    const deviceConfig = await call(`${api}/environment-config`, { headers: participant });
    assert.equal(deviceConfig.body.enabled, false, 'existing Android clients stop personal light collection');
    assert.equal(deviceConfig.body.environment_enabled, true, 'server weather remains enabled');
    assert.equal(deviceConfig.body.device_light_enabled, false);
    const remotePath = '/index.php/webservice/index/context-test/participant-fixture/esm/config';
    const remote = await call(remotePath);
    assert.equal(remote.body[0].esms.length, 6);
    assert.deepEqual((await db.getStudy('context-test')).config.esm_schedule, [schedule]);
    assert.equal((await db.getStudy('context-test')).config.sentinel, true);
    const row = { timestamp: now, double_latitude: 40.7128, double_longitude: -74.006, double_accuracy: 10, timezone: 'America/New_York' };
    const upload = await call(`${api}/sensors/locations/data`, { method: 'POST', headers: participant, body: JSON.stringify({ device_id: 'android-fixture', rows: [row] }) });
    assert.equal(upload.status, 201);
    let exported = await call(`${api}/export/environment_measures`, { headers: auth });
    const map = exported.body.rows.find(r => r.data.source === 'esa_worldcover').data;
    assert.equal(map.green_space_status, 'available');
    assert.equal(map.tree_cover_percent_300m, 100);
    assert.equal(map.map_reference_year, 2021);
    assert.ok(mapRequests > 0);
    const requestsBeforeRetry = mapRequests;
    const aware = await call('/index.php/webservice/index/context-test/participant-fixture/locations/insert', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ device_id: 'ios-fixture', data: JSON.stringify([row]) }).toString() });
    assert.equal(aware.status, 200);
    assert.equal(mapRequests, requestsBeforeRetry, 'map data are cached across phones, observations remain study/device scoped');
    exported = await call(`${api}/export/environment_measures`, { headers: auth });
    assert.equal(exported.body.rows.filter(r => r.data.source === 'esa_worldcover').length, 2);
    await call(`${api}/sensors/locations/data`, { method: 'POST', headers: participant, body: JSON.stringify({ device_id: 'android-fixture', rows: [row] }) });
    exported = await call(`${api}/export/environment_measures`, { headers: auth });
    assert.equal(exported.body.rows.filter(r => r.data.source === 'esa_worldcover').length, 2, 'retries do not duplicate map observations');
    const answer = { timestamp: now, esm_trigger: remote.body[0].esms[1].esm.esm_trigger, esm_json: JSON.stringify(remote.body[0].esms[1]), esm_status: 2, esm_user_answer: 'Outdoors' };
    await call(`${api}/sensors/plugin_ios_esm/data`, { method: 'POST', headers: participant, body: JSON.stringify({ device_id: 'android-fixture', rows: [answer] }) });
    const responses = await call(`${api}/export/survey_responses`, { headers: auth });
    assert.ok(responses.body.rows.some(r => r.data.esm_trigger === 'studytrace_context_setting_v1'));
    const uploadVariant = (device, values) => call(`${api}/sensors/locations/data`, { method: 'POST', headers: participant,
      body: JSON.stringify({ device_id: device, rows: [{ ...row, ...values }] }) });
    mapMode = 'fail';
    assert.equal((await uploadVariant('map-outage', { double_latitude: 40.714, double_longitude: -74.008 })).status, 201, 'map failure preserves GPS upload');
    exported = await call(`${api}/export/environment_measures`, { headers: auth });
    assert.ok(!exported.body.rows.some(r => r.device_id === 'map-outage' && r.data.source === 'esa_worldcover'));
    mapMode = 'ok';
    await uploadVariant('map-outage', { double_latitude: 40.714, double_longitude: -74.008 });
    exported = await call(`${api}/export/environment_measures`, { headers: auth });
    assert.ok(exported.body.rows.some(r => r.device_id === 'map-outage' && r.data.green_space_status === 'available'), 'next upload retries failed map lookup');
    mapMode = 'missing';
    await uploadVariant('missing-tile', { double_latitude: 40.710, double_longitude: -74.008 });
    exported = await call(`${api}/export/environment_measures`, { headers: auth });
    const noMap = exported.body.rows.find(r => r.device_id === 'missing-tile' && r.data.source === 'esa_worldcover').data;
    assert.equal(noMap.green_space_status, 'no_map_data');
    assert.equal(noMap.natural_vegetation_percent_300m, null, 'a missing tile does not mean zero vegetation');
    mapMode = 'ok';
    await uploadVariant('improving-accuracy', { double_accuracy: 200 });
    await uploadVariant('improving-accuracy', { double_accuracy: 10 });
    exported = await call(`${api}/export/environment_measures`, { headers: auth });
    const accuracyRows = exported.body.rows.filter(r => r.device_id === 'improving-accuracy' && r.data.source === 'esa_worldcover');
    assert.equal(accuracyRows.length, 2, 'a poor quality row does not suppress a later usable fix in the same period');
    assert.ok(accuracyRows.some(r => r.data.green_space_status === 'available'));
    const legacy = await call(`${api}/environment-settings`, { method: 'PUT', headers: auth, body: JSON.stringify({ enabled: true }) });
    assert.equal(legacy.body.context_questions_enabled, true);
    assert.equal(legacy.body.green_space_enabled, true, 'older clients preserve optional settings');
    await call(`${api}/environment-settings`, { method: 'PUT', headers: auth, body: JSON.stringify({ enabled: false }) });
    assert.equal((await call(remotePath)).body[0].esms.length, 1, 'opt-out removes injected items after refresh');
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise(resolve => server.close(resolve));
    await pool.end();
  }
});
