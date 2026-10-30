import express from 'express';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { updateStudyConfig } from './db.js';

const keys = ['esm_schedule', 'app_usage_screenshot_schedule', 'battery_screenshot_schedule', 'screen_time_activity_schedule'];
const pilot = JSON.parse(readFileSync(new URL('../presets/pilot-protocol.json', import.meta.url), 'utf8'));
const fail = (message, statusCode = 400) => { const error = new Error(message); error.statusCode = statusCode; throw error; };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const ordinary = s => (!s.studytrace_prompt_type || s.studytrace_prompt_type === 'esm_survey') && !/battery|screen_time_activity|app_usage_screenshot/i.test(s.schedule_id || '');
const kinds = { esm_schedule: 'esm_survey', app_usage_screenshot_schedule: 'app_usage_screenshot', battery_screenshot_schedule: 'battery_usage_screenshot', screen_time_activity_schedule: 'screen_time_activity_screenshot' };
function legacyKind(s) {
  const id = String(s.schedule_id || '').toLowerCase();
  if (s.studytrace_prompt_type === 'app_usage_screenshot' || id.includes('app_usage_screenshot')) return 'app_usage_screenshot_schedule';
  if (s.studytrace_prompt_type === 'screen_time_activity_screenshot' || id.includes('screen_time_activity')) return 'screen_time_activity_schedule';
  if (s.studytrace_prompt_type === 'battery_usage_screenshot' || id.includes('battery')) return 'battery_screenshot_schedule';
  return null;
}

function grouped(config = {}) {
  const result = Object.fromEntries(keys.map(key => [key, key === 'esm_schedule' ? (config[key] || []).filter(ordinary) : [...(config[key] || [])]]));
  for (const s of (config.esm_schedule || []).filter(s => !ordinary(s))) {
    const key = legacyKind(s);
    if (key) result[key].push(s);
  }
  return result;
}

export function scheduleRevision(config = {}) {
  return createHash('sha256').update(JSON.stringify(keys.map(key => config[key] || []))).digest('hex');
}

export function promptScheduleResponse(study) {
  const config = study.config || {};
  return { ok: true, study_id: study.study_id, revision: scheduleRevision(config),
    ...grouped(config),
    unmanaged_count: (config.esm_schedule || []).filter(s => !ordinary(s) && !legacyKind(s)).length,
    previous_configuration: config.previous_prompt_schedules || null,
    context_questions_enabled: config.environment_collection?.enabled === true && config.environment_collection?.context_questions_enabled === true };
}

function time(value, label) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) fail(`${label}: use a valid 24-hour HH:MM time.`);
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}

function date(value, label) {
  if (value === '' || value === undefined) return null;
  if (typeof value !== 'string' || !/^\d{2}-\d{2}-\d{4}$/.test(value)) fail(`${label}: use MM-DD-YYYY or leave blank.`);
  const [month, day, year] = value.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (year < 2020 || year > 2100 || d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) fail(`${label}: invalid calendar date.`);
  return d.getTime();
}

export function validatePromptSchedules(body, study) {
  if (!object(body) || keys.some(key => !Array.isArray(body[key]))) fail('Supply all four schedule arrays.');
  if (JSON.stringify(body).length > 512000) fail('Schedule configuration is too large.', 413);
  if (keys.reduce((n, key) => n + body[key].length, 0) > 30) fail('Use at most 30 schedule entries.');
  const currentIds = new Set(keys.flatMap(key => (study.config?.[key] || []).map(s => s.schedule_id)));
  const prefix = `st_${createHash('sha256').update(study.study_id).digest('hex').slice(0, 12)}_`;
  const ids = new Set();
  function validate(raw, index, key) {
    const screenshot = key !== 'esm_schedule';
    const type = kinds[key];
    const label = `${screenshot ? 'Screenshot' : 'Questionnaire'} ${index + 1}`;
    if (!object(raw)) fail(`${label}: schedule must be an object.`);
    const s = structuredClone(raw);
    if (typeof s.schedule_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(s.schedule_id)) fail(`${label}: invalid schedule ID.`);
    if (!currentIds.has(s.schedule_id) && !s.schedule_id.startsWith(prefix)) s.schedule_id = prefix + s.schedule_id;
    if (ids.has(s.schedule_id)) fail(`${label}: schedule IDs must be unique.`);
    ids.add(s.schedule_id);
    if (screenshot ? legacyKind(s) !== key : !ordinary(s)) fail(`${label}: schedule ID/type would open the wrong task on a phone.`);
    s.studytrace_prompt_type = type;
    // Early AWARE configurations stored whole hours without a times array.
    if ((!Array.isArray(s.times) || !s.times.length) && Array.isArray(s.hours)) s.times = s.hours.map(h => `${String(h).padStart(2, '0')}:00`);
    if (!Array.isArray(s.times) || !s.times.length || s.times.length > 24) fail(`${label}: provide 1–24 daily times.`);
    const minutes = s.times.map(t => time(t, label));
    if (new Set(minutes).size !== minutes.length) fail(`${label}: daily times must be distinct.`);
    if (!Number.isInteger(s.randomize) || s.randomize < 0 || s.randomize > 180) fail(`${label}: randomization must be 0–180 minutes for current phones.`);
    if (!Number.isInteger(s.expiration) || s.expiration < 0 || s.expiration > 1440) fail(`${label}: response window must be 0–1440 minutes.`);
    const start = s.studytrace_window_start || '', end = s.studytrace_window_end || '';
    if (Boolean(start) !== Boolean(end)) fail(`${label}: specify both delivery-window bounds or leave both blank.`);
    const lo = start ? time(start, label) : 0, hi = end ? time(end, label) : 1439;
    if (lo >= hi) fail(`${label}: window end must be later than its start on the same day.`);
    if (minutes.some(m => m - s.randomize < lo || m + s.randomize > hi)) fail(`${label}: planned times and randomization must fit inside the delivery window.`);
    const begin = date(s.start_date, label), finish = date(s.end_date, label);
    if (begin !== null && finish !== null && begin > finish) fail(`${label}: end date precedes start date.`);
    if (!Array.isArray(s.esms) || !s.esms.length || s.esms.length > 100) fail(`${label}: provide 1–100 questions.`);
    if (type === 'app_usage_screenshot' && (s.esms.length !== 1 || Number(s.esms[0]?.esm?.esm_type) !== 14)) fail(`${label}: app-usage requests need one photo task.`);
    const questionIds = new Set();
    for (const [i, wrapper] of s.esms.entries()) {
      const q = wrapper?.esm;
      if (!object(q) || !Number.isInteger(q.esm_type) || q.esm_type < 1 || q.esm_type > 14) fail(`${label}, question ${i + 1}: invalid question type.`);
      if (typeof q.esm_title !== 'string' || !q.esm_title.trim() || typeof q.esm_instructions !== 'string') fail(`${label}, question ${i + 1}: enter a title and instructions.`);
      if (typeof q.esm_trigger !== 'string' || !q.esm_trigger.trim() || questionIds.has(q.esm_trigger)) fail(`${label}, question ${i + 1}: item IDs must be present and unique within this questionnaire.`);
      questionIds.add(q.esm_trigger);
      if (q.esm_type === 2 && (!Array.isArray(q.esm_radios) || !q.esm_radios.length || q.esm_radios.some(v => typeof v !== 'string' || !v.trim()))) fail(`${label}, question ${i + 1}: enter nonempty answer choices.`);
    }
    if (type === 'app_usage_screenshot' && s.esms[0].esm.esm_trigger !== 'app_usage_screenshot') fail(`${label}: preserve the app_usage_screenshot task identifier.`);
    s.hours = [...new Set(minutes.map(m => Math.floor(m / 60)))];
    return s;
  }
  return Object.fromEntries(keys.map(key => [key, body[key].map((s, i) => validate(s, i, key))]));
}

export function createPromptScheduleRouter({ requireResearcher }) {
  const router = express.Router();
  router.get('/studies/:studyId/prompt-schedules', requireResearcher, (req, res) => res.json(promptScheduleResponse(req.study)));
  router.get('/studies/:studyId/prompt-schedule-preset', requireResearcher, (req, res) => res.json({ ok: true, label: 'Three questionnaires + one evening screenshot', ...structuredClone(pilot) }));
  router.put('/studies/:studyId/prompt-schedules', requireResearcher, async (req, res, next) => {
    try {
      if (typeof req.body?.expected_revision !== 'string') fail('Reload schedules before saving; a revision is required.', 409);
      const updated = await updateStudyConfig(req.params.studyId, current => {
        if (scheduleRevision(current.config) !== req.body.expected_revision) fail('Schedules changed in another window. Export your draft, reload schedules, then review before saving again.', 409);
        const patch = validatePromptSchedules(req.body, current);
        const embedded = (current.config?.esm_schedule || []).filter(s => !ordinary(s) && !legacyKind(s));
        patch.esm_schedule.push(...embedded);
        return { ...patch, dashboard_schedules_version: 1,
          previous_prompt_schedules: { ...grouped(current.config), saved_at: new Date().toISOString() } };
      });
      if (!updated) return res.status(404).json({ error: 'study not found' });
      res.json(promptScheduleResponse(updated));
    } catch (error) { next(error); }
  });
  return router;
}
