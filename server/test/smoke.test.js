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

try {
  // 1. Provision a study via admin.
  const admin = await post('/admin/studies',
    JSON.stringify({ study_id: 'demo', password: 'secret', name: 'Demo' }),
    { 'Content-Type': 'application/json', 'x-admin-token': 'test-admin-token' });
  assert.strictEqual(admin.status, 200, 'admin create study');
  assert.ok(admin.json.study_url.includes('/index.php/webservice/index/demo/secret'), 'study url shape');
  console.log('✓ admin provision study:', admin.json.study_url);

  const studyPath = '/index.php/webservice/index/demo/secret';

  const scheduleBody = {
    mode: 'random',
    hours: '9, 17',
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
  assert.strictEqual(remoteEsmConfig.json[0].schedule_id, 'studytrace_random_survey', 'remote ESM schedule id');
  assert.strictEqual(remoteEsmConfig.json[0].esms.length, 2, 'remote ESM question count');
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

  // 8. clear_table empties device rows.
  const clear = await post(`${studyPath}/locations/clear_table`, form({ device_id: 'dev-1' }), formHeaders);
  assert.strictEqual(clear.status, 200, 'clear ok');
  const afterClear = await post(`${studyPath}/locations/latest`, form({ device_id: 'dev-1' }), formHeaders);
  assert.deepStrictEqual(afterClear.json, [], 'empty after clear');
  console.log('✓ clear_table empties rows');

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

  // 16. delete clears device rows.
  const gDel = await request('DELETE', `${apiBase}/sensors/heartrate/data?device_id=dev-1`, { headers: jsonAuth });
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

  const esmExport = await request('GET', `${apiBase}/export/esms?format=json`, { headers: jsonAuth });
  assert.strictEqual(esmExport.status, 200, 'picture ESM export ok');
  const photoRow = esmExport.json.rows.find((row) => row.data.esm_trigger === 'pilot_context_photo');
  assert.ok(photoRow, 'picture ESM row found');
  assert.strictEqual(photoRow.data.esm_user_answer, tinyPngBase64, 'raw picture base64 preserved');

  const imageRes = await fetch(`${base}${apiBase}/media/esms/${photoRow.id}/image`, {
    headers: { 'x-study-password': 'secret' },
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

  const esmDashboard = await request('GET', `${apiBase}/dashboard/esm-responses`, { headers: jsonAuth });
  assert.strictEqual(esmDashboard.status, 200, 'dashboard ESM response list ok');
  const pluginPhotoRow = esmDashboard.json.rows.find((row) =>
    row.sensor === 'plugin_ios_esm' &&
    row.data.esm_trigger === 'pilot_plugin_context_photo'
  );
  assert.ok(pluginPhotoRow, 'dashboard finds plugin_ios_esm ESM rows');
  assert.strictEqual(pluginPhotoRow.data.esm_trigger, 'pilot_plugin_context_photo', 'dashboard preserves plugin ESM row data');

  const pluginImageRes = await fetch(`${base}${apiBase}/media/plugin_ios_esm/${pluginPhotoRow.id}/image`, {
    headers: { 'x-study-password': 'secret' },
  });
  assert.strictEqual(pluginImageRes.status, 200, 'plugin_ios_esm image endpoint ok');
  assert.strictEqual(pluginImageRes.headers.get('content-type'), 'image/png', 'plugin_ios_esm served as PNG');
  console.log('✓ dashboard discovers plugin_ios_esm photo responses');

  const emptyScreenTimeDashboard = await request('GET', `${apiBase}/dashboard/summary`, { headers: jsonAuth });
  assert.strictEqual(emptyScreenTimeDashboard.status, 200, 'dashboard summary before Screen Time rows ok');
  assert.ok(
    emptyScreenTimeDashboard.json.sensors.some((row) => row.sensor === 'screentime_apps' && row.rows === 0),
    'researcher dashboard lists empty consolidated Screen Time export'
  );
  const emptyScreenTimeCsv = await request('GET', `${apiBase}/export/screentime_apps?format=csv`, { headers: jsonAuth });
  assert.strictEqual(emptyScreenTimeCsv.status, 200, 'empty Screen Time CSV export ok');
  assert.ok(/^id,study_id,device_id,timestamp,app_label_source,app_name,duration_seconds,event_type,interval_end,interval_start,notifications,pickups,threshold_minutes,created_at/m.test(emptyScreenTimeCsv.json), 'empty Screen Time CSV header lists app usage columns');
  console.log('✓ researcher Sensor coverage shows Screen Time export before rows arrive');

  // 17.6. Screen Time events are uploaded through ios_aware_log and exposed as
  //       a normalized app-specific export sensor in the dashboards.
  const screenTimeLogs = [
    {
      timestamp: 900,
      device_id: 'dev-1',
      log_message: JSON.stringify({
        class: 'SpecificAppUsageManager',
        event: 'screen_time_selection_updated',
        selected_app_count: '2',
        selected_category_count: '1',
        selected_web_count: '0',
      }),
    },
    {
      timestamp: 901,
      device_id: 'dev-1',
      log_message: JSON.stringify({
        class: 'SpecificAppUsageManager',
        event: 'screen_time_threshold_reached',
        screen_time_event: 'studytrace.selected.apps.usage.app.0.15',
        threshold_minutes: '15',
        target_kind: 'app',
        target_index: '0',
        target_label: 'App 1',
        activity: 'studytrace.selected.apps.daily',
        event_timestamp: '901',
      }),
    },
    {
      timestamp: 902,
      device_id: 'dev-1',
      log_message: JSON.stringify({
        class: 'SpecificAppUsageManager',
        event: 'screen_time_report_app_usage',
        target_kind: 'app',
        target_index: '0',
        target_label: 'Instagram',
        app_name: 'Instagram',
        bundle_identifier: 'com.burbn.instagram',
        duration_seconds: '1860',
        pickups: '4',
        notifications: '9',
        interval_start: '100',
        interval_end: '902',
        event_timestamp: '902',
      }),
    },
    {
      timestamp: 903,
      device_id: 'dev-1',
      log_message: JSON.stringify({
        class: 'SpecificAppUsageManager',
        event: 'screen_time_report_app_usage',
        target_kind: 'app',
        target_index: '1',
        target_label: 'YouTube',
        app_name: 'YouTube',
        bundle_identifier: 'com.google.ios.youtube',
        duration_seconds: '5400',
        pickups: '2',
        notifications: '1',
        interval_start: '100',
        interval_end: '903',
        event_timestamp: '903',
      }),
    },
    {
      timestamp: 904,
      device_id: 'dev-1',
      log_message: JSON.stringify(JSON.stringify({
        event: 'app_usage_summary',
        appName: 'TikTok',
        bundleIdentifier: 'com.zhiliaoapp.musically',
        durationSeconds: '7200',
        numberOfPickups: '6',
        numberOfNotifications: '3',
        eventTimestamp: '904',
      })),
    },
    {
      timestamp: 905,
      device_id: 'dev-1',
      log_message: JSON.stringify({
        source: 'DeviceActivityReport',
        type: 'report-app-usage',
        displayName: 'Messages',
        bundleId: 'com.apple.MobileSMS',
        totalActivityDuration: 600,
        intervalStart: 100,
        intervalEnd: 905,
      }),
    },
    {
      timestamp: 906,
      device_id: 'dev-1',
      log_message: JSON.stringify({
        class: 'SpecificAppUsageManager',
        event: 'screen_time_labels_updated',
        labels_json: JSON.stringify([
          { targetKind: 'app', targetIndex: 2, label: 'Discord', timestamp: 906 },
        ]),
      }),
    },
    {
      timestamp: 907,
      device_id: 'dev-1',
      log_message: JSON.stringify({
        class: 'SpecificAppUsageManager',
        event: 'screen_time_report_uploaded',
        summaries_json: JSON.stringify([
          {
            targetKind: 'app',
            targetIndex: 3,
            appName: 'Reddit',
            bundleIdentifier: 'com.reddit.Reddit',
            durationSeconds: 2400,
            numberOfPickups: 5,
            numberOfNotifications: 2,
            eventTimestamp: 907,
          },
        ]),
      }),
    },
  ];
  const screenTimeIns = await post(`${studyPath}/ios_aware_log/insert`,
    form({ device_id: 'dev-1', data: JSON.stringify(screenTimeLogs) }), formHeaders);
  assert.strictEqual(screenTimeIns.status, 200, 'screen time event insert ok');

  const screenTimeDiagnostics = await request('GET', `${apiBase}/dashboard/screentime-diagnostics`, { headers: jsonAuth });
  assert.strictEqual(screenTimeDiagnostics.status, 200, 'researcher Screen Time diagnostics ok');
  assert.ok(screenTimeDiagnostics.json.rawRows.length >= 4, 'diagnostics exposes raw Screen Time rows');
  assert.ok(screenTimeDiagnostics.json.rawRows.some((row) => row.raw_event === 'screen_time_report_app_usage'), 'diagnostics includes raw app usage event');
  assert.strictEqual(screenTimeDiagnostics.json.appRows[0].app_name, 'TikTok', 'diagnostics parses double-encoded app usage and sorts by duration');
  assert.strictEqual(screenTimeDiagnostics.json.appRows[1].app_name, 'YouTube', 'diagnostics keeps lower-duration app after higher-duration app');
  assert.ok(screenTimeDiagnostics.json.appRows.some((row) => row.app_name === 'Messages'), 'diagnostics parses camelCase DeviceActivity-style app usage');
  assert.ok(screenTimeDiagnostics.json.appRows.some((row) => row.app_name === 'Reddit'), 'diagnostics parses nested summaries_json arrays');
  console.log('✓ researcher Screen Time diagnostics show raw and cleaned app rows');

  const fallbackStudy = await post('/admin/studies',
    JSON.stringify({ study_id: 'rawonly', password: 'secret', name: 'Raw Only' }),
    { 'Content-Type': 'application/json', 'x-admin-token': 'test-admin-token' });
  assert.strictEqual(fallbackStudy.status, 200, 'admin create raw-only study');
  const rawOnlyPath = '/index.php/webservice/index/rawonly/secret';
  const rawOnlyApiBase = '/api/v1/studies/rawonly';
  await post(`${rawOnlyPath}/ios_aware_log/insert`, form({
    device_id: 'dev-raw',
    data: JSON.stringify([
      {
        timestamp: 1001,
        device_id: 'dev-raw',
        log_message: JSON.stringify({
          class: 'SpecificAppUsageManager',
          event: 'screen_time_selection_updated',
          selected_app_count: '2',
        }),
      },
      {
        timestamp: 1002,
        device_id: 'dev-raw',
        log_message: JSON.stringify({
          class: 'SpecificAppUsageManager',
          event: 'screen_time_report_app_usage',
          target_kind: 'app',
          target_index: '0',
          target_label: 'Instagram',
          app_name: 'Instagram',
          bundle_identifier: 'com.burbn.instagram',
          duration_seconds: '300',
          event_timestamp: '1002',
        }),
      },
      {
        timestamp: 1003,
        device_id: 'dev-raw',
        log_message: JSON.stringify({
          class: 'SpecificAppUsageManager',
          event: 'screen_time_threshold_reached',
          screen_time_event: 'studytrace.selected.apps.usage.app.0.15',
          threshold_minutes: '15',
          target_kind: 'app',
          target_index: '0',
          target_label: 'App 1',
          activity: 'studytrace.selected.apps.daily',
          event_timestamp: '1003',
        }),
      },
      {
        timestamp: 1004,
        device_id: 'dev-raw',
        log_message: JSON.stringify({
          class: 'SpecificAppUsageManager',
          event: 'screen_time_threshold_reached',
          screen_time_event: 'studytrace.selected.apps.usage.app.1.5',
          threshold_minutes: '5',
          target_kind: 'app',
          target_index: '1',
          target_label: 'App 2',
          activity: 'studytrace.selected.apps.daily',
          event_timestamp: '1004',
        }),
      },
      {
        timestamp: 1005,
        device_id: 'dev-raw',
        log_message: JSON.stringify({
          class: 'SpecificAppUsageManager',
          event: 'screen_time_monitoring_started',
          threshold_count: '18',
        }),
      },
    ]),
  }), formHeaders);
  const rawOnlyDiagnostics = await request('GET', `${rawOnlyApiBase}/dashboard/screentime-diagnostics`, { headers: jsonAuth });
  assert.strictEqual(rawOnlyDiagnostics.status, 200, 'raw-only diagnostics ok');
  assert.ok(rawOnlyDiagnostics.json.rawRows.length >= 2, 'raw-only diagnostics has raw rows');
  assert.ok(rawOnlyDiagnostics.json.appRows.some((row) => row.app_name === 'Instagram' && row.threshold_minutes === 15 && row.app_label_source === 'device_activity_report'), 'raw-only diagnostics resolves report-labeled threshold rows');
  const rawOnlyCsv = await request('GET', `${rawOnlyApiBase}/export/screentime_apps?format=csv`, { headers: jsonAuth });
  assert.strictEqual(rawOnlyCsv.status, 200, 'raw-only app usage CSV ok');
  const rawOnlyLines = rawOnlyCsv.json.split(/\r?\n/).filter(Boolean);
  assert.ok(rawOnlyLines.length >= 2, 'report-labeled threshold row appears in Screen Time CSV');
  assert.ok(/^id,study_id,device_id,timestamp,app_label_source,app_name,duration_seconds,event_type,interval_end,interval_start,notifications,pickups,threshold_minutes,created_at/.test(rawOnlyLines[0]), 'raw-only CSV emits app usage columns');
  assert.ok(/Instagram/.test(rawOnlyCsv.json), 'raw-only CSV resolves report app label');
  assert.ok(/device_activity_report/.test(rawOnlyCsv.json), 'raw-only CSV marks report-resolved label source');
  assert.ok(/fallback_index/.test(rawOnlyCsv.json), 'raw-only CSV marks fallback index label source');
  assert.ok(/App 2/.test(rawOnlyCsv.json), 'raw-only CSV keeps unlabeled app-index milestone rows');
  assert.ok(/usage_threshold/.test(rawOnlyCsv.json), 'raw-only CSV includes threshold event type');
  assert.ok(/,15,/.test(rawOnlyCsv.json), 'raw-only CSV includes threshold minutes');
  console.log('✓ Screen Time CSV exports labeled app threshold rows');

  const metadataOnlyStudy = await post('/admin/studies',
    JSON.stringify({ study_id: 'screenmeta', password: 'secret', name: 'Screen Time Metadata Only' }),
    { 'Content-Type': 'application/json', 'x-admin-token': 'test-admin-token' });
  assert.strictEqual(metadataOnlyStudy.status, 200, 'admin create metadata-only Screen Time study');
  const metadataOnlyPath = '/index.php/webservice/index/screenmeta/secret';
  const metadataOnlyApiBase = '/api/v1/studies/screenmeta';
  await post(`${metadataOnlyPath}/ios_aware_log/insert`, form({
    device_id: 'dev-meta',
    data: JSON.stringify([
      {
        timestamp: 1101,
        device_id: 'dev-meta',
        log_message: JSON.stringify({
          class: 'SpecificAppUsageManager',
          event: 'screen_time_monitoring_started',
          threshold_count: '18',
        }),
      },
      {
        timestamp: 1102,
        device_id: 'dev-meta',
        log_message: JSON.stringify({
          class: 'SpecificAppUsageManager',
          event: 'screen_time_monitoring_error',
          reason: 'DeviceActivityReport did not return app summaries yet',
        }),
      },
    ]),
  }), formHeaders);
  const metadataOnlyDashboard = await request('GET', `${metadataOnlyApiBase}/dashboard/summary`, { headers: jsonAuth });
  assert.strictEqual(metadataOnlyDashboard.status, 200, 'metadata-only dashboard ok');
  assert.ok(
    metadataOnlyDashboard.json.sensors.some((row) => row.sensor === 'screentime_apps' && row.rows === 2),
    'metadata-only dashboard counts fallback Screen Time rows'
  );
  const metadataOnlyCsv = await request('GET', `${metadataOnlyApiBase}/export/screentime_apps?format=csv`, { headers: jsonAuth });
  assert.strictEqual(metadataOnlyCsv.status, 200, 'metadata-only Screen Time CSV ok');
  const metadataOnlyLines = metadataOnlyCsv.json.split(/\r?\n/).filter(Boolean);
  assert.strictEqual(metadataOnlyLines.length, 3, 'metadata-only CSV exports counted rows, not just the header');
  assert.ok(/screen_time_monitoring_started/.test(metadataOnlyCsv.json), 'metadata-only CSV includes raw Screen Time event name');
  assert.ok(/raw_event/.test(metadataOnlyCsv.json), 'metadata-only CSV marks fallback label source');
  console.log('✓ Screen Time CSV exports counted fallback rows');

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
  assert.ok(names.includes('screentime_apps'), 'consolidated Screen Time export listed');
  assert.ok(!names.includes('screentime_raw_log'), 'legacy raw Screen Time export removed');
  assert.ok(!names.includes('screentime_app_usage'), 'legacy app-usage Screen Time export removed');
  console.log('✓ admin lists sensors:', names.join(', '));

  // 20.5. studies list shows the provisioned study and device counts.
  const studiesList = await request('GET', `/admin/studies`, { headers: adminHdr });
  assert.strictEqual(studiesList.status, 200, 'list studies ok');
  assert.ok(studiesList.json.studies.some((study) => study.study_id === 'demo'), 'study appears in admin list');
  console.log('✓ admin lists studies');

  // 20.6. researcher dashboard summary is study-scoped and authenticated.
  const dashboard = await request('GET', `/api/v1/studies/demo/dashboard/summary`, { headers: jsonAuth });
  assert.strictEqual(dashboard.status, 200, 'researcher dashboard ok');
  assert.strictEqual(dashboard.json.study.study_id, 'demo', 'dashboard study id');
  assert.ok(Array.isArray(dashboard.json.devices), 'dashboard devices array');
  assert.ok(
    dashboard.json.sensors.some((row) => row.sensor === 'screentime_apps'),
    'researcher dashboard lists consolidated Screen Time export'
  );
  console.log('✓ researcher dashboard summary');

  const researcherScreenTimeCsv = await request('GET', `${apiBase}/export/screentime_apps?format=csv`, { headers: jsonAuth });
  assert.strictEqual(researcherScreenTimeCsv.status, 200, 'researcher Screen Time CSV export ok');
  assert.ok(/^id,study_id,device_id,timestamp,app_label_source,app_name,duration_seconds,event_type,interval_end,interval_start,notifications,pickups,threshold_minutes,created_at/m.test(researcherScreenTimeCsv.json), 'Screen Time CSV header includes usage fields');
  assert.ok(/Instagram/.test(researcherScreenTimeCsv.json), 'Screen Time CSV includes app display name');
  assert.ok(!/com\.burbn\.instagram/.test(researcherScreenTimeCsv.json), 'Screen Time CSV no longer leaks bundle identifiers');
  console.log('✓ researcher Sensor coverage exports consolidated Screen Time CSV');

  const adminScreenTimeCsv = await request('GET', `/admin/export/screentime_apps?format=csv`, { headers: adminHdr });
  assert.strictEqual(adminScreenTimeCsv.status, 200, 'admin Screen Time CSV export ok');
  assert.ok(/Instagram/.test(adminScreenTimeCsv.json), 'admin Screen Time CSV includes app display name');
  console.log('✓ admin Sensor inventory exports consolidated Screen Time CSV');

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

  console.log('\nALL SMOKE TESTS PASSED');
  server.close();
  process.exit(0);
} catch (err) {
  console.error('\nSMOKE TEST FAILED:', err.message);
  server.close();
  process.exit(1);
}
