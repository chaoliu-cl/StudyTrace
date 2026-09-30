const page = document.body.dataset.page;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fmtDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function renderMetricCards(container, metrics) {
  container.innerHTML = metrics.map(({ label, value }) => `
    <dl class="metric-card">
      <dt>${escapeHtml(label)}</dt>
      <dd>${escapeHtml(value)}</dd>
    </dl>
  `).join('');
}

function renderTable(container, columns, rows) {
  const head = columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join('');
  const body = rows.map((row) => `
    <tr>
      ${columns.map((column) => `<td>${column.render(row)}</td>`).join('')}
    </tr>
  `).join('');
  container.innerHTML = `
    <thead><tr>${head}</tr></thead>
    <tbody>${body || `<tr><td colspan="${columns.length}">No records yet.</td></tr>`}</tbody>
  `;
}

function setMessage(node, message, isError = false) {
  node.textContent = message;
  node.style.color = isError ? '#a12424' : '';
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text || `HTTP ${res.status}` };
  }
}

function downloadUrl(path, headers) {
  return fetch(path, { headers })
    .then(async (res) => {
      if (!res.ok) throw new Error((await readJson(res)).error || `HTTP ${res.status}`);
      return res.blob();
    })
    .then((blob) => URL.createObjectURL(blob));
}

function parseEsmJson(row) {
  const raw = row?.data?.esm_json;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function isPictureEsmRow(row) {
  return Number(parseEsmJson(row).esm_type) === 14;
}

function looksLikeImageAnswer(answer) {
  if (typeof answer !== 'string') return false;
  const value = answer.trim();
  return value.startsWith('iVBORw0KGgo') || value.startsWith('/9j/') || /^data:image\/(?:png|jpeg);base64,/i.test(value);
}

function renderEsmAnswer(row, studyId) {
  const answer = row?.data?.esm_user_answer;
  if ((isPictureEsmRow(row) || looksLikeImageAnswer(answer)) && typeof answer === 'string' && answer.trim()) {
    const sensor = row.sensor || 'esms';
    const imageUrl = `/api/v1/studies/${encodeURIComponent(studyId)}/media/${encodeURIComponent(sensor)}/${encodeURIComponent(row.id)}/image`;
    return `
      <div class="photo-answer">
        <img data-src="${imageUrl}" alt="Photo response" loading="lazy" data-auth-image>
        <a href="${imageUrl}" data-download-image data-filename="studytrace-esm-${escapeHtml(row.id)}.png">Download image</a>
      </div>
    `;
  }
  if (answer === null || answer === undefined || answer === '') return '—';
  const text = typeof answer === 'object' ? JSON.stringify(answer) : String(answer);
  return `<span class="answer-text">${escapeHtml(text)}</span>`;
}

async function loadEsmResponses({ studyId, password, sensors, table, message }) {
  const headers = { 'x-researcher-password': password };
  const res = await fetch(`/api/v1/studies/${encodeURIComponent(studyId)}/dashboard/esm-responses?limit=50`, { headers });
  const payload = await readJson(res);
  if (!res.ok) {
    return setMessage(message, payload.error || 'Could not load survey responses.', true);
  }

  renderTable(table, [
    { label: 'Time', render: (row) => fmtDate((row.timestamp || 0) * 1000 || row.created_at) },
    { label: 'Question', render: (row) => escapeHtml(parseEsmJson(row).esm_title || row.data?.esm_trigger || '—') },
    { label: 'Participant', render: (row) => escapeHtml(row.device_id || '—') },
    { label: 'Sensor', render: (row) => escapeHtml(row.sensor || '—') },
    { label: 'Answer', render: (row) => renderEsmAnswer(row, studyId) },
  ], payload.rows || []);

  await hydrateAuthenticatedImages(table, password);
}

async function loadBatteryUsageDiagnostics({ studyId, password, appTable, screenshotTable, message }) {
  const headers = { 'x-researcher-password': password };
  const res = await fetch(`/api/v1/studies/${encodeURIComponent(studyId)}/dashboard/battery-usage?limit=100`, { headers });
  const payload = await readJson(res);
  if (!res.ok) {
    return setMessage(message, payload.error || 'Could not load Battery screenshot extraction.', true);
  }

  renderTable(appTable, [
    { label: 'App', render: (row) => escapeHtml(row.app_name || '—') },
    { label: 'Screen time', render: (row) => row.screen_time_seconds ? formatDuration(row.screen_time_seconds) : escapeHtml(row.screen_time_text || '—') },
    { label: 'Battery', render: (row) => row.battery_percent !== null && row.battery_percent !== undefined && row.battery_percent !== '' ? `${escapeHtml(row.battery_percent)}%` : '—' },
    { label: 'Status', render: (row) => escapeHtml(row.extraction_status || '—') },
    { label: 'Needs review', render: (row) => row.needs_review ? 'Yes' : 'No' },
    { label: 'QA reason', render: (row) => escapeHtml(row.qa_reason || '—') },
    { label: 'Method', render: (row) => escapeHtml(row.extraction_method || '—') },
    { label: 'Participant', render: (row) => escapeHtml(row.device_id || '—') },
    { label: 'Time', render: (row) => fmtDate((row.timestamp || 0) * 1000 || row.created_at) },
  ], payload.appRows || []);

  renderTable(screenshotTable, [
    { label: 'Time', render: (row) => fmtDate((row.timestamp || 0) * 1000 || row.created_at) },
    { label: 'Participant', render: (row) => escapeHtml(row.device_id || '—') },
    { label: 'Sensor', render: (row) => escapeHtml(row.sensor || '—') },
    { label: 'Question', render: (row) => escapeHtml(parseEsmJson(row).esm_title || row.data?.esm_trigger || 'Battery screenshot') },
    { label: 'Screenshot', render: (row) => renderEsmAnswer(row, studyId) },
  ], payload.screenshotRows || []);

  await hydrateAuthenticatedImages(screenshotTable, password);
}

async function loadScreenTimeActivity({ studyId, password, table, message }) {
  const res = await fetch(`/api/v1/studies/${encodeURIComponent(studyId)}/dashboard/screen-time-activity?limit=200`, {
    headers: { 'x-researcher-password': password },
  });
  const payload = await readJson(res);
  if (!res.ok) {
    return setMessage(message, payload.error || 'Could not load Screen Time activity screenshots.', true);
  }
  renderTable(table, [
    { label: 'Day', render: (row) => escapeHtml(row.activity_date || '—') },
    { label: 'Participant', render: (row) => escapeHtml(row.device_id || '—') },
    { label: 'Row', render: (row) => escapeHtml(row.row_type === 'summary' ? 'Daily total' : row.app_name || '—') },
    { label: 'Screen time', render: (row) => formatDuration(row.row_type === 'summary' ? row.total_screen_time_seconds : row.screen_time_seconds) },
    { label: 'Pickups', render: (row) => row.pickups ?? '—' },
    { label: 'Notifications', render: (row) => row.notifications ?? '—' },
    { label: 'Source', render: (row) => escapeHtml(row.extraction_method === 'participant_confirmed' ? (row.participant_edited ? 'Participant (edited)' : 'Participant') : 'Server OCR') },
    { label: 'Needs review', render: (row) => row.needs_review ? 'Yes' : 'No' },
  ], payload.rows || []);
}

async function loadParticipantHealth({ studyId, password, table, message }) {
  const headers = { 'x-researcher-password': password };
  const res = await fetch(`/api/v1/studies/${encodeURIComponent(studyId)}/dashboard/participant-health`, { headers });
  const payload = await readJson(res);
  if (!res.ok) {
    return setMessage(message, payload.error || 'Could not load participant health.', true);
  }

  renderTable(table, [
    { label: 'Status', render: (row) => row.health_status === 'ok' ? 'OK' : 'Needs attention' },
    { label: 'Participant', render: (row) => escapeHtml(row.participant || row.device_id || '—') },
    { label: 'Last seen', render: (row) => fmtDate(row.last_seen) },
    { label: 'Last heartbeat', render: (row) => fmtDate(row.last_heartbeat) },
    { label: 'Longest gap 24h', render: (row) => row.max_telemetry_gap_hours_24h !== '' && row.max_telemetry_gap_hours_24h !== undefined ? `${escapeHtml(row.max_telemetry_gap_hours_24h)} h` : '—' },
    { label: 'Compliance 7d', render: (row) => row.compliance_rate_7d !== '' && row.compliance_rate_7d !== undefined ? `${Math.round(Number(row.compliance_rate_7d) * 100)}% (${escapeHtml(row.survey_sessions_7d)}/${escapeHtml(row.prompts_delivered_7d)})` : '—' },
    { label: 'Notifications', render: (row) => escapeHtml(row.notification_authorization || '—') },
    { label: 'Location', render: (row) => escapeHtml([row.location_authorization, row.location_accuracy_authorization].filter(Boolean).join(' / ') || '—') },
    { label: 'Background refresh', render: (row) => escapeHtml(row.background_refresh_status || '—') },
    { label: 'Time zone', render: (row) => escapeHtml(row.timezone || '—') },
    { label: 'Battery', render: (row) => row.battery_level !== '' && row.battery_level !== undefined ? `${Math.round(Number(row.battery_level) * 100)}%` : '—' },
    { label: 'GPS rows', render: (row) => String(row.location_rows || 0) },
    { label: 'ESM rows', render: (row) => String(row.esm_rows || 0) },
    { label: 'Battery screenshots', render: (row) => String(row.battery_screenshot_rows || 0) },
    { label: 'Upload failures 24h', render: (row) => String(row.upload_failures_24h || 0) },
    { label: 'Notes', render: (row) => escapeHtml(row.notes || '—') },
  ], payload.rows || []);
}

async function loadPhoneUseDaily({ studyId, password, table, message }) {
  const res = await fetch(`/api/v1/studies/${encodeURIComponent(studyId)}/dashboard/phone-use-daily?limit=200`, {
    headers: { 'x-researcher-password': password },
  });
  const payload = await readJson(res);
  if (!res.ok) {
    return setMessage(message, payload.error || 'Could not load daily phone use.', true);
  }
  renderTable(table, [
    { label: 'Date', render: (row) => escapeHtml(row.date || '—') },
    { label: 'Participant', render: (row) => escapeHtml(row.device_id || '—') },
    { label: 'Platform', render: (row) => escapeHtml(row.platform || '—') },
    { label: 'Pickups', render: (row) => escapeHtml(row.pickups ?? 0) },
    { label: 'Use', render: (row) => formatDuration(row.total_use_seconds) },
    { label: 'Sessions', render: (row) => escapeHtml(row.session_count ?? 0) },
    { label: 'Median session', render: (row) => row.median_session_seconds === '' ? '—' : `${escapeHtml(row.median_session_seconds)} s` },
    { label: 'Under 1 min', render: (row) => row.short_session_share === '' ? '—' : `${Math.round(Number(row.short_session_share) * 100)}%` },
    { label: 'Night use', render: (row) => formatDuration(row.night_use_seconds) },
  ], payload.rows || []);
}

async function loadLocationDailySummary({ studyId, password, table, message }) {
  const headers = { 'x-researcher-password': password };
  const res = await fetch(`/api/v1/studies/${encodeURIComponent(studyId)}/dashboard/location-daily-summary?limit=100`, { headers });
  const payload = await readJson(res);
  if (!res.ok) {
    return setMessage(message, payload.error || 'Could not load location summaries.', true);
  }

  renderTable(table, [
    { label: 'Date', render: (row) => escapeHtml(row.date || '—') },
    { label: 'Participant', render: (row) => escapeHtml(row.device_id || '—') },
    { label: 'Rows', render: (row) => String(row.location_rows || 0) },
    { label: 'Coverage', render: (row) => `${escapeHtml(row.coverage_minutes ?? 0)} min` },
    { label: 'Distance', render: (row) => `${escapeHtml(row.distance_meters ?? 0)} m` },
    { label: 'Radius', render: (row) => `${escapeHtml(row.radius_of_gyration_meters ?? 0)} m` },
    { label: 'Stops', render: (row) => String(row.stop_count || 0) },
    { label: 'Mean accuracy', render: (row) => row.mean_accuracy_meters !== '' && row.mean_accuracy_meters !== undefined ? `${escapeHtml(row.mean_accuracy_meters)} m` : '—' },
  ], payload.rows || []);
}

async function loadSurveyQuality({ studyId, password, table, message }) {
  const headers = { 'x-researcher-password': password };
  const res = await fetch(`/api/v1/studies/${encodeURIComponent(studyId)}/dashboard/survey-quality?limit=100`, { headers });
  const payload = await readJson(res);
  if (!res.ok) {
    return setMessage(message, payload.error || 'Could not load survey quality.', true);
  }

  renderTable(table, [
    { label: 'Submitted', render: (row) => fmtDate(row.submitted_at || ((row.timestamp || 0) * 1000 || row.created_at)) },
    { label: 'Participant', render: (row) => escapeHtml(row.device_id || '—') },
    { label: 'Question', render: (row) => escapeHtml(row.question_title || row.question_trigger || '—') },
    { label: 'Answered', render: (row) => row.answered ? 'Yes' : 'No' },
    { label: 'Answer kind', render: (row) => escapeHtml(row.answer_kind || '—') },
    { label: 'Latency', render: (row) => row.response_latency_seconds !== null && row.response_latency_seconds !== undefined ? `${escapeHtml(row.response_latency_seconds)}s` : '—' },
    { label: 'Flags', render: (row) => escapeHtml(row.quality_flags || '—') },
  ], payload.rows || []);
}

const defaultEsmSurveyQuestions = [
  {
    esm_type: 2,
    esm_title: 'Current activity',
    esm_instructions: 'What are you doing right now?',
    esm_radios: ['Working or studying', 'Resting', 'Commuting', 'Socializing', 'Other'],
    esm_trigger: 'current_activity',
    esm_submit: 'Next',
    esm_na: true,
    studytrace_required: true,
    studytrace_randomize_options: false,
    studytrace_branching: {},
  },
];

const defaultBatteryScreenshotQuestions = [
  {
    esm_type: 14,
    esm_title: 'Battery usage screenshot',
    esm_instructions: 'Open iPhone Settings > Battery > View All Battery Usage. Take a screenshot showing app battery usage and screen time, then upload that screenshot here.',
    esm_trigger: 'battery_usage_screenshot',
    esm_submit: 'Submit',
    esm_na: true,
    studytrace_required: true,
    studytrace_quality_check: 'ocr_review',
  },
];

const defaultScreenTimeActivityQuestions = [
  {
    esm_type: 14,
    esm_title: 'Screen Time activity screenshot',
    esm_instructions: 'Open iPhone Settings > Screen Time > See All App & Website Activity, choose Day, tap yesterday, and take a screenshot showing screen time, pickups, and notifications. Then upload that screenshot here.',
    esm_trigger: 'screen_time_activity_screenshot',
    esm_submit: 'Submit',
    esm_na: true,
    studytrace_required: true,
    studytrace_quality_check: 'participant_confirmed',
  },
];

const promptDefaults = {
  esm_survey: { times: '09:30, 17:15', title: 'StudyTrace survey available', body: 'Please complete your scheduled study survey.' },
  battery_usage_screenshot: { times: '20:30', title: 'StudyTrace Battery screenshot', body: 'Please upload your iOS Battery usage screenshot.' },
  screen_time_activity_screenshot: { times: '10:00', title: 'StudyTrace Screen Time screenshot', body: "Please upload yesterday's Screen Time activity screenshot." },
};

function defaultQuestionsForPrompt(promptType) {
  if (promptType === 'esm_survey') return defaultEsmSurveyQuestions;
  if (promptType === 'screen_time_activity_screenshot') return defaultScreenTimeActivityQuestions;
  return defaultBatteryScreenshotQuestions;
}

function unwrapEsmQuestions(esms, promptType) {
  return (Array.isArray(esms) && esms.length ? esms : defaultQuestionsForPrompt(promptType))
    .map((item) => item?.esm || item);
}

function findScheduleForPrompt(schedule, promptType) {
  if (!Array.isArray(schedule)) return null;
  return schedule.find((item) => item.studytrace_prompt_type === promptType) ||
    schedule.find((item) => promptType === 'battery_usage_screenshot' && String(item.schedule_id || '').includes('battery_screenshot')) ||
    schedule.find((item) => promptType === 'esm_survey' && String(item.schedule_id || '').includes('esm_survey')) ||
    schedule.find((item) => promptType === 'screen_time_activity_screenshot' && String(item.schedule_id || '').includes('screen_time_activity')) ||
    null;
}

function fillScheduleForm(form, schedule, promptType) {
  const item = findScheduleForPrompt(schedule, promptType);
  form.elements.mode.value = item?.studytrace_delivery_mode || (Number(item?.randomize || 0) > 0 ? 'random' : 'fixed');
  form.elements.times.value = Array.isArray(item?.times) && item.times.length
    ? item.times.join(', ')
    : (Array.isArray(item?.hours) ? item.hours.map((hour) => `${String(hour).padStart(2, '0')}:00`).join(', ') : promptDefaults[promptType].times);
  form.elements.randomize_minutes.value = String(item?.randomize || 30);
  form.elements.expiration_minutes.value = String(item?.expiration || 120);
  form.elements.notification_title.value = item?.notification_title || promptDefaults[promptType].title;
  form.elements.notification_body.value = item?.notification_body || promptDefaults[promptType].body;
  form.elements.start_date.value = item?.start_date || '';
  form.elements.end_date.value = item?.end_date || '';
  if (form.elements.esms_json) {
    form.elements.esms_json.value = JSON.stringify(unwrapEsmQuestions(item?.esms, promptType), null, 2);
  }
}

async function loadScheduleSection({ studyId, password, form, result, message, promptType, endpoint }) {
  const res = await fetch(`/api/v1/studies/${encodeURIComponent(studyId)}/${endpoint}`, {
    headers: { 'x-researcher-password': password },
  });
  const payload = await readJson(res);
  if (!res.ok) {
    setMessage(message, payload.error || 'Could not load survey delivery schedule.', true);
    return;
  }
  fillScheduleForm(form, payload.esm_schedule || [], promptType);
  result.textContent = JSON.stringify(payload.schedule_summary || [], null, 2);
}

async function saveScheduleSection({ studyId, password, form, result, message, promptType, label, endpoint }) {
  const formData = new FormData(form);
  const body = Object.fromEntries(formData.entries());
  body.prompt_type = promptType;
  if (!body.esms_json) body.esms = defaultQuestionsForPrompt(promptType);
  const res = await fetch(`/api/v1/studies/${encodeURIComponent(studyId)}/${endpoint}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'x-researcher-password': password,
    },
    body: JSON.stringify(body),
  });
  const payload = await readJson(res);
  result.textContent = JSON.stringify(payload.schedule_summary || payload, null, 2);
  if (!res.ok) {
    setMessage(message, payload.error || `Could not save ${label} schedule.`, true);
    return false;
  }
  result.textContent = JSON.stringify(payload.schedule_summary || [], null, 2);
  setMessage(message, `${label} schedule saved. Ask participants to open StudyTrace once so the phone refreshes the new notification schedule.`);
  return true;
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || seconds === '') return '—';
  const minutes = Math.round(Number(seconds || 0) / 60);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours > 0 ? `${hours}h ${remainder}m` : `${minutes}m`;
}

function truncate(value, maxLength) {
  const text = String(value ?? '');
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

async function hydrateAuthenticatedImages(container, password) {
  const images = [...container.querySelectorAll('[data-auth-image]')];
  await Promise.all(images.map(async (img) => {
    try {
      const url = await downloadUrl(img.dataset.src, { 'x-researcher-password': password });
      img.src = url;
    } catch {
      img.replaceWith(document.createTextNode('Image unavailable'));
    }
  }));
}

// Optional question templates (assets/survey-templates.json), appended to
// the ESM survey question JSON on request.
async function setupTemplatePicker({ select, button, source, textarea, message }) {
  let templates = [];
  try {
    const res = await fetch('/assets/survey-templates.json');
    templates = (await res.json()).templates || [];
  } catch {
    select.disabled = true;
    button.disabled = true;
    return;
  }
  for (const template of templates) {
    const option = document.createElement('option');
    option.value = template.id;
    option.textContent = `${template.label} (${template.questions.length} question${template.questions.length === 1 ? '' : 's'})`;
    select.appendChild(option);
  }
  const defaultNote = source.textContent;
  select.addEventListener('change', () => {
    const template = templates.find((item) => item.id === select.value);
    source.textContent = template ? `Source: ${template.source}` : defaultNote;
  });
  button.addEventListener('click', () => {
    const template = templates.find((item) => item.id === select.value);
    if (!template) return setMessage(message, 'Choose a question template first.', true);
    let questions = [];
    try {
      questions = textarea.value.trim() ? JSON.parse(textarea.value) : [];
      if (!Array.isArray(questions)) throw new Error('not an array');
    } catch {
      return setMessage(message, 'Fix the survey questions JSON (it must be an array) before adding a template.', true);
    }
    const triggers = new Set(questions.map((item) => (item?.esm || item)?.esm_trigger));
    const added = template.questions.filter((item) => !triggers.has(item.esm_trigger));
    textarea.value = JSON.stringify([...questions, ...added], null, 2);
    setMessage(message, added.length
      ? `Added ${added.length} question${added.length === 1 ? '' : 's'} from "${template.label}". Save the schedule to send it to participants.`
      : `"${template.label}" is already in this survey.`);
  });
}

function initResearcher() {
  const form = document.querySelector('#researcher-auth');
  const message = document.querySelector('#researcher-auth-message');
  const dashboard = document.querySelector('#researcher-dashboard');
  const metrics = document.querySelector('#researcher-metrics');
  const devices = document.querySelector('#researcher-devices');
  const withdrawals = document.querySelector('#researcher-withdrawals');
  const participantHealth = document.querySelector('#researcher-participant-health');
  const sensors = document.querySelector('#researcher-sensors');
  const esmResponses = document.querySelector('#researcher-esm-responses');
  const surveyQuality = document.querySelector('#researcher-survey-quality');
  const locationDailySummary = document.querySelector('#researcher-location-daily-summary');
  const phoneUseDaily = document.querySelector('#researcher-phone-use-daily');
  const batteryUsageCleaned = document.querySelector('#researcher-battery-usage-cleaned');
  const batteryUsageScreenshots = document.querySelector('#researcher-battery-usage-screenshots');
  const esmScheduleForm = document.querySelector('#researcher-esm-schedule');
  const esmScheduleResult = document.querySelector('#researcher-esm-schedule-result');
  const batteryScheduleForm = document.querySelector('#researcher-battery-schedule');
  const batteryScheduleResult = document.querySelector('#researcher-battery-schedule-result');
  const activityScheduleForm = document.querySelector('#researcher-activity-schedule');
  const activityScheduleResult = document.querySelector('#researcher-activity-schedule-result');
  const screenTimeActivity = document.querySelector('#researcher-screen-time-activity');
  let currentStudyId = '';
  let currentPassword = '';

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setMessage(message, 'Loading study dashboard...');
    const formData = new FormData(form);
    const studyId = formData.get('studyId');
    const password = formData.get('password');
    currentStudyId = studyId;
    currentPassword = password;
    const headers = { 'x-researcher-password': password };

    const res = await fetch(`/api/v1/studies/${encodeURIComponent(studyId)}/dashboard/summary`, { headers });
    const payload = await readJson(res);
    if (!res.ok) {
      dashboard.classList.add('hidden');
      return setMessage(message, payload.message || payload.error || 'Could not load study dashboard.', true);
    }

    renderMetricCards(metrics, [
      { label: 'Study', value: payload.study.name || payload.study.study_id },
      { label: 'Devices', value: String(payload.summary.device_count) },
      { label: 'Sensors', value: String(payload.summary.sensor_count) },
      { label: 'Rows', value: String(payload.summary.total_rows) },
    ]);

    renderTable(devices, [
      { label: 'Participant', render: (row) => escapeHtml(row.participant || '—') },
      { label: 'Device ID', render: (row) => escapeHtml(row.device_id) },
      { label: 'First seen', render: (row) => fmtDate(row.first_seen) },
      { label: 'Last seen', render: (row) => fmtDate(row.last_seen) },
      {
        label: 'Data',
        render: (row) => `<button class="button" type="button" data-delete-device="${escapeHtml(row.device_id)}" data-participant="${escapeHtml(row.participant || '')}">Delete data</button>`,
      },
    ], payload.devices);

    renderTable(withdrawals, [
      { label: 'When', render: (row) => fmtDate(row.requested_at) },
      { label: 'Participant', render: (row) => escapeHtml(row.participant || '—') },
      { label: 'Device ID', render: (row) => escapeHtml(row.device_id) },
      { label: 'Requested by', render: (row) => escapeHtml(row.source) },
      { label: 'Data deleted', render: (row) => row.delete_data ? `Yes (${escapeHtml(row.rows_deleted)} rows)` : 'No' },
    ], payload.withdrawals || []);

    renderTable(sensors, [
      { label: 'Sensor', render: (row) => escapeHtml(row.sensor) },
      { label: 'Rows', render: (row) => escapeHtml(row.rows) },
      {
        label: 'Export',
        render: (row) => `<a href="/api/v1/studies/${encodeURIComponent(studyId)}/export/${encodeURIComponent(row.sensor)}?format=csv" data-download="study" data-study="${escapeHtml(studyId)}" data-sensor="${escapeHtml(row.sensor)}">CSV</a>`,
      },
    ], payload.sensors);

    dashboard.classList.remove('hidden');
    await loadScheduleSection({
      studyId,
      password,
      form: esmScheduleForm,
      result: esmScheduleResult,
      promptType: 'esm_survey',
      endpoint: 'esm-schedule',
      message,
    });
    await loadScheduleSection({
      studyId,
      password,
      form: batteryScheduleForm,
      result: batteryScheduleResult,
      promptType: 'battery_usage_screenshot',
      endpoint: 'battery-screenshot-schedule',
      message,
    });
    await loadScheduleSection({
      studyId,
      password,
      form: activityScheduleForm,
      result: activityScheduleResult,
      promptType: 'screen_time_activity_screenshot',
      endpoint: 'screen-time-activity-schedule',
      message,
    });
    await loadScreenTimeActivity({ studyId, password, table: screenTimeActivity, message });
    await loadBatteryUsageDiagnostics({
      studyId,
      password,
      appTable: batteryUsageCleaned,
      screenshotTable: batteryUsageScreenshots,
      message,
    });
    await loadEsmResponses({ studyId, password, sensors: payload.sensors, table: esmResponses, message });
    await loadParticipantHealth({ studyId, password, table: participantHealth, message });
    await loadSurveyQuality({ studyId, password, table: surveyQuality, message });
    await loadLocationDailySummary({ studyId, password, table: locationDailySummary, message });
    await loadPhoneUseDaily({ studyId, password, table: phoneUseDaily, message });
    setMessage(message, `Loaded study ${payload.study.study_id}.`);
  });

  setupTemplatePicker({
    select: document.querySelector('#researcher-template-select'),
    button: document.querySelector('#researcher-template-add'),
    source: document.querySelector('#researcher-template-source'),
    textarea: esmScheduleForm.elements.esms_json,
    message,
  });

  esmScheduleForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentStudyId || !currentPassword) {
      return setMessage(message, 'Load a study before saving the ESM survey schedule.', true);
    }
    await saveScheduleSection({
      studyId: currentStudyId,
      password: currentPassword,
      form: esmScheduleForm,
      result: esmScheduleResult,
      message,
      promptType: 'esm_survey',
      label: 'ESM survey',
      endpoint: 'esm-schedule',
    });
  });

  batteryScheduleForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentStudyId || !currentPassword) {
      return setMessage(message, 'Load a study before saving the Battery screenshot schedule.', true);
    }
    await saveScheduleSection({
      studyId: currentStudyId,
      password: currentPassword,
      form: batteryScheduleForm,
      result: batteryScheduleResult,
      message,
      promptType: 'battery_usage_screenshot',
      label: 'Battery screenshot',
      endpoint: 'battery-screenshot-schedule',
    });
  });

  activityScheduleForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentStudyId || !currentPassword) {
      return setMessage(message, 'Load a study before saving the Screen Time screenshot schedule.', true);
    }
    await saveScheduleSection({
      studyId: currentStudyId,
      password: currentPassword,
      form: activityScheduleForm,
      result: activityScheduleResult,
      message,
      promptType: 'screen_time_activity_screenshot',
      label: 'Screen Time screenshot',
      endpoint: 'screen-time-activity-schedule',
    });
  });

  document.querySelector('#researcher-export-zip').addEventListener('click', async (event) => {
    if (!currentStudyId || !currentPassword) {
      return setMessage(message, 'Load a study before downloading the export.', true);
    }
    const button = event.currentTarget;
    const images = document.querySelector('#researcher-export-images').checked;
    button.disabled = true;
    setMessage(message, 'Preparing the study export. Large studies can take a minute...');
    try {
      const url = await downloadUrl(
        `/api/v1/studies/${encodeURIComponent(currentStudyId)}/export.zip${images ? '?images=1' : ''}`,
        { 'x-researcher-password': currentPassword },
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `${currentStudyId}-export.zip`;
      a.click();
      URL.revokeObjectURL(url);
      setMessage(message, 'Study export downloaded.');
    } catch (error) {
      setMessage(message, error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-delete-device]');
    if (!button) return;
    const deviceId = button.dataset.deleteDevice;
    const label = button.dataset.participant || deviceId;
    if (!window.confirm(`Permanently delete ALL data uploaded by ${label}? This cannot be undone.`)) return;
    const res = await fetch(`/api/v1/studies/${encodeURIComponent(currentStudyId)}/participants/${encodeURIComponent(deviceId)}`, {
      method: 'DELETE',
      headers: { 'x-researcher-password': currentPassword },
    });
    const payload = await readJson(res);
    if (!res.ok) {
      return setMessage(message, payload.error || 'Could not delete participant data.', true);
    }
    setMessage(message, `Deleted ${payload.rows_deleted} rows for ${label}. Reloading...`);
    form.requestSubmit();
  });

  document.addEventListener('click', async (event) => {
    const link = event.target.closest('[data-download="study"]');
    if (!link) return;
    event.preventDefault();
    try {
      const url = await downloadUrl(link.getAttribute('href'), { 'x-researcher-password': currentPassword });
      const a = document.createElement('a');
      a.href = url;
      a.download = `${link.dataset.study}-${link.dataset.sensor}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setMessage(message, error.message, true);
    }
  });

  document.addEventListener('click', async (event) => {
    const link = event.target.closest('[data-download-image]');
    if (!link) return;
    event.preventDefault();
    try {
      const url = await downloadUrl(link.getAttribute('href'), { 'x-researcher-password': currentPassword });
      const a = document.createElement('a');
      a.href = url;
      a.download = link.dataset.filename || 'studytrace-photo-response.png';
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setMessage(message, error.message, true);
    }
  });
}

function initAdmin() {
  const authForm = document.querySelector('#admin-auth');
  const authMessage = document.querySelector('#admin-auth-message');
  const dashboard = document.querySelector('#admin-dashboard');
  const metrics = document.querySelector('#admin-metrics');
  const studies = document.querySelector('#admin-studies');
  const sensors = document.querySelector('#admin-sensors');
  const createForm = document.querySelector('#admin-create-study');
  const createResult = document.querySelector('#admin-create-result');
  let token = '';

  async function refresh() {
    const headers = { 'x-admin-token': token };
    const [studiesRes, sensorsRes] = await Promise.all([
      fetch('/admin/studies', { headers }),
      fetch('/admin/sensors', { headers }),
    ]);
    const studiesPayload = await readJson(studiesRes);
    const sensorsPayload = await readJson(sensorsRes);
    if (!studiesRes.ok || !sensorsRes.ok) {
      dashboard.classList.add('hidden');
      throw new Error(studiesPayload.error || sensorsPayload.error || 'Could not load admin dashboard.');
    }

    renderMetricCards(metrics, [
      { label: 'Studies', value: String(studiesPayload.studies.length) },
      { label: 'Sensors', value: String(sensorsPayload.sensors.length) },
      {
        label: 'Participants',
        value: String(studiesPayload.studies.reduce((sum, study) => sum + Number(study.device_count || 0), 0)),
      },
      {
        label: 'Rows',
        value: String(sensorsPayload.sensors.reduce((sum, sensor) => sum + Number(sensor.rows || 0), 0)),
      },
    ]);

    renderTable(studies, [
      { label: 'Study ID', render: (row) => escapeHtml(row.study_id) },
      { label: 'Name', render: (row) => escapeHtml(row.name) },
      { label: 'Researcher password', render: (row) => row.researcher_password_set ? 'Set' : '<strong>Not set — dashboard locked</strong>' },
      { label: 'Devices', render: (row) => String(row.device_count || 0) },
      { label: 'Last activity', render: (row) => fmtDate(row.last_seen) },
    ], studiesPayload.studies);

    renderTable(sensors, [
      { label: 'Sensor', render: (row) => escapeHtml(row.sensor) },
      { label: 'Rows', render: (row) => escapeHtml(row.rows) },
      {
        label: 'Export',
        render: (row) => `<a href="/admin/export/${encodeURIComponent(row.sensor)}?format=csv" data-download="admin" data-sensor="${escapeHtml(row.sensor)}">CSV</a>`,
      },
    ], sensorsPayload.sensors);

    dashboard.classList.remove('hidden');
  }

  authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    token = new FormData(authForm).get('token');
    setMessage(authMessage, 'Loading admin console...');
    try {
      await refresh();
      setMessage(authMessage, 'Admin console loaded.');
    } catch (error) {
      setMessage(authMessage, error.message, true);
    }
  });

  createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!token) {
      return setMessage(authMessage, 'Load the admin console first.', true);
    }
    // Blank fields mean "leave unchanged" for an existing study.
    const body = Object.fromEntries([...new FormData(createForm).entries()].filter(([, value]) => value !== ''));
    const res = await fetch('/admin/studies', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': token,
      },
      body: JSON.stringify(body),
    });
    const payload = await readJson(res);
    if (!res.ok) {
      createResult.textContent = payload.error || 'Could not save study.';
      return;
    }
    createResult.textContent = JSON.stringify(payload, null, 2);
    await refresh();
  });

  document.addEventListener('click', async (event) => {
    const link = event.target.closest('[data-download="admin"]');
    if (!link) return;
    event.preventDefault();
    try {
      const url = await downloadUrl(link.getAttribute('href'), { 'x-admin-token': token });
      const a = document.createElement('a');
      a.href = url;
      a.download = `${link.dataset.sensor}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setMessage(authMessage, error.message, true);
    }
  });
}

if (page === 'researcher') {
  initResearcher();
}

if (page === 'admin') {
  initAdmin();
}
