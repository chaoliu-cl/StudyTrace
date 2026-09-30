// Local-time helpers for derived exports.
//
// Participants live in different time zones (and travel), so "a day" for
// location summaries and survey compliance must be the participant's local
// calendar day, not a UTC day. The iOS client stamps every telemetry row with
// its IANA time zone; these helpers turn that into a per-device timeline and
// resolve the zone in effect at any timestamp.

const formatterCache = new Map();

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim()) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

function formatterFor(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(timeZone, new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }));
  }
  return formatterCache.get(timeZone);
}

// YYYY-MM-DD of `timestampMs` in `timeZone` (falls back to UTC).
export function localDateFor(timestampMs, timeZone) {
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const parts = formatterFor(zone).formatToParts(new Date(timestampMs));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Study-level default when a device has not reported a zone yet.
export function defaultTimeZoneForStudy(study) {
  const configured = study?.config?.timezone;
  if (isValidTimeZone(configured)) return configured;
  if (isValidTimeZone(process.env.DEFAULT_STUDY_TIMEZONE)) return process.env.DEFAULT_STUDY_TIMEZONE;
  return 'UTC';
}

// Build a resolver from telemetry rows ({ study_id, device_id, timestamp,
// data: { timezone } }). resolve(studyId, deviceId, timestampMs) returns the
// zone reported most recently at or before the timestamp, else the earliest
// zone reported afterwards, else the study default.
export function buildTimeZoneResolver(telemetryRows, defaultForStudy = () => 'UTC') {
  const timelines = new Map();
  for (const row of telemetryRows || []) {
    const zone = row?.data?.timezone;
    const ts = Number(row?.timestamp ?? row?.data?.timestamp);
    if (!isValidTimeZone(zone) || !Number.isFinite(ts)) continue;
    const key = `${row.study_id}::${row.device_id}`;
    if (!timelines.has(key)) timelines.set(key, []);
    timelines.get(key).push({ ts, zone });
  }
  for (const timeline of timelines.values()) timeline.sort((a, b) => a.ts - b.ts);

  return function resolve(studyId, deviceId, timestampMs) {
    const timeline = timelines.get(`${studyId}::${deviceId}`);
    if (!timeline || !timeline.length) return defaultForStudy(studyId);
    let lo = 0;
    let hi = timeline.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (timeline[mid].ts <= timestampMs) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return timeline[found >= 0 ? found : 0].zone;
  };
}

// Minutes the zone is ahead of UTC at `timestampMs` (e.g. -240 for EDT).
export function utcOffsetMinutes(timestampMs, timeZone) {
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(timestampMs));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(timestampMs / 1000) * 1000) / 60000);
}

// Epoch ms of local midnight starting `date` (YYYY-MM-DD) in `timeZone`.
export function localMidnight(date, timeZone) {
  const [year, month, day] = String(date).split('-').map(Number);
  const utcMidnight = Date.UTC(year, month - 1, day);
  let guess = utcMidnight - utcOffsetMinutes(utcMidnight, timeZone) * 60000;
  // Re-check once in case the offset differs at the guessed instant (DST).
  guess = utcMidnight - utcOffsetMinutes(guess, timeZone) * 60000;
  return guess;
}

export function nextDate(date) {
  const [year, month, day] = String(date).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}
