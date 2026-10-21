import crypto from 'node:crypto';
import { parse } from 'node:querystring';
import { getPool } from './db.js';
import { buildJoinLink } from './joinLink.js';

const DAY = 86400000;
const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
const validToken = token => typeof token === 'string' && /^pi_[a-f0-9]{64}$/.test(token);
const invalid = message => Object.assign(new Error(message), { statusCode: 400 });

export async function issueInvitation(studyId, body, base) {
  const fields = ['participant', 'consent_version', 'consent_reference', 'verified_by'];
  if (body?.consent_verified !== true && body?.consent_verified !== 'on') {
    throw invalid('Confirm that completed adult study consent has been verified.');
  }
  for (const field of fields) {
    if (typeof body[field] !== 'string' || !body[field].trim() || body[field].length > 128) {
      throw invalid(`${field} is required (maximum 128 characters).`);
    }
  }
  if (typeof body.consented_at !== 'string' || !body.consented_at.trim()) throw invalid('consented_at is required.');
  const consentedAt = new Date(body.consented_at);
  const now = new Date();
  if (!Number.isFinite(consentedAt.getTime()) || consentedAt > now) throw invalid('consented_at must be a past consent date.');
  const pending = await getPool().query(`SELECT enrollment_id FROM participant_enrollments
    WHERE study_id = $1 AND participant = $2 AND revoked_at IS NULL`, [studyId, body.participant.trim()]);
  if (pending.rows.length) throw Object.assign(new Error('Revoke the previous invitation before issuing another for this participant.'), { statusCode: 409 });
  const token = `pi_${crypto.randomBytes(32).toString('hex')}`;
  const id = crypto.randomUUID();
  const invitationExpires = new Date(now.getTime() + 7 * DAY);
  await getPool().query(`INSERT INTO participant_enrollments
    (enrollment_id, study_id, participant, consent_version, consent_reference, consented_at,
     verified_at, verified_by, token_hash, invitation_expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
  [id, studyId, body.participant.trim(), body.consent_version.trim(), body.consent_reference.trim(),
    consentedAt, now, body.verified_by.trim(), tokenHash(token), invitationExpires]);
  return { ok: true, enrollment_id: id, invitation_expires_at: invitationExpires.toISOString(),
    ...buildJoinLink(base, studyId, token, body.participant.trim()) };
}

export async function activateEnrollment(studyId, token, deviceId) {
  if (!validToken(token) || typeof deviceId !== 'string' || !deviceId || deviceId.length > 128) return null;
  const now = new Date();
  // One atomic update binds the first device. A retry from that same device
  // returns the original deadline and never extends the collection period.
  let result;
  try {
    result = await getPool().query(`UPDATE participant_enrollments
    SET device_id = $3, activated_at = COALESCE(activated_at, $4),
        collection_expires_at = COALESCE(collection_expires_at, $5)
    WHERE study_id = $1 AND token_hash = $2 AND revoked_at IS NULL
      AND ((device_id IS NULL AND invitation_expires_at > $4) OR device_id = $3)
      AND (collection_expires_at IS NULL OR collection_expires_at > $4)
    RETURNING *`, [studyId, tokenHash(token), deviceId, now, new Date(now.getTime() + 28 * DAY)]);
  } catch (err) {
    // A different active participant already owns this device in this study.
    if (err.code === '23505') return null;
    throw err;
  }
  return result.rows[0] || null;
}

export async function participantAccess(studyId, token, deviceId, { allowInactive = false } = {}) {
  if (!validToken(token)) return null;
  const { rows } = await getPool().query(`SELECT * FROM participant_enrollments
    WHERE study_id = $1 AND token_hash = $2`, [studyId, tokenHash(token)]);
  const enrollment = rows[0];
  if (!enrollment?.device_id || (deviceId && deviceId !== enrollment.device_id)) return null;
  if (!allowInactive && (enrollment.revoked_at || new Date(enrollment.collection_expires_at).getTime() <= Date.now())) return null;
  return enrollment;
}

export function publicEnrollment(row) {
  return { participant: row.participant, consent_version: row.consent_version,
    expires_at: new Date(row.collection_expires_at).toISOString() };
}

export function requestDeviceId(req) {
  if (typeof req.body === 'string') req.body = parse(req.body);
  return req.body?.device_id || req.query.device_id || req.get('x-device-id') || null;
}

export function rowsMatchDevice(rows, deviceId) {
  return Array.isArray(rows) && rows.every(row => row && typeof row === 'object'
    && (!row.device_id || row.device_id === deviceId));
}

export async function revokeDeviceEnrollment(studyId, deviceId) {
  await getPool().query(`UPDATE participant_enrollments SET revoked_at = $3
    WHERE study_id = $1 AND device_id = $2 AND revoked_at IS NULL`, [studyId, deviceId, new Date()]);
}
