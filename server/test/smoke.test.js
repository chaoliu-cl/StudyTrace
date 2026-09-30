// Local verification harness. Spins up the Express app against an in-memory
// Postgres (pg-mem), then exercises the AWARE protocol end-to-end. Not part of
// the deployed server; run with `node test/smoke.test.js`.

import assert from 'node:assert';
import { newDb } from 'pg-mem';
import * as db from '../src/db.js';

process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.PUBLIC_BASE_URL = 'https://example.up.railway.app';

// Wire pg-mem in as the pool before importing the app.
const mem = newDb();
mem.public.registerFunction({
  name: 'now',
  returns: 'timestamptz',
  implementation: () => new Date(),
});
// Real Postgres ships to_regclass; pg-mem does not. Emulate it for the test by
// checking the in-memory catalog for the (already aware_-prefixed) table name.
mem.public.registerFunction({
  name: 'to_regclass',
  args: ['text'],
  returns: 'text',
  implementation: (name) => {
    try {
      const exists = mem.public.getTable(name, true);
      return exists ? name : null;
    } catch {
      return null;
    }
  },
});
const pg = mem.adapters.createPg();
const pool = new pg.Pool();
db.setPool(pool);

await db.initSchema();

// Import app lazily so it uses the injected pool.
const { createApp } = await import('../src/appFactory.js');
const app = createApp();

const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

async function post(path, body, headers = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers,
    body,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

async function postWithoutContentType(path, body) {
  const res = await fetch(base + path, {
    method: 'POST',
    body,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

const form = (obj) =>
  Object.entries(obj).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const formHeaders = { 'Content-Type': 'application/x-www-form-urlencoded' };

// Generic request helper for the JSON API (any method).
async function request(method, path, { body, headers } = {}) {
  const res = await fetch(base + path, { method, headers, body });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

const RESEARCHER_PASSWORD = 'researcher-secret-123';
const researcherAuth = {
  'Content-Type': 'application/json',
  'x-researcher-password': RESEARCHER_PASSWORD,
};
const adminJson = { 'Content-Type': 'application/json', 'x-admin-token': 'test-admin-token' };

try {
  // 0. Security headers on every response.
  const statusRes = await fetch(`${base}/status`);
  assert.match(statusRes.headers.get('content-security-policy') || '', /default-src 'self'/, 'CSP header set');
  assert.strictEqual(statusRes.headers.get('x-content-type-options'), 'nosniff', 'nosniff header set');
  assert.strictEqual(statusRes.headers.get('x-powered-by'), null, 'x-powered-by removed');
  console.log('✓ security headers present');

  // 1. Provision a study via admin.
  const missingResearcher = await post('/admin/studies',
    JSON.stringify({ study_id: 'demo', password: 'secret', name: 'Demo' }), adminJson);
  assert.strictEqual(missingResearcher.status, 400, 'new study requires a researcher password');
  const admin = await post('/admin/studies',
    JSON.stringify({ study_id: 'demo', password: 'secret', researcher_password: RESEARCHER_PASSWORD, name: 'Demo' }),
    adminJson);
  assert.strictEqual(admin.status, 200, 'admin create study');
  assert.ok(admin.json.study_url.includes('/index.php/webservice/index/demo/secret'), 'study url shape');
  const storedStudy = await db.getStudy('demo');
  assert.ok(storedStudy.password_hash.startsWith('scrypt$'), 'participant password stored hashed');
  assert.ok(storedStudy.researcher_password_hash.startsWith('scrypt$'), 'researcher password stored hashed');
  const { rows: plainRows } = await pool.query(`SELECT password FROM studies WHERE study_id = 'demo'`);
  assert.strictEqual(plainRows[0].password, '', 'no plaintext password persisted');
  console.log('✓ admin provision study:', admin.json.study_url);

  const studyPath = '/index.php/webservice/index/demo/secret';

  const scheduleBody = {
    mode: 'random',
    times: '09:30, 17:15',
    randomize_minutes: '20',
    expiration_minutes: '90',
    notification_title: 'StudyTrace test survey',
    notification_body: 'Please complete the test survey.',
    esms_json: JSON.stringify([
      {
        esm_type: 2,
        esm_title: 'Current activity',
        esm_radios: ['Working', 'Resting'],
        esm_trigger: 'pilot_activity',
      },
      {
        esm_type: 14,
        esm_title: 'Context photo',
        esm_trigger: 'pilot_context_photo',
      },
    ]),
  };
  const scheduleSave = await request('PUT', '/admin/studies/demo/esm-schedule', {
    body: JSON.stringify(scheduleBody),
    headers: { 'Content-Type': 'application/json', 'x-admin-token': 'test-admin-token' },
  });
  assert.strictEqual(scheduleSave.status, 200, 'admin save ESM schedule');
  assert.deepStrictEqual(scheduleSave.json.esm_schedule[0].hours, [9, 17], 'ESM schedule hours');
  assert.deepStrictEqual(scheduleSave.json.esm_schedule[0].times, ['09:30', '17:15'], 'ESM exact prompt times');
  assert.strictEqual(scheduleSave.json.esm_schedule[0].randomize, 20, 'ESM randomization minutes');
  console.log('✓ admin saves randomized ESM delivery schedule');

  // 2. Wrong password rejected.
  const bad = await post('/index.php/webservice/index/demo/wrong', form({ device_id: 'd1' }), formHeaders);
  assert.strictEqual(bad.status, 403, 'bad password rejected');
  console.log('✓ invalid password rejected');

  // 3. Join -> config array.
  const join = await post(`${studyPath}?participant=p1`, form({ device_id: 'dev-1' }), formHeaders);
  assert.strictEqual(join.status, 200, 'join ok');
  assert.ok(Array.isArray(join.json), 'config is array');
  assert.strictEqual(join.json[0].study_id, 'demo', 'config study_id');
  const iosEsmPlugin = join.json[0].plugins.find((plugin) => plugin.plugin === 'plugin_ios_esm');
  assert.ok(iosEsmPlugin, 'join config includes iOS ESM plugin');
  assert.ok(
    iosEsmPlugin.settings.some((setting) =>
      setting.setting === 'plugin_ios_esm_config_url' &&
      setting.value === 'https://example.up.railway.app/index.php/webservice/index/demo/secret/esm/config'
    ),
    'join config includes ESM config URL'
  );
  console.log('✓ join returns config array');

  const remoteEsmConfig = await request('GET', `${studyPath}/esm/config`);
  assert.strictEqual(remoteEsmConfig.status, 200, 'remote ESM config ok');
  assert.strictEqual(remoteEsmConfig.json[0].schedule_id, 'studytrace_random_esm_survey', 'remote ESM schedule id');
  assert.strictEqual(remoteEsmConfig.json[0].esms.length, 2, 'remote ESM question count');
  assert.deepStrictEqual(remoteEsmConfig.json[0].times, ['09:30', '17:15'], 'remote ESM config includes exact prompt times');
  console.log('✓ participant app can download ESM schedule config');

  // 4. create_table.
  const ct = await post(`${studyPath}/locations/create_table`, form({ device_id: 'dev-1' }), formHeaders);
  assert.strictEqual(ct.status, 200, 'create_table ok');
  assert.strictEqual(ct.json.status, true);
  console.log('✓ create_table');

  // 5. insert rows.
  const rows = [
    { timestamp: 1000, double_latitude: 35.6, double_longitude: 139.7, device_id: 'dev-1' },
    { timestamp: 2000, double_latitude: 35.7, double_longitude: 139.8, device_id: 'dev-1' },
  ];
  const ins = await post(`${studyPath}/locations/insert`,
    form({ device_id: 'dev-1', data: JSON.stringify(rows) }), formHeaders);
  assert.strictEqual(ins.status, 200, 'insert ok');
  assert.strictEqual(ins.json.inserted, 2, 'inserted 2 rows');
  console.log('✓ insert rows:', ins.json.inserted);

  // 6. latest returns most recent row.
  const latest = await post(`${studyPath}/locations/latest`, form({ device_id: 'dev-1' }), formHeaders);
  assert.strictEqual(latest.status, 200, 'latest ok');
  assert.ok(Array.isArray(latest.json) && latest.json.length === 1, 'latest is array of 1');
  assert.strictEqual(latest.json[0].timestamp, 2000, 'latest is newest row');
  console.log('✓ latest returns newest row, ts =', latest.json[0].timestamp);

  // 7. invalid table name rejected.
  const badtbl = await post(`${studyPath}/bad-table!/insert`, form({ device_id: 'dev-1' }), formHeaders);
  assert.strictEqual(badtbl.status, 400, 'invalid table rejected');
  console.log('✓ invalid table name rejected');

  // 8. clear_table is disabled: the shared study password cannot delete data.
  const clear = await post(`${studyPath}/locations/clear_table`, form({ device_id: 'dev-1' }), formHeaders);
  assert.strictEqual(clear.status, 403, 'clear_table refused');
  const afterClear = await post(`${studyPath}/locations/latest`, form({ device_id: 'dev-1' }), formHeaders);
  assert.strictEqual(afterClear.json[0].timestamp, 2000, 'rows survive clear_table attempt');
  console.log('✓ clear_table is disabled for participants');

  // ---- Generic JSON API (protocol-neutral front-end) ------------------------
  const apiBase = `/api/v1/studies/demo`;
  const jsonAuth = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer secret',
  };

  // 9. Missing credentials -> 401.
  const noAuth = await request('POST', `${apiBase}/sensors/heartrate/data`,
    { body: JSON.stringify({ device_id: 'dev-1', rows: [{ timestamp: 1, bpm: 60 }] }),
      headers: { 'Content-Type': 'application/json' } });
  assert.strictEqual(noAuth.status, 401, 'generic api requires credentials');
  console.log('✓ generic API rejects missing credentials');

  // 10. Wrong password -> 403.
  const wrongPw = await request('POST', `${apiBase}/sensors/heartrate/data`,
    { body: JSON.stringify({ device_id: 'dev-1', rows: [{ timestamp: 1, bpm: 60 }] }),
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer nope' } });
  assert.strictEqual(wrongPw.status, 403, 'generic api rejects wrong password');
  console.log('✓ generic API rejects wrong password');

  // 11. Insert via {device_id, rows:[...]}.
  const gIns = await request('POST', `${apiBase}/sensors/heartrate/data`,
    { body: JSON.stringify({ device_id: 'dev-1', rows: [
      { timestamp: 100, bpm: 60 }, { timestamp: 200, bpm: 72 }, { timestamp: 300, bpm: 68 },
    ] }), headers: jsonAuth });
  assert.strictEqual(gIns.status, 201, 'generic insert ok');
  assert.strictEqual(gIns.json.inserted, 3, 'generic inserted 3');
  console.log('✓ generic API insert:', gIns.json.inserted);

  // 12. Bearer auth also works as x-study-password header + bare array body.
  const gIns2 = await request('POST', `${apiBase}/sensors/heartrate/data`,
    { body: JSON.stringify([{ timestamp: 400, bpm: 80, device_id: 'dev-1' }]),
      headers: { 'Content-Type': 'application/json', 'x-study-password': 'secret', 'x-device-id': 'dev-1' } });
  assert.strictEqual(gIns2.status, 201, 'generic insert (array + header auth) ok');
  console.log('✓ generic API accepts bare array + x-study-password');

  // 13. count.
  const gCount = await request('GET', `${apiBase}/sensors/heartrate/count?device_id=dev-1`, { headers: jsonAuth });
  assert.strictEqual(gCount.json.count, 4, 'generic count = 4');
  console.log('✓ generic API count =', gCount.json.count);

  // 14. latest.
  const gLatest = await request('GET', `${apiBase}/sensors/heartrate/latest?device_id=dev-1`, { headers: jsonAuth });
  assert.strictEqual(gLatest.json.latest.timestamp, 400, 'generic latest newest');
  console.log('✓ generic API latest ts =', gLatest.json.latest.timestamp);

  // 15. invalid sensor name -> 400.
  const gBad = await request('POST', `${apiBase}/sensors/bad-name!/data`,
    { body: JSON.stringify({ device_id: 'dev-1', rows: [{ timestamp: 1 }] }), headers: jsonAuth });
  assert.strictEqual(gBad.status, 400, 'generic invalid sensor rejected');
  console.log('✓ generic API rejects invalid sensor name');

  // 16. delete requires the researcher password, then clears device rows.
  const gDelParticipant = await request('DELETE', `${apiBase}/sensors/heartrate/data?device_id=dev-1`, { headers: jsonAuth });
  assert.strictEqual(gDelParticipant.status, 403, 'participant password cannot delete');
  const gDel = await request('DELETE', `${apiBase}/sensors/heartrate/data?device_id=dev-1`, { headers: researcherAuth });
  assert.strictEqual(gDel.status, 200, 'generic delete ok');
  const gCount2 = await request('GET', `${apiBase}/sensors/heartrate/count?device_id=dev-1`, { headers: jsonAuth });
  assert.strictEqual(gCount2.json.count, 0, 'empty after delete');
  console.log('✓ generic API delete clears rows');

  // 17. AWARE and generic share storage: data inserted via generic API is
  //     readable through the AWARE latest endpoint (same table).
  await request('POST', `${apiBase}/sensors/steps/data`,
    { body: JSON.stringify({ device_id: 'dev-2', rows: [{ timestamp: 555, count: 1200 }] }), headers: jsonAuth });
  const awareView = await post(`${studyPath}/steps/latest`, form({ device_id: 'dev-2' }), formHeaders);
  assert.strictEqual(awareView.json[0].timestamp, 555, 'shared storage across front-ends');
  console.log('✓ AWARE and generic front-ends share the same storage');

  // 17.5. Picture ESM answers stay stored as raw base64, but the dashboard can
  //       serve them back as image bytes for preview/download.
  const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
  const esmRows = [{
    timestamp: 777,
    device_id: 'dev-1',
    esm_trigger: 'pilot_context_photo',
    esm_json: JSON.stringify({ esm_type: 14, esm_title: 'Context photo' }),
    esm_user_answer: tinyPngBase64,
  }];
  const esmIns = await post(`${studyPath}/esms/insert`,
    form({ device_id: 'dev-1', data: JSON.stringify(esmRows) }), formHeaders);
  assert.strictEqual(esmIns.status, 200, 'picture ESM insert ok');

  for (const path of ['dashboard/summary', 'export/locations?format=json', 'esm-schedule', 'dashboard/esm-responses']) {
    const asParticipant = await request('GET', `${apiBase}/${path}`, { headers: jsonAuth });
    assert.strictEqual(asParticipant.status, 403, `participant password rejected on ${path}`);
    const asParticipantHeader = await request('GET', `${apiBase}/${path}`, { headers: { 'x-study-password': 'secret' } });
    assert.strictEqual(asParticipantHeader.status, 401, `x-study-password is not a researcher credential on ${path}`);
  }
  const scheduleHijack = await request('PUT', `${apiBase}/esm-schedule`, {
    body: JSON.stringify({ mode: 'fixed', times: '03:00' }),
    headers: jsonAuth,
  });
  assert.strictEqual(scheduleHijack.status, 403, 'participant password cannot rewrite the survey schedule');
  console.log('✓ participant password cannot read exports, dashboards, or edit schedules');

  const esmExport = await request('GET', `${apiBase}/export/esms?format=json`, { headers: researcherAuth });
  assert.strictEqual(esmExport.status, 200, 'picture ESM export ok');
  const photoRow = esmExport.json.rows.find((row) => row.data.esm_trigger === 'pilot_context_photo');
  assert.ok(photoRow, 'picture ESM row found');
  assert.strictEqual(photoRow.data.esm_user_answer, tinyPngBase64, 'raw picture base64 preserved');

  const imageRes = await fetch(`${base}${apiBase}/media/esms/${photoRow.id}/image`, {
    headers: { 'x-researcher-password': RESEARCHER_PASSWORD },
  });
  assert.strictEqual(imageRes.status, 200, 'picture ESM image endpoint ok');
  assert.strictEqual(imageRes.headers.get('content-type'), 'image/png', 'picture ESM served as PNG');
  const imageBytes = Buffer.from(await imageRes.arrayBuffer());
  assert.ok(imageBytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'PNG signature');
  console.log('✓ picture ESM answer previews as image/png');

  const pluginEsmRows = [{
    timestamp: 888,
    device_id: 'dev-1',
    esm_trigger: 'pilot_plugin_context_photo',
    esm_json: JSON.stringify({ esm_type: 14, esm_title: 'Plugin ESM photo' }),
    esm_user_answer: tinyPngBase64,
  }];
  const pluginEsmIns = await post(`${studyPath}/plugin_ios_esm/insert`,
    form({ device_id: 'dev-1', data: JSON.stringify(pluginEsmRows) }), formHeaders);
  assert.strictEqual(pluginEsmIns.status, 200, 'plugin_ios_esm picture insert ok');

  const quickSyncRows = [{
    timestamp: 889,
    device_id: 'dev-1',
    esm_trigger: 'quick_sync_photo',
    esm_json: JSON.stringify({ esm_type: 14, esm_title: 'Quick sync photo' }),
    esm_user_answer: tinyPngBase64,
  }];
  const quickSyncIns = await postWithoutContentType(`${studyPath}/plugin_ios_esm/insert`,
    form({ device_id: 'dev-1', data: JSON.stringify(quickSyncRows) }));
  assert.strictEqual(quickSyncIns.status, 200, 'quick sync insert without content-type ok');
  assert.strictEqual(quickSyncIns.json.inserted, 1, 'quick sync inserted row');
  console.log('✓ AWARE quick sync form body works without content-type');

  const esmDashboard = await request('GET', `${apiBase}/dashboard/esm-responses`, { headers: researcherAuth });
  assert.strictEqual(esmDashboard.status, 200, 'dashboard ESM response list ok');
  const pluginPhotoRow = esmDashboard.json.rows.find((row) =>
    row.sensor === 'plugin_ios_esm' &&
    row.data.esm_trigger === 'pilot_plugin_context_photo'
  );
  assert.ok(pluginPhotoRow, 'dashboard finds plugin_ios_esm ESM rows');
  assert.strictEqual(pluginPhotoRow.data.esm_trigger, 'pilot_plugin_context_photo', 'dashboard preserves plugin ESM row data');

  const pluginImageRes = await fetch(`${base}${apiBase}/media/plugin_ios_esm/${pluginPhotoRow.id}/image`, {
    headers: { 'x-researcher-password': RESEARCHER_PASSWORD },
  });
  assert.strictEqual(pluginImageRes.status, 200, 'plugin_ios_esm image endpoint ok');
  assert.strictEqual(pluginImageRes.headers.get('content-type'), 'image/png', 'plugin_ios_esm served as PNG');
  console.log('✓ dashboard discovers plugin_ios_esm photo responses');

  const batteryScreenshotRows = [{
    timestamp: 890,
    device_id: 'dev-1',
    esm_trigger: 'battery_usage_screenshot',
    esm_json: JSON.stringify({
      esm_type: 14,
      esm_title: 'Battery usage screenshot',
      esm_instructions: 'Open Settings → Battery → View All Battery Usage, then upload the screenshot.',
    }),
    esm_user_answer: tinyPngBase64,
    battery_usage_ocr_text: [
      'Battery Usage by App',
      'Instagram',
      '1h 12m On Screen',
      '21%',
      'YouTube',
      '45m On Screen',
      '10%',
    ].join('\n'),
  }];
  const batteryScreenshotIns = await post(`${studyPath}/plugin_ios_esm/insert`,
    form({ device_id: 'dev-1', data: JSON.stringify(batteryScreenshotRows) }), formHeaders);
  assert.strictEqual(batteryScreenshotIns.status, 200, 'battery screenshot ESM insert ok');

  const batteryDiagnostics = await request('GET', `${apiBase}/dashboard/battery-usage`, { headers: researcherAuth });
  assert.strictEqual(batteryDiagnostics.status, 200, 'battery screenshot diagnostics ok');
  assert.ok(batteryDiagnostics.json.screenshotRows.length >= 1, 'battery diagnostics lists source screenshots');
  assert.ok(batteryDiagnostics.json.appRows.some((row) => row.app_name === 'Instagram' && row.screen_time_seconds === 4320 && row.battery_percent === 21), 'battery OCR parser extracts Instagram row');
  assert.ok(batteryDiagnostics.json.appRows.some((row) => row.app_name === 'YouTube' && row.screen_time_seconds === 2700 && row.battery_percent === 10), 'battery OCR parser extracts YouTube row');
  const batteryCsv = await request('GET', `${apiBase}/export/battery_usage_apps?format=csv`, { headers: researcherAuth });
  assert.strictEqual(batteryCsv.status, 200, 'battery usage CSV export ok');
  for (const column of ['app_name', 'ocr_confidence', 'needs_review', 'qa_reason', 'ocr_text', 'parse_notes', 'source_image_url']) {
    assert.ok(batteryCsv.json.split('\r\n')[0].split(',').includes(column), `battery usage CSV header includes ${column}`);
  }
  assert.ok(/Instagram/.test(batteryCsv.json), 'battery usage CSV includes parsed app');

  const participantBatteryUpload = await request('POST', `${apiBase}/battery-screenshots`, {
    body: JSON.stringify({
      device_id: 'dev-1',
      timestamp: 891,
      screenshot_base64: tinyPngBase64,
      battery_usage_ocr_text: [
        'Battery Usage by App',
        'TikTok',
        '32m On Screen',
        '8%',
      ].join('\n'),
    }),
    headers: jsonAuth,
  });
  assert.strictEqual(participantBatteryUpload.status, 201, 'participant battery screenshot upload ok');
  assert.strictEqual(participantBatteryUpload.json.inserted, 1, 'participant battery screenshot stored');
  assert.ok(participantBatteryUpload.json.feedback.app_rows_detected >= 1, 'participant upload feedback reports parsed app rows');
  assert.strictEqual(participantBatteryUpload.json.feedback.needs_review, false, 'participant upload feedback accepts readable screenshot');
  const badParticipantBatteryUpload = await request('POST', `${apiBase}/battery-screenshots`, {
    body: JSON.stringify({ device_id: 'dev-1', screenshot_base64: tinyPngBase64 }),
    headers: { 'Content-Type': 'application/json', 'x-study-password': 'wrong' },
  });
  assert.strictEqual(badParticipantBatteryUpload.status, 403, 'participant battery screenshot rejects wrong password');
  const unreadableParticipantBatteryUpload = await request('POST', `${apiBase}/battery-screenshots`, {
    body: JSON.stringify({
      device_id: 'dev-1',
      timestamp: 891.5,
      screenshot_base64: tinyPngBase64,
      battery_usage_ocr_text: 'not a battery screen',
    }),
    headers: jsonAuth,
  });
  assert.strictEqual(unreadableParticipantBatteryUpload.status, 201, 'unreadable participant battery screenshot upload stored');
  assert.strictEqual(unreadableParticipantBatteryUpload.json.feedback.app_rows_detected, 0, 'unreadable upload feedback reports zero app rows');
  assert.strictEqual(unreadableParticipantBatteryUpload.json.feedback.needs_review, true, 'unreadable upload feedback requests review');
  const participantBatteryDiagnostics = await request('GET', `${apiBase}/dashboard/battery-usage`, { headers: researcherAuth });
  assert.ok(participantBatteryDiagnostics.json.appRows.some((row) => row.app_name === 'TikTok' && row.screen_time_seconds === 1920 && row.battery_percent === 8), 'participant battery upload is parsed for dashboard export');

  const awarePathBatteryUpload = await request('POST', `${studyPath}/battery-screenshots`, {
    body: JSON.stringify({
      device_id: 'dev-1',
      timestamp: 892,
      screenshot_base64: tinyPngBase64,
      battery_usage_ocr_text: [
        'Battery Usage by App',
        'Safari',
        '14m On Screen',
        '4%',
      ].join('\n'),
    }),
    headers: { 'Content-Type': 'application/json' },
  });
  assert.strictEqual(awarePathBatteryUpload.status, 201, 'AWARE-path battery screenshot upload ok');
  const badAwarePathBatteryUpload = await request('POST', '/index.php/webservice/index/demo/wrong/battery-screenshots', {
    body: JSON.stringify({ device_id: 'dev-1', screenshot_base64: tinyPngBase64 }),
    headers: { 'Content-Type': 'application/json' },
  });
  assert.strictEqual(badAwarePathBatteryUpload.status, 403, 'AWARE-path battery screenshot rejects wrong password');
  const awarePathBatteryDiagnostics = await request('GET', `${apiBase}/dashboard/battery-usage`, { headers: researcherAuth });
  assert.ok(awarePathBatteryDiagnostics.json.appRows.some((row) => row.app_name === 'Safari' && row.screen_time_seconds === 840 && row.battery_percent === 4), 'AWARE-path battery upload is parsed for dashboard export');
  console.log('✓ participant battery screenshot upload endpoint works');
  console.log('✓ battery screenshot OCR pipeline exports app usage rows');

  const researcherScheduleSave = await request('PUT', `${apiBase}/battery-screenshot-schedule`, {
    body: JSON.stringify({
      prompt_type: 'battery_usage_screenshot',
      mode: 'fixed',
      times: '08:45, 21:05',
      expiration_minutes: '180',
      notification_title: 'Battery check',
      notification_body: 'Upload your Battery usage screenshot.',
    }),
    headers: researcherAuth,
  });
  assert.strictEqual(researcherScheduleSave.status, 200, 'researcher saves Battery prompt schedule');
  const savedBatterySchedule = researcherScheduleSave.json.esm_schedule[0];
  assert.strictEqual(savedBatterySchedule.studytrace_prompt_type, 'battery_usage_screenshot', 'Battery schedule endpoint returns Battery prompt only');
  assert.deepStrictEqual(savedBatterySchedule.times, ['08:45', '21:05'], 'researcher Battery schedule stores exact times');
  assert.strictEqual(savedBatterySchedule.esms.length, 1, 'default Battery prompt survey question saved');
  const researcherEsmScheduleSave = await request('PUT', `${apiBase}/esm-schedule`, {
    body: JSON.stringify({
      prompt_type: 'esm_survey',
      mode: 'random',
      times: '10:15',
      randomize_minutes: '15',
      notification_title: 'ESM check',
      notification_body: 'Please answer the scheduled ESM survey.',
    }),
    headers: researcherAuth,
  });
  assert.strictEqual(researcherEsmScheduleSave.status, 200, 'researcher saves ESM survey schedule');
  assert.ok(
    researcherEsmScheduleSave.json.esm_schedule.every((item) => item.studytrace_prompt_type === 'esm_survey'),
    'ESM schedule endpoint returns ESM schedules only'
  );
  const savedEsmSchedule = researcherEsmScheduleSave.json.esm_schedule[0];
  assert.deepStrictEqual(savedEsmSchedule.times, ['10:15'], 'researcher ESM schedule stores exact times');
  const researcherScheduleGet = await request('GET', `${apiBase}/esm-schedule`, { headers: researcherAuth });
  assert.strictEqual(researcherScheduleGet.status, 200, 'researcher gets ESM schedule');
  assert.ok(
    researcherScheduleGet.json.schedule_summary.every((item) => item.prompt_type === 'esm_survey') &&
      researcherScheduleGet.json.schedule_summary.some((item) => item.times.join(',') === '10:15'),
    'schedule summary exposes ESM prompt times'
  );
  const researcherBatteryScheduleGet = await request('GET', `${apiBase}/battery-screenshot-schedule`, { headers: researcherAuth });
  assert.strictEqual(researcherBatteryScheduleGet.status, 200, 'researcher gets Battery prompt schedule');
  assert.ok(
    researcherBatteryScheduleGet.json.schedule_summary.every((item) => item.prompt_type === 'battery_usage_screenshot') &&
      researcherBatteryScheduleGet.json.schedule_summary.some((item) => item.times.join(',') === '08:45,21:05'),
    'Battery endpoint exposes Battery prompt times'
  );
  const combinedRemoteEsmConfig = await request('GET', `${studyPath}/esm/config`);
  assert.strictEqual(combinedRemoteEsmConfig.status, 200, 'combined remote ESM config ok');
  assert.ok(combinedRemoteEsmConfig.json.some((item) => item.studytrace_prompt_type === 'esm_survey'), 'remote config includes ESM survey schedule');
  assert.ok(combinedRemoteEsmConfig.json.some((item) => item.studytrace_prompt_type === 'battery_usage_screenshot'), 'remote config includes independent Battery screenshot schedule');
  console.log('✓ researcher saves separate ESM and Battery screenshot schedules');

  const dashboardBeforeLegacyRows = await request('GET', `${apiBase}/dashboard/summary`, { headers: researcherAuth });
  assert.strictEqual(dashboardBeforeLegacyRows.status, 200, 'dashboard summary before legacy rows ok');
  assert.ok(
    dashboardBeforeLegacyRows.json.sensors.some((row) => row.sensor === 'battery_usage_apps'),
    'researcher dashboard lists Battery screenshot export'
  );
  assert.ok(
    !dashboardBeforeLegacyRows.json.sensors.some((row) => row.sensor === 'screentime_apps'),
    'researcher dashboard does not list retired app-usage export'
  );
  const removedScreenTimeCsv = await request('GET', `${apiBase}/export/screentime_apps?format=csv`, { headers: researcherAuth });
  assert.strictEqual(removedScreenTimeCsv.status, 404, 'retired app-usage CSV export removed');
  assert.match(removedScreenTimeCsv.json.error, /battery_usage_apps/, 'removed app-usage export points to Battery workflow');
  const legacyScreenTimeTable = db.safeTableName('screentime_apps');
  await db.createSensorTable(legacyScreenTimeTable);
  await db.insertRows(legacyScreenTimeTable, 'demo', 'dev-1', [
    {
      timestamp: 888,
      app_name: 'Legacy App',
      duration_seconds: 60,
    },
  ]);
  const dashboardWithLegacyRows = await request('GET', `${apiBase}/dashboard/summary`, { headers: researcherAuth });
  assert.strictEqual(dashboardWithLegacyRows.status, 200, 'dashboard summary with legacy rows ok');
  assert.ok(
    !dashboardWithLegacyRows.json.sensors.some((row) => row.sensor === 'screentime_apps'),
    'researcher dashboard hides existing retired app-usage tables'
  );
  console.log('✓ researcher Sensor coverage keeps Battery screenshot export only');

  // ---- Admin data export ----------------------------------------------------
  const adminHdr = { 'x-admin-token': 'test-admin-token' };

  // 18. export requires admin token.
  const expNoAuth = await request('GET', `/admin/export/steps`);
  assert.strictEqual(expNoAuth.status, 403, 'export requires admin token');
  console.log('✓ export rejects without admin token');

  // 19. list sensors includes tables we wrote to.
  const sensorsList = await request('GET', `/admin/sensors`, { headers: adminHdr });
  assert.strictEqual(sensorsList.status, 200, 'list sensors ok');
  const names = sensorsList.json.sensors.map((s) => s.sensor);
  assert.ok(names.includes('steps'), 'steps listed');
  assert.ok(names.includes('battery_usage_apps'), 'Battery screenshot app usage export listed');
  assert.ok(!names.includes('screentime_apps'), 'retired consolidated app-usage export removed');
  assert.ok(!names.includes('screentime_raw_log'), 'retired raw app-usage export removed');
  assert.ok(!names.includes('screentime_app_usage'), 'retired app-usage export removed');
  console.log('✓ admin lists sensors:', names.join(', '));

  // 20.5. studies list shows the provisioned study and device counts.
  const studiesList = await request('GET', `/admin/studies`, { headers: adminHdr });
  assert.strictEqual(studiesList.status, 200, 'list studies ok');
  assert.ok(studiesList.json.studies.some((study) => study.study_id === 'demo'), 'study appears in admin list');
  console.log('✓ admin lists studies');

  // 20.6. researcher dashboard summary is study-scoped and authenticated.
  const dashboard = await request('GET', `/api/v1/studies/demo/dashboard/summary`, { headers: researcherAuth });
  assert.strictEqual(dashboard.status, 200, 'researcher dashboard ok');
  assert.strictEqual(dashboard.json.study.study_id, 'demo', 'dashboard study id');
  assert.ok(Array.isArray(dashboard.json.devices), 'dashboard devices array');
  assert.ok(
    dashboard.json.sensors.some((row) => row.sensor === 'battery_usage_apps'),
    'researcher dashboard lists Battery screenshot app usage export'
  );
  assert.ok(
    !dashboard.json.sensors.some((row) => row.sensor === 'screentime_apps'),
    'researcher dashboard omits retired app-usage export'
  );
  console.log('✓ researcher dashboard summary');

  const nowMs = Date.now();
  await request('POST', `${apiBase}/sensors/client_events/data`, {
    body: JSON.stringify({
      device_id: 'dev-1',
      rows: [
        { timestamp: nowMs, event_name: 'notification_tapped' },
        { timestamp: nowMs + 1, event_name: 'battery_screenshot_upload_failed' },
      ],
    }),
    headers: jsonAuth,
  });
  await request('POST', `${apiBase}/sensors/device_state/data`, {
    body: JSON.stringify({
      device_id: 'dev-1',
      rows: [{
        timestamp: nowMs,
        notification_authorization: 'authorized',
        location_authorization: 'authorized_always',
        battery_level: 0.77,
        low_power_mode_enabled: false,
      }],
    }),
    headers: jsonAuth,
  });
  await request('POST', `${apiBase}/sensors/locations/data`, {
    body: JSON.stringify({
      device_id: 'dev-1',
      rows: [
        { timestamp: nowMs, double_latitude: 35.6, double_longitude: 139.7, double_accuracy: 20 },
        { timestamp: nowMs + 30 * 60 * 1000, double_latitude: 35.61, double_longitude: 139.71, double_accuracy: 25 },
      ],
    }),
    headers: jsonAuth,
  });

  const participantHealth = await request('GET', `${apiBase}/dashboard/participant-health`, { headers: researcherAuth });
  assert.strictEqual(participantHealth.status, 200, 'participant health dashboard ok');
  assert.ok(participantHealth.json.rows.some((row) => row.device_id === 'dev-1' && row.notification_authorization === 'authorized'), 'participant health includes device state');
  const locationSummary = await request('GET', `${apiBase}/dashboard/location-daily-summary`, { headers: researcherAuth });
  assert.strictEqual(locationSummary.status, 200, 'location daily summary dashboard ok');
  assert.ok(locationSummary.json.rows.some((row) => row.device_id === 'dev-1' && row.location_rows >= 2), 'location summary includes daily mobility rows');
  const surveyQuality = await request('GET', `${apiBase}/dashboard/survey-quality`, { headers: researcherAuth });
  assert.strictEqual(surveyQuality.status, 200, 'survey quality dashboard ok');
  assert.ok(surveyQuality.json.rows.some((row) => row.question_trigger === 'battery_usage_screenshot'), 'survey quality includes Battery screenshot response metadata');
  const healthCsv = await request('GET', `${apiBase}/export/participant_health?format=csv`, { headers: researcherAuth });
  assert.strictEqual(healthCsv.status, 200, 'participant health CSV export ok');
  assert.ok(healthCsv.json.split('\r\n')[0].split(',').includes('health_status'), 'participant health CSV includes health_status');
  console.log('✓ researcher derived quality dashboards');

  // 21. JSON export returns the stored rows.
  const expJson = await request('GET', `/admin/export/steps?format=json`, { headers: adminHdr });
  assert.strictEqual(expJson.status, 200, 'json export ok');
  assert.ok(expJson.json.rows.length >= 1, 'json export has rows');
  assert.strictEqual(expJson.json.rows[0].data.count, 1200, 'json export row payload');
  assert.strictEqual(expJson.json.rows[0].study_id, 'demo', 'json export row scoped to study');
  console.log('✓ admin JSON export rows:', expJson.json.count);

  // 22. CSV export flattens data keys into columns.
  const expCsv = await request('GET', `/admin/export/steps?format=csv`, { headers: adminHdr });
  assert.strictEqual(expCsv.status, 200, 'csv export ok');
  assert.ok(/^id,study_id,device_id,timestamp,.*created_at/m.test(expCsv.json), 'csv header present');
  assert.ok(/\b1200\b/.test(expCsv.json), 'csv contains the value');
  console.log('✓ admin CSV export header + values present');

  // 23. Newest rows are processed even when a study has many older ESM rows.
  const fillerRows = Array.from({ length: 260 }, (_, index) => ({
    timestamp: 1000 + index,
    esm_trigger: 'filler_question',
    esm_json: JSON.stringify({ esm_type: 1, esm_title: 'Filler' }),
    esm_user_answer: `answer ${index}`,
  }));
  await db.insertRows(db.safeTableName('plugin_ios_esm'), 'demo', 'dev-1', fillerRows);
  const lateUpload = await request('POST', `${apiBase}/battery-screenshots`, {
    body: JSON.stringify({
      device_id: 'dev-1',
      timestamp: 5000,
      screenshot_base64: tinyPngBase64,
      battery_usage_ocr_text: ['Battery Usage by App', 'Maps', '9m On Screen', '3%'].join('\n'),
    }),
    headers: jsonAuth,
  });
  assert.strictEqual(lateUpload.status, 201, 'late battery screenshot upload ok');
  assert.ok(lateUpload.json.feedback.app_rows_detected >= 1, 'newest screenshot is OCR-processed despite >200 older ESM rows');
  const latestEsm = await request('GET', `${apiBase}/dashboard/esm-responses?limit=5`, { headers: researcherAuth });
  assert.ok(latestEsm.json.rows.some((row) => Number(row.timestamp) === 5000), 'dashboard ESM list shows newest responses');
  console.log('✓ dashboards and OCR read newest rows first');

  // 24. Updating a study only changes the fields provided.
  const rotateResearcher = await post('/admin/studies',
    JSON.stringify({ study_id: 'demo', researcher_password: 'another-researcher-pw' }), adminJson);
  assert.strictEqual(rotateResearcher.status, 200, 'researcher password update ok');
  assert.strictEqual(rotateResearcher.json.study_url, undefined, 'no study url when participant password unchanged');
  const stillJoins = await post(studyPath, form({ device_id: 'dev-1' }), formHeaders);
  assert.strictEqual(stillJoins.status, 200, 'participant password untouched by researcher update');
  const oldResearcher = await request('GET', `${apiBase}/dashboard/summary`, { headers: researcherAuth });
  assert.strictEqual(oldResearcher.status, 403, 'old researcher password revoked');
  researcherAuth['x-researcher-password'] = 'another-researcher-pw';
  const rotateAgain = await post('/admin/studies',
    JSON.stringify({ study_id: 'demo', researcher_password: 'secret-but-long-enough' }), adminJson);
  assert.strictEqual(rotateAgain.status, 200, 'distinct researcher password accepted');
  researcherAuth['x-researcher-password'] = 'secret-but-long-enough';
  const reuse = await post('/admin/studies',
    JSON.stringify({ study_id: 'demo', password: 'secret-but-long-enough' }), adminJson);
  assert.strictEqual(reuse.status, 400, 'participant password may not equal researcher password');
  console.log('✓ admin study update changes only the provided credentials');

  // 25. Legacy plaintext studies are hashed at boot and locked until a
  //     researcher password is set.
  await pool.query(`INSERT INTO studies (study_id, password, name) VALUES ('legacy', 'legacy-pw', 'Legacy')`);
  await db.migratePlaintextStudyPasswords();
  const legacy = await db.getStudy('legacy');
  assert.ok(legacy.password_hash.startsWith('scrypt$'), 'legacy password migrated to hash');
  const legacyJoin = await post('/index.php/webservice/index/legacy/legacy-pw', form({ device_id: 'legacy-dev' }), formHeaders);
  assert.strictEqual(legacyJoin.status, 200, 'legacy participants keep working after migration');
  const legacyDashboard = await request('GET', '/api/v1/studies/legacy/dashboard/summary', {
    headers: { 'x-researcher-password': 'legacy-pw' },
  });
  assert.strictEqual(legacyDashboard.status, 403, 'legacy researcher dashboard locked');
  assert.strictEqual(legacyDashboard.json.error, 'researcher_password_not_set', 'lock reason reported');
  console.log('✓ legacy plaintext passwords migrated; dashboard locked until researcher password set');

  // 26. Participant withdrawal: log-only, then with deletion.
  await request('POST', `${apiBase}/sensors/locations/data`, {
    body: JSON.stringify({ device_id: 'dev-withdraw', rows: [{ timestamp: 1, double_latitude: 1, double_longitude: 1 }] }),
    headers: jsonAuth,
  });
  await post(`${studyPath}?participant=P-W`, form({ device_id: 'dev-withdraw' }), formHeaders);
  const keepWithdrawal = await request('POST', `${apiBase}/withdrawal`, {
    body: JSON.stringify({ device_id: 'dev-withdraw', delete_data: false }),
    headers: jsonAuth,
  });
  assert.strictEqual(keepWithdrawal.status, 200, 'withdrawal without deletion ok');
  assert.strictEqual(keepWithdrawal.json.rows_deleted, 0, 'no rows deleted when not requested');
  const deleteWithdrawal = await request('POST', `${apiBase}/withdrawal`, {
    body: JSON.stringify({ device_id: 'dev-withdraw', delete_data: true }),
    headers: jsonAuth,
  });
  assert.strictEqual(deleteWithdrawal.status, 200, 'withdrawal with deletion ok');
  assert.ok(deleteWithdrawal.json.rows_deleted >= 1, 'withdrawn device rows deleted');
  const withdrawnCount = await request('GET', `${apiBase}/sensors/locations/count?device_id=dev-withdraw`, { headers: jsonAuth });
  assert.strictEqual(withdrawnCount.json.count, 0, 'no rows remain for withdrawn device');

  // A queued withdrawal retried after the participant re-joined only deletes
  // rows received before the original withdrawal time.
  const earlyWithdrawalAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await request('POST', `${apiBase}/sensors/locations/data`, {
    body: JSON.stringify({ device_id: 'dev-rejoin', rows: [{ timestamp: 2, double_latitude: 2, double_longitude: 2 }] }),
    headers: jsonAuth,
  });
  const lateRetry = await request('POST', `${apiBase}/withdrawal`, {
    body: JSON.stringify({ device_id: 'dev-rejoin', delete_data: true, withdrawn_at: earlyWithdrawalAt }),
    headers: jsonAuth,
  });
  assert.strictEqual(lateRetry.status, 200, 'late withdrawal retry ok');
  assert.strictEqual(lateRetry.json.rows_deleted, 0, 'rows uploaded after withdrawn_at are kept');
  const rejoinCount = await request('GET', `${apiBase}/sensors/locations/count?device_id=dev-rejoin`, { headers: jsonAuth });
  assert.strictEqual(rejoinCount.json.count, 1, 're-joined participant data survives a stale retry');
  const summaryAfterWithdrawal = await request('GET', `${apiBase}/dashboard/summary`, { headers: researcherAuth });
  assert.ok(!summaryAfterWithdrawal.json.devices.some((row) => row.device_id === 'dev-withdraw'), 'withdrawn device unregistered');
  assert.strictEqual(summaryAfterWithdrawal.json.withdrawals.filter((row) => row.device_id === 'dev-withdraw').length, 2, 'both withdrawals logged');
  assert.ok(summaryAfterWithdrawal.json.withdrawals.some((row) => row.participant === 'P-W'), 'withdrawal log keeps participant label');
  console.log('✓ participant withdrawal logs and optionally deletes uploaded data');

  // 27. Researcher deletes a participant across every table.
  const researcherDeleteAsParticipant = await request('DELETE', `${apiBase}/participants/dev-2`, { headers: jsonAuth });
  assert.strictEqual(researcherDeleteAsParticipant.status, 403, 'participant password cannot delete a participant');
  const researcherDelete = await request('DELETE', `${apiBase}/participants/dev-1`, { headers: researcherAuth });
  assert.strictEqual(researcherDelete.status, 200, 'researcher deletes participant');
  assert.ok(researcherDelete.json.rows_deleted > 0, 'researcher delete removed rows');
  for (const sensor of ['locations', 'plugin_ios_esm', 'esms', 'battery_usage_apps', 'client_events']) {
    const count = await request('GET', `${apiBase}/sensors/${sensor}/count?device_id=dev-1`, { headers: jsonAuth });
    assert.strictEqual(count.json.count, 0, `no ${sensor} rows remain for deleted participant`);
  }
  const otherDevice = await request('GET', `${apiBase}/sensors/steps/count?device_id=dev-2`, { headers: jsonAuth });
  assert.strictEqual(otherDevice.json.count, 1, 'other participants untouched');
  console.log('✓ researcher deletes a participant across all sensor tables');

  // 29. Deduplication: retried uploads never create duplicate rows.
  const dupRows = [{ timestamp: 111, double_latitude: 1, double_longitude: 1 }];
  const firstSend = await post(`${studyPath}/locations/insert`, form({ device_id: 'dev-dup', data: JSON.stringify(dupRows) }), formHeaders);
  assert.strictEqual(firstSend.json.inserted, 1, 'first AWARE batch stored');
  const resend = await post(`${studyPath}/locations/insert`, form({ device_id: 'dev-dup', data: JSON.stringify(dupRows) }), formHeaders);
  assert.strictEqual(resend.json.inserted, 0, 'identical AWARE re-send skipped');
  assert.strictEqual(resend.json.duplicates, 1, 'duplicate reported');
  const eventBody = JSON.stringify({ device_id: 'dev-dup', rows: [{ timestamp: 5, event_id: 'evt-1', event_name: 'app_launch' }] });
  await request('POST', `${apiBase}/sensors/client_events/data`, { body: eventBody, headers: jsonAuth });
  const eventRetry = await request('POST', `${apiBase}/sensors/client_events/data`, { body: eventBody, headers: jsonAuth });
  assert.strictEqual(eventRetry.json.inserted, 0, 'event_id retry skipped');
  const withinBatch = await request('POST', `${apiBase}/sensors/client_events/data`, {
    body: JSON.stringify({ device_id: 'dev-dup', rows: [
      { timestamp: 6, event_id: 'evt-2' }, { timestamp: 6, event_id: 'evt-2' }, { timestamp: 7, event_id: 'evt-3' },
    ] }),
    headers: jsonAuth,
  });
  assert.strictEqual(withinBatch.json.inserted, 2, 'duplicates within one batch collapse');
  const bigBatch = Array.from({ length: 2500 }, (_, index) => ({ timestamp: 10000 + index, value: index }));
  const bigInsert = await request('POST', `${apiBase}/sensors/big_sensor/data`, {
    body: JSON.stringify({ device_id: 'dev-dup', rows: bigBatch }),
    headers: jsonAuth,
  });
  assert.strictEqual(bigInsert.json.inserted, 2500, 'large batch inserted in chunks');
  const screenshotBody = JSON.stringify({
    device_id: 'dev-dup',
    timestamp: 7777,
    upload_id: 'sha256-of-image-abc',
    screenshot_base64: tinyPngBase64,
    battery_usage_ocr_text: ['Battery Usage by App', 'Notes', '5m On Screen', '1%'].join('\n'),
  });
  const shotFirst = await request('POST', `${apiBase}/battery-screenshots`, { body: screenshotBody, headers: jsonAuth });
  assert.strictEqual(shotFirst.status, 201, 'first screenshot upload stored');
  const shotRetry = await request('POST', `${apiBase}/battery-screenshots`, { body: screenshotBody, headers: jsonAuth });
  assert.strictEqual(shotRetry.status, 200, 'screenshot retry acknowledged');
  assert.strictEqual(shotRetry.json.duplicate, true, 'screenshot retry flagged as duplicate');
  assert.ok(shotRetry.json.feedback.app_rows_detected >= 1, 'retry still returns OCR feedback');
  const dupShotRows = await request('GET', `${apiBase}/sensors/plugin_ios_esm/count?device_id=dev-dup`, { headers: jsonAuth });
  assert.strictEqual(dupShotRows.json.count, 1, 'one screenshot row stored');
  await request('GET', `${apiBase}/dashboard/battery-usage`, { headers: researcherAuth });
  const dupAppRows = await request('GET', `${apiBase}/sensors/battery_usage_apps/count?device_id=dev-dup`, { headers: jsonAuth });
  assert.strictEqual(dupAppRows.json.count, 1, 'OCR rows not duplicated by repeated processing');
  console.log('✓ retries and re-sends are deduplicated (AWARE, generic, screenshots, OCR)');

  // 30. Location days follow the participant's local time zone.
  const badZone = await post('/admin/studies', JSON.stringify({ study_id: 'demo', timezone: 'Mars/Olympus' }), adminJson);
  assert.strictEqual(badZone.status, 400, 'invalid study time zone rejected');
  const setZone = await post('/admin/studies', JSON.stringify({ study_id: 'demo', timezone: 'Asia/Tokyo' }), adminJson);
  assert.strictEqual(setZone.json.timezone, 'Asia/Tokyo', 'study default time zone saved');
  await request('POST', `${apiBase}/sensors/device_state/data`, {
    body: JSON.stringify({ device_id: 'dev-tz', rows: [{ timestamp: Date.UTC(2026, 0, 15, 12), timezone: 'America/New_York' }] }),
    headers: jsonAuth,
  });
  await request('POST', `${apiBase}/sensors/locations/data`, {
    body: JSON.stringify({ device_id: 'dev-tz', rows: [
      { timestamp: Date.UTC(2026, 0, 15, 14), double_latitude: 40.7, double_longitude: -74.0 },
      { timestamp: Date.UTC(2026, 0, 16, 2, 30), double_latitude: 40.71, double_longitude: -74.01 },
    ] }),
    headers: jsonAuth,
  });
  await request('POST', `${apiBase}/sensors/locations/data`, {
    body: JSON.stringify({ device_id: 'dev-notz', rows: [
      { timestamp: Date.UTC(2026, 0, 15, 20), double_latitude: 35.6, double_longitude: 139.7 },
    ] }),
    headers: jsonAuth,
  });
  const zoned = await request('GET', `${apiBase}/dashboard/location-daily-summary?limit=1000`, { headers: researcherAuth });
  const nyDays = zoned.json.rows.filter((row) => row.device_id === 'dev-tz');
  assert.strictEqual(nyDays.length, 1, '21:30 New York time stays on the same local day');
  assert.strictEqual(nyDays[0].date, '2026-01-15', 'New York local date used');
  assert.strictEqual(nyDays[0].timezone, 'America/New_York', 'summary reports the zone used');
  assert.strictEqual(nyDays[0].location_rows, 2, 'both fixes grouped into one local day');
  const tokyoDay = zoned.json.rows.find((row) => row.device_id === 'dev-notz');
  assert.strictEqual(tokyoDay.date, '2026-01-16', 'study default zone used when the device has not reported one');
  console.log('✓ location summaries use the participant local day');

  // 31. Participant health: heartbeat, gaps, compliance, telemetry loss.
  const t0 = Date.now();
  const promptMeta = (id, deliveredAt) => ({ notification_id: id, delivered_at: deliveredAt, is_survey_prompt: true });
  await request('POST', `${apiBase}/sensors/client_events/data`, {
    body: JSON.stringify({ device_id: 'dev-health', rows: [
      { timestamp: t0 - 5 * 3600000, seq: 1, event_id: 'h1', event_name: 'app_launch', metadata: { launch_reason: 'location' } },
      { timestamp: t0 - 3 * 3600000, seq: 2, event_id: 'h2', event_name: 'notification_delivered', metadata: promptMeta('n1', t0 - 3 * 3600000) },
      { timestamp: t0 - 3 * 3600000 + 30000, seq: 3, event_id: 'h3', event_name: 'notification_tapped', metadata: promptMeta('n1', t0 - 3 * 3600000) },
      { timestamp: t0 - 2 * 3600000, seq: 5, event_id: 'h5', event_name: 'notification_delivered', metadata: promptMeta('n2', t0 - 2 * 3600000) },
      { timestamp: t0 - 2 * 3600000, seq: 6, event_id: 'h6', event_name: 'notification_delivered', metadata: { notification_id: 'other', is_survey_prompt: false } },
      { timestamp: t0 - 90 * 60000, seq: 7, event_id: 'h7', event_name: 'permission_changed', metadata: { permission: 'location_authorization', from: 'authorized_always', to: 'authorized_when_in_use' } },
      { timestamp: t0 - 60 * 60000, seq: 8, event_id: 'h8', event_name: 'heartbeat' },
    ] }),
    headers: jsonAuth,
  });
  const answered = (offset, trigger) => ({
    timestamp: t0 - 3 * 3600000,
    esm_trigger: trigger,
    esm_json: JSON.stringify({ esm_type: 1, esm_title: trigger }),
    esm_user_answer: 'fine',
    double_esm_user_answer_timestamp: t0 - 3 * 3600000 + offset,
  });
  await post(`${studyPath}/esms/insert`, form({
    device_id: 'dev-health',
    data: JSON.stringify([answered(60000, 'mood'), answered(120000, 'stress')]),
  }), formHeaders);
  const health = await request('GET', `${apiBase}/dashboard/participant-health`, { headers: researcherAuth });
  const hRow = health.json.rows.find((row) => row.device_id === 'dev-health');
  assert.ok(hRow, 'health row for telemetry device');
  assert.strictEqual(hRow.prompts_delivered_7d, 2, 'distinct survey prompts counted once each');
  assert.strictEqual(hRow.survey_sessions_7d, 1, 'answers within 15 min form one session');
  assert.strictEqual(hRow.compliance_rate_7d, 0.5, 'compliance = sessions / prompts');
  assert.strictEqual(hRow.telemetry_missing_7d, 1, 'sequence gap detected as a lost row');
  assert.strictEqual(hRow.permission_changes_7d, 1, 'permission change counted');
  assert.strictEqual(hRow.last_launch_reason, 'location', 'launch reason reported');
  assert.ok(hRow.last_heartbeat, 'last heartbeat reported');
  assert.ok(hRow.max_telemetry_gap_hours_24h >= 18 && hRow.max_telemetry_gap_hours_24h <= 20, 'longest 24h gap measured');
  assert.match(hRow.notes, /telemetry row\(s\) missing/, 'loss surfaced in notes');
  const quality = await request('GET', `${apiBase}/dashboard/survey-quality?limit=1000`, { headers: researcherAuth });
  const qRow = quality.json.rows.find((row) => row.device_id === 'dev-health');
  assert.ok(qRow.local_date && qRow.timezone, 'survey quality rows include local date and zone');
  console.log('✓ participant health reports heartbeat, gaps, compliance, and telemetry loss');

  // 32. Participant-confirmed Battery rows are stored as-is (no server OCR).
  const confirmedBattery = await request('POST', `${apiBase}/usage-screenshots`, {
    body: JSON.stringify({
      device_id: 'dev-shots',
      timestamp: 9100,
      upload_id: 'battery-confirmed-1',
      screenshot_kind: 'battery',
      screenshot_base64: tinyPngBase64,
      usage_window: 'last_24_hours',
      captured_at: Date.UTC(2026, 8, 29, 21, 5),
      device_ocr_text: 'BATTERY USAGE BY APP\nInstagram\n1h 12m\n21%',
      participant_edited: true,
      confirmed_rows: [
        { app_name: 'Instagram', screen_time_seconds: 4320, battery_percent: 21 },
        { app_name: 'Messages', screen_time_seconds: 600, battery_percent: 999 },
        { app_name: '   ', screen_time_seconds: 60 },
      ],
    }),
    headers: jsonAuth,
  });
  assert.strictEqual(confirmedBattery.status, 201, 'confirmed Battery upload stored');
  assert.strictEqual(confirmedBattery.json.feedback.needs_review, false, 'confirmed rows need no review');
  assert.strictEqual(confirmedBattery.json.feedback.app_rows_detected, 2, 'blank app names dropped');
  const confirmedExport = await request('GET', `${apiBase}/export/battery_usage_apps?format=json&device_id=dev-shots`, { headers: researcherAuth });
  const insta = confirmedExport.json.rows.find((row) => row.data.app_name === 'Instagram');
  assert.strictEqual(insta.data.extraction_method, 'participant_confirmed', 'confirmed rows marked as such');
  assert.strictEqual(insta.data.usage_window, 'last_24_hours', 'usage window stored');
  assert.strictEqual(insta.data.participant_edited, true, 'edit flag stored');
  assert.ok(insta.data.captured_at.startsWith('2026-09-29'), 'capture time stored');
  const messages = confirmedExport.json.rows.find((row) => row.data.app_name === 'Messages');
  assert.strictEqual(messages.data.battery_percent, null, 'out-of-range percent rejected');
  console.log('✓ participant-confirmed Battery rows are stored without server OCR');

  // 33. Japanese Battery screenshots parse on the server fallback path.
  const jaBattery = await request('POST', `${apiBase}/battery-screenshots`, {
    body: JSON.stringify({
      device_id: 'dev-ja',
      timestamp: 9200,
      screenshot_base64: tinyPngBase64,
      battery_usage_ocr_text: ['アプリごとのバッテリー使用状況', '写真', '1時間5分', '12％', 'LINE', '45分', '8%', 'Maps', '1 hour 5 min', '2%'].join('\n'),
    }),
    headers: jsonAuth,
  });
  assert.strictEqual(jaBattery.status, 201, 'Japanese Battery upload stored');
  const jaExport = await request('GET', `${apiBase}/export/battery_usage_apps?format=json&device_id=dev-ja`, { headers: researcherAuth });
  const photos = jaExport.json.rows.find((row) => row.data.app_name === '写真');
  assert.ok(photos, 'Japanese app name kept');
  assert.strictEqual(photos.data.screen_time_seconds, 3900, 'Japanese hours+minutes parsed');
  assert.strictEqual(photos.data.battery_percent, 12, 'full-width percent parsed');
  assert.strictEqual(jaExport.json.rows.find((row) => row.data.app_name === 'Maps').data.screen_time_seconds, 3900, 'spelled-out hour and minutes parsed');
  assert.ok(!jaExport.json.rows.some((row) => row.data.app_name === 'アプリごとのバッテリー使用状況'), 'Japanese heading not parsed as an app');
  console.log('✓ Japanese Battery screenshots parse');

  // 34. Screen Time "See All Activity" screenshots: schedule, confirmed, OCR.
  const activitySave = await request('PUT', `${apiBase}/screen-time-activity-schedule`, {
    body: JSON.stringify({ mode: 'fixed', times: '10:00' }),
    headers: researcherAuth,
  });
  assert.strictEqual(activitySave.status, 200, 'activity schedule saved');
  assert.strictEqual(activitySave.json.esm_schedule[0].studytrace_prompt_type, 'screen_time_activity_screenshot', 'activity prompt type');
  const activityQuestion = activitySave.json.esm_schedule[0].esms[0];
  assert.strictEqual((activityQuestion.esm || activityQuestion).esm_trigger, 'screen_time_activity_screenshot', 'default activity question');
  const participantConfig = await request('GET', `${studyPath}/esm/config`);
  assert.ok(participantConfig.json.some((item) => item.studytrace_prompt_type === 'screen_time_activity_screenshot'), 'phones receive the activity schedule');
  const esmOnly = await request('GET', `${apiBase}/esm-schedule`, { headers: researcherAuth });
  assert.ok(esmOnly.json.esm_schedule.every((item) => item.studytrace_prompt_type === 'esm_survey'), 'ESM schedule excludes screenshot prompts');

  const confirmedActivity = await request('POST', `${apiBase}/usage-screenshots`, {
    body: JSON.stringify({
      device_id: 'dev-shots',
      timestamp: 9300,
      screenshot_kind: 'screen_time_activity',
      screenshot_base64: tinyPngBase64,
      activity_date: '2026-09-28',
      confirmed_rows: [{ app_name: 'Safari', screen_time_seconds: 1800 }],
      summary: { total_screen_time_seconds: 16320, pickups: 87, notifications: 142 },
    }),
    headers: jsonAuth,
  });
  assert.strictEqual(confirmedActivity.status, 201, 'activity screenshot stored');
  assert.strictEqual(confirmedActivity.json.feedback.needs_review, false, 'confirmed activity needs no review');
  const ocrActivity = await request('POST', `${apiBase}/usage-screenshots`, {
    body: JSON.stringify({
      device_id: 'dev-shots',
      timestamp: 9400,
      screenshot_kind: 'screen_time_activity',
      screenshot_base64: tinyPngBase64,
      battery_usage_ocr_text: [
        '9:41', 'Screen Time', 'Yesterday', '4h 32m', 'MOST USED', 'Instagram', '1h 10m', 'YouTube', '48m',
        'PICKUPS', 'Total Pickups', '87', 'NOTIFICATIONS', 'Total Notifications', '142',
      ].join('\n'),
    }),
    headers: jsonAuth,
  });
  assert.strictEqual(ocrActivity.status, 201, 'OCR activity screenshot stored');
  const activityRows = await request('GET', `${apiBase}/dashboard/screen-time-activity`, { headers: researcherAuth });
  const summaries = activityRows.json.rows.filter((row) => row.row_type === 'summary' && row.device_id === 'dev-shots');
  const confirmedSummary = summaries.find((row) => row.activity_date === '2026-09-28');
  assert.strictEqual(confirmedSummary.pickups, 87, 'confirmed pickups stored');
  assert.strictEqual(confirmedSummary.extraction_method, 'participant_confirmed', 'confirmed activity marked');
  const ocrSummary = summaries.find((row) => row.extraction_method === 'provided_text');
  assert.strictEqual(ocrSummary.total_screen_time_seconds, 16320, 'OCR total screen time parsed (clock ignored)');
  assert.strictEqual(ocrSummary.pickups, 87, 'OCR pickups parsed');
  assert.strictEqual(ocrSummary.notifications, 142, 'OCR notifications parsed');
  assert.ok(activityRows.json.rows.some((row) => row.row_type === 'app' && row.app_name === 'YouTube' && row.screen_time_seconds === 2880), 'OCR most-used apps parsed');
  const batteryAfterActivity = await request('GET', `${apiBase}/export/battery_usage_apps?format=json&device_id=dev-shots`, { headers: researcherAuth });
  assert.ok(!batteryAfterActivity.json.rows.some((row) => row.data.app_name === 'YouTube'), 'activity screenshots are not parsed as Battery screenshots');
  const activityCsv = await request('GET', `${apiBase}/export/screen_time_activity?format=csv`, { headers: researcherAuth });
  assert.ok(activityCsv.json.split('\r\n')[0].includes('pickups'), 'screen_time_activity CSV export');
  console.log('✓ Screen Time activity screenshots: schedule, confirmed values, and OCR parsing');

  // 28. Repeated failed logins are throttled (run last: it blocks this IP).
  let limited = null;
  for (let attempt = 0; attempt < 40 && !limited; attempt += 1) {
    const res = await request('GET', `${apiBase}/dashboard/summary`, { headers: { 'x-researcher-password': `guess-${attempt}` } });
    if (res.status === 429) limited = res;
  }
  assert.ok(limited, 'failed researcher logins are rate limited');
  console.log('✓ failed credential attempts are rate limited');

  console.log('\nALL SMOKE TESTS PASSED');
  server.close();
  process.exit(0);
} catch (err) {
  console.error('\nSMOKE TEST FAILED:', err.message);
  server.close();
  process.exit(1);
}
