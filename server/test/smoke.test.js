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

const server = app.listen(0);
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

  // 2. Wrong password rejected.
  const bad = await post('/index.php/webservice/index/demo/wrong', form({ device_id: 'd1' }), formHeaders);
  assert.strictEqual(bad.status, 403, 'bad password rejected');
  console.log('✓ invalid password rejected');

  // 3. Join -> config array.
  const join = await post(`${studyPath}?participant=p1`, form({ device_id: 'dev-1' }), formHeaders);
  assert.strictEqual(join.status, 200, 'join ok');
  assert.ok(Array.isArray(join.json), 'config is array');
  assert.strictEqual(join.json[0].study_id, 'demo', 'config study_id');
  console.log('✓ join returns config array');

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
  console.log('✓ admin lists sensors:', names.join(', '));

  // 20. JSON export returns the stored rows.
  const expJson = await request('GET', `/admin/export/steps?format=json`, { headers: adminHdr });
  assert.strictEqual(expJson.status, 200, 'json export ok');
  assert.ok(expJson.json.rows.length >= 1, 'json export has rows');
  assert.strictEqual(expJson.json.rows[0].data.count, 1200, 'json export row payload');
  console.log('✓ admin JSON export rows:', expJson.json.count);

  // 21. CSV export flattens data keys into columns.
  const expCsv = await request('GET', `/admin/export/steps?format=csv`, { headers: adminHdr });
  assert.strictEqual(expCsv.status, 200, 'csv export ok');
  assert.ok(/^id,device_id,timestamp,.*created_at/m.test(expCsv.json), 'csv header present');
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
