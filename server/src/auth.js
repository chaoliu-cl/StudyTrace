// Credential helpers shared by every front-end.
//
// Two credentials exist per study:
//   - the participant (study) password, embedded in the join URL/QR that every
//     phone receives. It only authorizes ingestion (join, insert, latest,
//     screenshot upload, withdrawal) for the caller's own device.
//   - the researcher password, which authorizes dashboards, exports, media,
//     schedule edits, and deletions. It is never given to participants.
// Both are stored as scrypt hashes; plaintext is never persisted.

import crypto from 'node:crypto';

const SCRYPT_KEYLEN = 32;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const HASH_PREFIX = 'scrypt';

export function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(secret), salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return [HASH_PREFIX, SCRYPT_PARAMS.N, SCRYPT_PARAMS.r, SCRYPT_PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

// scrypt is deliberately slow (~50 ms). AWARE clients authenticate on every
// upload request, so successful verifications are memoized. The cache key
// includes the stored hash, so rotating a password invalidates old entries.
const verifiedCache = new Map();
const VERIFIED_CACHE_MAX = 1000;

export function verifySecret(secret, stored) {
  if (typeof secret !== 'string' || !secret || typeof stored !== 'string' || !stored) return false;
  const cacheKey = `${stored}\u0000${sha256(secret)}`;
  if (verifiedCache.has(cacheKey)) return true;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== HASH_PREFIX) return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  let actual;
  try {
    actual = crypto.scryptSync(secret, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
  } catch {
    return false;
  }
  const ok = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  if (ok) {
    if (verifiedCache.size >= VERIFIED_CACHE_MAX) {
      verifiedCache.delete(verifiedCache.keys().next().value);
    }
    verifiedCache.set(cacheKey, true);
  }
  return ok;
}

// Constant-time comparison for plain secrets such as ADMIN_TOKEN.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return crypto.timingSafeEqual(Buffer.from(sha256(a), 'hex'), Buffer.from(sha256(b), 'hex'));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// ---- Failed-attempt limiter -------------------------------------------------
// In-memory, per client IP. Only failed credential checks count, so shared
// campus NAT addresses are not penalized for legitimate traffic.
const FAILURE_WINDOW_MS = Number(process.env.AUTH_FAILURE_WINDOW_MS) || 15 * 60 * 1000;
const FAILURE_MAX = Number(process.env.AUTH_FAILURE_MAX) || 30;
const failures = new Map();

function failureKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

export function isRateLimited(req) {
  const entry = failures.get(failureKey(req));
  if (!entry) return false;
  if (Date.now() - entry.start > FAILURE_WINDOW_MS) {
    failures.delete(failureKey(req));
    return false;
  }
  return entry.count >= FAILURE_MAX;
}

export function recordAuthFailure(req) {
  const key = failureKey(req);
  const now = Date.now();
  const entry = failures.get(key);
  if (!entry || now - entry.start > FAILURE_WINDOW_MS) {
    failures.set(key, { start: now, count: 1 });
  } else {
    entry.count += 1;
  }
  if (failures.size > 10000) {
    for (const [k, v] of failures) {
      if (now - v.start > FAILURE_WINDOW_MS) failures.delete(k);
    }
  }
}

export function sendRateLimited(res) {
  res.setHeader('Retry-After', String(Math.ceil(FAILURE_WINDOW_MS / 1000)));
  return res.status(429).json({ error: 'too many failed authentication attempts; try again later' });
}

// ---- Credential extraction --------------------------------------------------
function bearerToken(req) {
  const auth = req.get('authorization');
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return '';
}

export function participantPasswordFrom(req) {
  return (req.get('x-study-password') || '').trim() || bearerToken(req);
}

export function researcherPasswordFrom(req) {
  return (req.get('x-researcher-password') || '').trim() || bearerToken(req);
}

export function studyAcceptsParticipantPassword(study, password) {
  return Boolean(study && verifySecret(password, study.password_hash));
}

export function studyAcceptsResearcherPassword(study, password) {
  return Boolean(study && verifySecret(password, study.researcher_password_hash));
}

export const MIN_RESEARCHER_PASSWORD_LENGTH = 12;
