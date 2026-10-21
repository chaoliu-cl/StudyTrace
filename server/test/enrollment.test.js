import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import * as db from '../src/db.js';
import { createApp } from '../src/appFactory.js';

process.env.ADMIN_TOKEN = 'enrollment-test-admin';
const mem = newDb({ noAstCoverageCheck: true });
const pg = mem.adapters.createPg();
const pool = new pg.Pool();
db.setPool(pool);
await db.initSchema();
await db.initSchema(); // repeatable additive schema
await db.upsertStudy('consent-test', { password: 'shared-password', researcherPassword: 'private-researcher-password', name: 'Consent test' });
const server = createApp().listen(0, '127.0.0.1');
await new Promise(resolve => server.on('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const root = '/api/v1/studies/consent-test';
const researcher = { 'x-researcher-password': 'private-researcher-password' };
async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
const consent = participant => ({ participant, consent_verified: true, consent_version: 'IRB374-approved-test-version', consent_reference: 'TEST-REGISTER', consented_at: new Date(Date.now() - 60000).toISOString(), verified_by: 'staff-test' });
const issue = async participant => {
  const result = await call('POST', root + '/join-link', consent(participant), researcher);
  assert.equal(result.status, 200);
  return { ...result.data, token: new URL(result.data.study_url).pathname.split('/').pop() };
};
const auth = token => ({ Authorization: `Bearer ${token}` });
try {
  assert.equal((await call('POST', root + '/join-link', consent('P0'), auth('shared-password'))).status, 403);
  assert.equal((await call('POST', root + '/join-link', { ...consent('P0'), consent_verified: false }, researcher)).status, 400);
  assert.equal((await call('POST', root + '/join-link', { ...consent('P0'), consent_reference: '' }, researcher)).status, 400);
  assert.equal((await call('POST', root + '/enrollment', { device_id: 'phone-A' }, auth('shared-password'))).status, 403);
  assert.equal((await call('POST', '/index.php/webservice/index/consent-test/shared-password', { device_id: 'phone-A' })).status, 403);
  assert.equal((await call('POST', root + '/sensors/locations/data', { device_id: 'phone-A', rows: [{ timestamp: 1 }] }, auth('shared-password'))).status, 403);
  const invite = await issue('P1');
  assert.match(invite.token, /^pi_[a-f0-9]{64}$/);
  assert.equal((await call('POST', root + '/join-link', consent('P1'), researcher)).status, 409);
  const stored = (await pool.query('SELECT * FROM participant_enrollments')).rows[0];
  assert.ok(!JSON.stringify(stored).includes(invite.token), 'only the token hash is persisted');
  const aware = `/index.php/webservice/index/consent-test/${invite.token}`;
  assert.equal((await call('POST', aware, { device_id: 'phone-A' })).status, 403, 'invitation is unusable before activation');
  const activated = await call('POST', root + '/enrollment', { device_id: 'phone-A' }, auth(invite.token));
  assert.equal(activated.status, 200);
  assert.equal(activated.data.participant, 'P1');
  assert.ok(Math.abs(Date.parse(activated.data.expires_at) - Date.now() - 28 * 86400000) < 5000);
  const retry = await call('POST', root + '/enrollment', { device_id: 'phone-A' }, auth(invite.token));
  assert.equal(retry.data.expires_at, activated.data.expires_at, 'retry cannot extend collection');
  assert.equal((await call('POST', root + '/enrollment', { device_id: 'phone-B' }, auth(invite.token))).status, 403);
  assert.equal((await call('POST', aware, { device_id: 'phone-B' })).status, 403);
  assert.equal((await call('POST', aware, { device_id: 'phone-A' })).status, 200);
  assert.equal((await call('POST', aware + '/locations/insert', { device_id: 'phone-A', data: JSON.stringify([{ timestamp: 1, device_id: 'phone-B' }]) })).status, 403);
  assert.equal((await call('POST', root + '/sensors/locations/data', { device_id: 'phone-B', rows: [{ timestamp: 1 }] }, auth(invite.token))).status, 403);
  assert.equal((await call('POST', root + '/battery-screenshots', { device_id: 'phone-B' }, auth(invite.token))).status, 403);
  assert.equal((await call('POST', root + '/sensors/locations/data', { device_id: 'phone-A', rows: [{ timestamp: 1 }] }, auth(invite.token))).status, 201);
  assert.equal((await call('POST', root + '/withdrawal', { device_id: 'phone-A', delete_data: false }, auth(invite.token))).status, 200);
  assert.equal((await call('POST', root + '/enrollment', { device_id: 'phone-A' }, auth(invite.token))).status, 403);
  assert.equal((await call('GET', aware + '/esm/config')).status, 403);
  assert.equal((await call('POST', root + '/sensors/locations/data', { device_id: 'phone-A', rows: [{ timestamp: 2 }] }, auth(invite.token))).status, 403);
  await new Promise(resolve => setTimeout(resolve, 20));
  const newInvite = await issue('P1');
  assert.equal((await call('POST', root + '/enrollment', { device_id: 'phone-A' }, auth(newInvite.token))).status, 200);
  assert.equal((await call('POST', root + '/sensors/locations/data', { device_id: 'phone-A', rows: [{ timestamp: 9 }] }, auth(newInvite.token))).status, 201);
  // A queued withdrawal from the old credential cannot revoke or delete the new one.
  assert.equal((await call('POST', root + '/withdrawal', { device_id: 'phone-A', delete_data: true, withdrawn_at: Date.now() }, auth(invite.token))).status, 200);
  assert.equal((await call('GET', root + '/enrollment', null, auth(newInvite.token))).status, 200);
  const preserved = await call('GET', root + '/sensors/locations/latest', null, auth(newInvite.token));
  assert.equal(preserved.data.latest.timestamp, 9, 'old credential cannot delete new enrollment data with a later cutoff');
  await pool.query('UPDATE participant_enrollments SET collection_expires_at = $2 WHERE enrollment_id = $1', [newInvite.enrollment_id, new Date(Date.now() - 1000)]);
  assert.equal((await call('GET', root + '/enrollment', null, auth(newInvite.token))).status, 403);
  assert.equal((await call('POST', root + '/sensors/locations/data', { device_id: 'phone-A', rows: [{ timestamp: 3 }] }, auth(newInvite.token))).status, 403);
  const racing = await issue('P4');
  const race = await Promise.all(['phone-D', 'phone-E'].map(device_id =>
    call('POST', root + '/enrollment', { device_id }, auth(racing.token))));
  assert.deepEqual(race.map(result => result.status).sort(), [200, 403], 'one invitation activates on exactly one device');
  const expired = await issue('P2');
  await pool.query('UPDATE participant_enrollments SET invitation_expires_at = $2 WHERE enrollment_id = $1', [expired.enrollment_id, new Date(Date.now() - 1000)]);
  assert.equal((await call('POST', root + '/enrollment', { device_id: 'phone-C' }, auth(expired.token))).status, 403);
  const revoked = await issue('P3');
  assert.equal((await call('DELETE', root + '/enrollments/' + revoked.enrollment_id, null, researcher)).status, 200);
  assert.equal((await call('POST', root + '/enrollment', { device_id: 'phone-C' }, auth(revoked.token))).status, 403);
  console.log('✓ Consent verification, private invitations, device binding, retries, expiry, withdrawal, revocation, and ingestion isolation');
} finally { server.close(); await pool.end(); }
