import assert from 'node:assert/strict';
import test from 'node:test';
import { newDb } from 'pg-mem';
import * as db from '../src/db.js';
import { randomWindow, configurationFromJson, newSchedule } from '../public/assets/schedule-editor.js';

test('random windows fit phone jitter limits and imported drafts preserve metadata', () => {
  assert.deepEqual(randomWindow('19:15', '20:45'), { times: ['20:00'], hours: [20], randomize: 45 });
  assert.deepEqual(randomWindow('09:00', '15:00'), { times: ['12:00'], hours: [12], randomize: 180 });
  assert.deepEqual(randomWindow('19:00', '20:59'), { times: ['19:59'], hours: [19], randomize: 59 });
  for (const bounds of [['20:00', '19:00'], ['08:00', '15:00'], ['bad', '20:00']]) assert.throws(() => randomWindow(...bounds));
  const draft = { esm_schedule: [newSchedule('esm_schedule')], app_usage_screenshot_schedule: [], battery_screenshot_schedule: [], screen_time_activity_schedule: [] };
  draft.esm_schedule[0].custom_metadata = { keep: true };
  const copy = configurationFromJson(JSON.stringify(draft));
  assert.deepEqual(copy, draft);
  copy.esm_schedule[0].custom_metadata.keep = false;
  assert.equal(draft.esm_schedule[0].custom_metadata.keep, true);
  assert.throws(() => configurationFromJson('[]'));
});

test('researcher protocol editing preserves settings, protects revisions, and delivers all tasks', async t => {
  const mem = newDb();
  mem.public.registerFunction({ name: 'now', returns: 'timestamptz', implementation: () => new Date() });
  mem.public.registerFunction({ name: 'to_regclass', args: ['text'], returns: 'text', implementation: name => mem.public.getTable(name, true) ? name : null });
  const pg = mem.adapters.createPg();
  const pool = new pg.Pool();
  db.setPool(pool);
  await db.initSchema();
  await db.upsertStudy('protocol-test', { password: 'participant-fixture', researcherPassword: 'researcher-fixture', name: 'Protocol fixture' });
  const sentinel = { timezone: 'America/New_York', untouched: { keep: true }, environment_collection: { enabled: true, context_questions_enabled: true, green_space_enabled: true } };
  await db.updateStudyConfig('protocol-test', sentinel);
  const { createApp } = await import('../src/appFactory.js');
  const server = await new Promise(resolve => { const s = createApp().listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await pool.end(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = '/api/v1/studies/protocol-test';
  const headers = { 'Content-Type': 'application/json', 'x-researcher-password': 'researcher-fixture' };
  async function call(path, options = {}) { const r = await fetch(base + path, options); return { status: r.status, body: await r.json() }; }
  const get = () => call(`${api}/prompt-schedules`, { headers });
  const put = body => call(`${api}/prompt-schedules`, { method: 'PUT', headers, body: JSON.stringify(body) });
  let saved;
  await t.test('participant credentials cannot read presets or edit schedules', async () => {
    for (const path of ['prompt-schedules', 'prompt-schedule-preset']) {
      assert.ok([401, 403].includes((await call(`${api}/${path}`, { headers: { Authorization: 'Bearer participant-fixture' } })).status));
    }
    assert.ok([401, 403].includes((await call(`${api}/prompt-schedules`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer participant-fixture' }, body: '{}' })).status));
  });
  await t.test('pilot preset saves three separate questionnaires and just one evening photo task', async () => {
    const initial = await get();
    const preset = await call(`${api}/prompt-schedule-preset`, { headers });
    assert.equal(preset.status, 200);
    assert.deepEqual(preset.body.esm_schedule.map(s => s.esms.length), [10, 10, 5]);
    assert.equal(preset.body.app_usage_screenshot_schedule.length, 1);
    const result = await put({ ...preset.body, expected_revision: initial.body.revision });
    assert.equal(result.status, 200);
    saved = result.body;
    assert.deepEqual(saved.esm_schedule.map(s => [s.times[0], s.randomize]), [['10:30', 90], ['14:30', 90], ['18:00', 60]]);
    assert.deepEqual(saved.app_usage_screenshot_schedule.map(s => [s.times[0], s.randomize]), [['20:00', 45]]);
    assert.equal(saved.app_usage_screenshot_schedule[0].esms[0].esm.esm_type, 14);
    assert.ok(saved.esm_schedule.every(s => s.schedule_id.startsWith('st_')));
    const study = await db.getStudy('protocol-test');
    for (const [key, value] of Object.entries(sentinel)) assert.deepEqual(study.config[key], value);
    const remote = await call('/index.php/webservice/index/protocol-test/participant-fixture/esm/config');
    assert.equal(remote.status, 200);
    assert.deepEqual(remote.body.map(s => s.esms.length), [15, 15, 10, 1]);
    assert.deepEqual(saved.previous_configuration.esm_schedule, []);
  });
  await t.test('question edits and photos round-trip without replacing other tasks or advanced fields', async () => {
    const draft = configurationFromJson(saved);
    draft.esm_schedule[0].custom_metadata = { value: 'retained' };
    draft.esm_schedule[0].esms[0].esm.custom_metadata = 123;
    draft.esm_schedule[0].esms[0].esm.esm_title = 'Edited item';
    const photo = newSchedule('esm_schedule').esms[0];
    photo.esm.esm_type = 14;
    draft.esm_schedule[0].esms.push(photo);
    draft.esm_schedule[0].start_date = '11-01-2026';
    draft.esm_schedule[0].end_date = '11-30-2026';
    const result = await put({ ...draft, expected_revision: saved.revision });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.esm_schedule.slice(1), saved.esm_schedule.slice(1));
    assert.deepEqual(result.body.app_usage_screenshot_schedule, saved.app_usage_screenshot_schedule);
    assert.deepEqual(result.body.previous_configuration.esm_schedule, saved.esm_schedule);
    saved = result.body;
    assert.deepEqual(configurationFromJson((await get()).body), configurationFromJson(saved));
  });
  await t.test('environment changes after loading a draft are preserved and do not block schedule saves', async () => {
    await db.updateStudyConfig('protocol-test', { environment_collection: { ...sentinel.environment_collection, air_quality_enabled: true } });
    const result = await put({ ...configurationFromJson(saved), expected_revision: saved.revision });
    assert.equal(result.status, 200);
    assert.equal((await db.getStudy('protocol-test')).config.environment_collection.air_quality_enabled, true);
    saved = result.body;
  });
  await t.test('invalid schedules fail without changing the saved configuration', async () => {
    const invalid = [
      d => { d.esm_schedule[0].randomize = 181; },
      d => { d.esm_schedule[0].times = ['25:00']; },
      d => { d.esm_schedule[0].start_date = '02-30-2026'; },
      d => { d.esm_schedule[0].end_date = '01-01-2020'; },
      d => { d.esm_schedule[0].studytrace_window_end = '10:00'; },
      d => { d.esm_schedule[0].esms = []; },
      d => { d.esm_schedule[0].esms[0].esm.esm_radios = ['']; },
      d => { d.esm_schedule[0].esms[1].esm.esm_trigger = d.esm_schedule[0].esms[0].esm.esm_trigger; },
      d => { d.esm_schedule.push(structuredClone(d.esm_schedule[0])); },
    ];
    for (const mutate of invalid) {
      const draft = configurationFromJson(saved); mutate(draft);
      assert.equal((await put({ ...draft, expected_revision: saved.revision })).status, 400);
      assert.deepEqual(configurationFromJson((await get()).body), configurationFromJson(saved));
    }
    assert.equal((await put(configurationFromJson(saved))).status, 409);
  });
  await t.test('stale saves and legacy single-schedule endpoints cannot overwrite the protocol', async () => {
    const oldRevision = saved.revision;
    const draft = configurationFromJson(saved);
    draft.esm_schedule[0].notification_title = 'Latest title';
    const result = await put({ ...draft, expected_revision: oldRevision });
    assert.equal(result.status, 200);
    saved = result.body;
    assert.equal((await put({ ...draft, expected_revision: oldRevision })).status, 409);
    assert.equal((await call(`${api}/esm-schedule`, { method: 'PUT', headers, body: JSON.stringify({ times: '12:00', randomize: 0, expiration: 60, esms: draft.esm_schedule[0].esms }) })).status, 409);
    assert.deepEqual(configurationFromJson((await get()).body), configurationFromJson(saved));
  });
  await t.test('a previous configuration can be restored with its original stable IDs', async () => {
    const prior = configurationFromJson(saved.previous_configuration);
    const restored = await put({ ...prior, expected_revision: saved.revision });
    assert.equal(restored.status, 200);
    assert.deepEqual(configurationFromJson(restored.body), prior);
  });
  await t.test('legacy embedded screenshot tasks migrate without losing unknown schedules', async () => {
    await db.upsertStudy('legacy-protocol', { password: 'legacy-participant', researcherPassword: 'researcher-fixture', name: 'Legacy fixture' });
    const survey = newSchedule('esm_schedule');
    survey.randomize = 0;
    delete survey.times;
    const battery = { ...newSchedule('app_usage_screenshot_schedule'), schedule_id: 'legacy_battery_screenshot', studytrace_prompt_type: 'battery_usage_screenshot', advanced: { retained: true } };
    const future = { schedule_id: 'future_task', studytrace_prompt_type: 'future_prompt', esms: [{ esm: { esm_type: 1, esm_title: 'Future' } }] };
    await db.updateStudyConfig('legacy-protocol', { esm_schedule: [survey, battery, future] });
    const path = '/api/v1/studies/legacy-protocol/prompt-schedules';
    const loaded = await call(path, { headers });
    assert.equal(loaded.body.esm_schedule.length, 1);
    assert.deepEqual(loaded.body.battery_screenshot_schedule, [battery]);
    assert.equal(loaded.body.unmanaged_count, 1);
    const result = await call(path, { method: 'PUT', headers, body: JSON.stringify({ ...configurationFromJson(loaded.body), expected_revision: loaded.body.revision }) });
    assert.equal(result.status, 200);
    const config = (await db.getStudy('legacy-protocol')).config;
    assert.deepEqual(config.esm_schedule, [{ ...survey, times: ['10:00'] }, future]);
    assert.deepEqual(config.battery_screenshot_schedule, [battery]);
  });
});
