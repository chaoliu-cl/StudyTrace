// Local preview of the dashboards with an in-memory database and demo data.
// Development only: nothing is persisted, and it listens on localhost.
//
//   npm run preview --workspace server      (or: cd server && npm run preview)
//
// Researcher dashboard: http://localhost:4173/researcher/
//   study id: demo, researcher password: demo-researcher-password
// Admin dashboard: http://localhost:4173/admin/  (token: demo-admin-token)

import { newDb } from 'pg-mem';
import * as db from '../src/db.js';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'demo-admin-token';
process.env.BATTERY_USAGE_OCR_DISABLED = 'true';
const PORT = Number(process.env.PORT) || 4173;

const mem = newDb();
mem.public.registerFunction({ name: 'now', returns: 'timestamptz', implementation: () => new Date() });
mem.public.registerFunction({
  name: 'to_regclass',
  args: ['text'],
  returns: 'text',
  implementation: (name) => {
    try {
      return mem.public.getTable(name, true) ? name : null;
    } catch {
      return null;
    }
  },
});
const pg = mem.adapters.createPg();
db.setPool(new pg.Pool());
await db.initSchema();

const { createApp } = await import('../src/appFactory.js');
const app = createApp();
const server = app.listen(PORT, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${PORT}`;
  await seed(base);
  console.log(`StudyTrace preview on http://localhost:${PORT}/researcher/ (study demo / demo-researcher-password)`);
});

async function call(base, path, body, headers) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.warn(`seed ${path} -> ${res.status}`);
}

async function seed(base) {
  await call(base, '/admin/studies', {
    study_id: 'demo',
    password: 'demo-participant',
    researcher_password: 'demo-researcher-password',
    name: 'Demo study',
    timezone: 'America/New_York',
  }, { 'x-admin-token': process.env.ADMIN_TOKEN });
  const auth = { Authorization: 'Bearer demo-participant' };
  const api = '/api/v1/studies/demo';
  const now = Date.now();
  const hour = 3600000;
  const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

  await fetch(`${base}/index.php/webservice/index/demo/demo-participant?participant=P001`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'device_id=demo-ios-device',
  });
  await call(base, `${api}/sensors/device_state/data`, { device_id: 'demo-ios-device', rows: [{
    timestamp: now - 2 * hour, seq: 1, event_id: 'ds1', timezone: 'America/New_York', platform: 'ios',
    notification_authorization: 'authorized', location_authorization: 'authorized_always',
    location_accuracy_authorization: 'full', background_refresh_status: 'available', battery_level: 0.64,
  }] }, auth);
  await call(base, `${api}/sensors/client_events/data`, { device_id: 'demo-ios-device', rows: [
    { timestamp: now - 3 * hour, seq: 2, event_id: 'ce2', event_name: 'app_launch', metadata: { launch_reason: 'location' } },
    { timestamp: now - 2 * hour, seq: 3, event_id: 'ce3', event_name: 'notification_delivered', metadata: { notification_id: 'esm_1', delivered_at: now - 2 * hour, is_survey_prompt: true } },
    { timestamp: now - hour, seq: 4, event_id: 'ce4', event_name: 'heartbeat' },
  ] }, auth);
  const usage = [];
  for (let i = 0; i < 12; i += 1) {
    const unlock = now - (i + 1) * 2 * hour;
    usage.push({ timestamp: unlock, elapsed_device_on: 0, elapsed_device_off: 50 * 60000 });
    usage.push({ timestamp: unlock + (i % 3 === 0 ? 40000 : 11 * 60000), elapsed_device_on: i % 3 === 0 ? 40000 : 11 * 60000, elapsed_device_off: 0 });
  }
  await call(base, `${api}/sensors/plugin_device_usage/data`, { device_id: 'demo-ios-device', rows: usage }, auth);
  await call(base, `${api}/sensors/locations/data`, { device_id: 'demo-ios-device', rows: [
    { timestamp: now - 5 * hour, double_latitude: 39.747, double_longitude: -83.813, double_accuracy: 12 },
    { timestamp: now - 3 * hour, double_latitude: 39.762, double_longitude: -83.84, double_accuracy: 18 },
  ] }, auth);
  await call(base, `${api}/usage-screenshots`, {
    device_id: 'demo-ios-device', timestamp: now - 4 * hour, upload_id: 'demo-battery', screenshot_kind: 'battery',
    screenshot_base64: tinyPng, usage_window: 'last_24_hours', participant_edited: true,
    confirmed_rows: [
      { app_name: 'Instagram', screen_time_seconds: 4320, battery_percent: 21 },
      { app_name: 'Messages', screen_time_seconds: 1500, battery_percent: 9 },
    ],
  }, auth);
  await call(base, `${api}/usage-screenshots`, {
    device_id: 'demo-ios-device', timestamp: now - 3 * hour, upload_id: 'demo-activity', screenshot_kind: 'screen_time_activity',
    screenshot_base64: tinyPng, activity_date: new Date(now - 24 * hour).toISOString().slice(0, 10),
    confirmed_rows: [{ app_name: 'Safari', screen_time_seconds: 2400 }, { app_name: 'YouTube', screen_time_seconds: 1800 }],
    summary: { total_screen_time_seconds: 15600, pickups: 74, notifications: 131 },
  }, auth);
  // A participant label containing markup, to confirm the dashboard escapes it.
  await fetch(`${base}/index.php/webservice/index/demo/demo-participant?participant=${encodeURIComponent('<img src=x onerror=alert(1)>')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'device_id=demo-android-device',
  });
  await call(base, `${api}/sensors/device_state/data`, { device_id: 'demo-android-device', rows: [{
    timestamp: now - hour, seq: 1, event_id: 'ads1', timezone: 'America/Chicago', platform: 'android', usage_access: 'granted',
    location_authorization: 'authorized_when_in_use', notification_authorization: 'authorized',
  }] }, auth);
  await call(base, `${api}/sensors/android_screen_events/data`, { device_id: 'demo-android-device', rows: [
    { timestamp: now - 6 * hour, event: 'unlock', dedupe_key: 'a1' },
    { timestamp: now - 6 * hour + 7 * 60000, event: 'lock', dedupe_key: 'a2' },
  ] }, auth);
  await call(base, `${api}/sensors/android_app_usage/data`, { device_id: 'demo-android-device', rows: [{
    timestamp: now - 30 * hour, date: new Date(now - 30 * hour).toISOString().slice(0, 10), timezone: 'America/Chicago',
    package_name: 'com.whatsapp', app_label: 'WhatsApp', foreground_seconds: 2700, platform: 'android', construct: 'foreground_time',
  }] }, auth);
}

process.on('SIGINT', () => server.close(() => process.exit(0)));
