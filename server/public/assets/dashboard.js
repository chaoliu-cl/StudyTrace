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
      <dt>${label}</dt>
      <dd>${value}</dd>
    </dl>
  `).join('');
}

function renderTable(container, columns, rows) {
  const head = columns.map((column) => `<th>${column.label}</th>`).join('');
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

function renderEsmAnswer(row, studyId, password) {
  const answer = row?.data?.esm_user_answer;
  if ((isPictureEsmRow(row) || looksLikeImageAnswer(answer)) && typeof answer === 'string' && answer.trim()) {
    const sensor = row.sensor || 'esms';
    const imageUrl = `/api/v1/studies/${encodeURIComponent(studyId)}/media/${encodeURIComponent(sensor)}/${encodeURIComponent(row.id)}/image`;
    return `
      <div class="photo-answer">
        <img data-src="${imageUrl}" alt="Photo response" loading="lazy" data-auth-image data-password="${escapeHtml(password)}">
        <a href="${imageUrl}" data-download-image data-password="${escapeHtml(password)}" data-filename="studytrace-esm-${escapeHtml(row.id)}.png">Download image</a>
      </div>
    `;
  }
  if (answer === null || answer === undefined || answer === '') return '—';
  const text = typeof answer === 'object' ? JSON.stringify(answer) : String(answer);
  return `<span class="answer-text">${escapeHtml(text)}</span>`;
}

async function loadEsmResponses({ studyId, password, sensors, table, message }) {
  const headers = { 'x-study-password': password };
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
    { label: 'Answer', render: (row) => renderEsmAnswer(row, studyId, password) },
  ], payload.rows || []);

  await hydrateAuthenticatedImages(table);
}

async function loadBatteryUsageDiagnostics({ studyId, password, appTable, screenshotTable, message }) {
  const headers = { 'x-study-password': password };
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
    { label: 'Method', render: (row) => escapeHtml(row.extraction_method || '—') },
    { label: 'Participant', render: (row) => escapeHtml(row.device_id || '—') },
    { label: 'Time', render: (row) => fmtDate((row.timestamp || 0) * 1000 || row.created_at) },
  ], payload.appRows || []);

  renderTable(screenshotTable, [
    { label: 'Time', render: (row) => fmtDate((row.timestamp || 0) * 1000 || row.created_at) },
    { label: 'Participant', render: (row) => escapeHtml(row.device_id || '—') },
    { label: 'Sensor', render: (row) => escapeHtml(row.sensor || '—') },
    { label: 'Question', render: (row) => escapeHtml(parseEsmJson(row).esm_title || row.data?.esm_trigger || 'Battery screenshot') },
    { label: 'Screenshot', render: (row) => renderEsmAnswer(row, studyId, password) },
  ], payload.screenshotRows || []);

  await hydrateAuthenticatedImages(screenshotTable);
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
  },
];

function defaultQuestionsForPrompt(promptType) {
  return promptType === 'esm_survey' ? defaultEsmSurveyQuestions : defaultBatteryScreenshotQuestions;
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
    null;
}

function fillScheduleForm(form, schedule, promptType) {
  const item = findScheduleForPrompt(schedule, promptType);
  form.elements.mode.value = item?.studytrace_delivery_mode || (Number(item?.randomize || 0) > 0 ? 'random' : 'fixed');
  form.elements.times.value = Array.isArray(item?.times) && item.times.length
    ? item.times.join(', ')
    : (Array.isArray(item?.hours) ? item.hours.map((hour) => `${String(hour).padStart(2, '0')}:00`).join(', ') : (promptType === 'esm_survey' ? '09:30, 17:15' : '20:30'));
  form.elements.randomize_minutes.value = String(item?.randomize || 30);
  form.elements.expiration_minutes.value = String(item?.expiration || 120);
  form.elements.notification_title.value = item?.notification_title || (promptType === 'esm_survey' ? 'StudyTrace survey available' : 'StudyTrace Battery screenshot');
  form.elements.notification_body.value = item?.notification_body || (promptType === 'esm_survey' ? 'Please complete your scheduled study survey.' : 'Please upload your iOS Battery usage screenshot.');
  form.elements.start_date.value = item?.start_date || '';
  form.elements.end_date.value = item?.end_date || '';
  if (form.elements.esms_json) {
    form.elements.esms_json.value = JSON.stringify(unwrapEsmQuestions(item?.esms, promptType), null, 2);
  }
}

async function loadScheduleSection({ studyId, password, sections, message }) {
  const res = await fetch(`/api/v1/studies/${encodeURIComponent(studyId)}/esm-schedule`, {
    headers: { 'x-study-password': password },
  });
  const payload = await readJson(res);
  if (!res.ok) {
    setMessage(message, payload.error || 'Could not load survey delivery schedule.', true);
    return;
  }
  for (const section of sections) {
    fillScheduleForm(section.form, payload.esm_schedule || [], section.promptType);
    const summary = (payload.schedule_summary || []).filter((item) => item.prompt_type === section.promptType);
    section.result.textContent = JSON.stringify(summary, null, 2);
  }
}

async function saveScheduleSection({ studyId, password, form, result, message, promptType, label }) {
  const formData = new FormData(form);
  const body = Object.fromEntries(formData.entries());
  body.prompt_type = promptType;
  if (!body.esms_json) body.esms = defaultQuestionsForPrompt(promptType);
  const res = await fetch(`/api/v1/studies/${encodeURIComponent(studyId)}/esm-schedule`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'x-study-password': password,
    },
    body: JSON.stringify(body),
  });
  const payload = await readJson(res);
  result.textContent = JSON.stringify(payload.schedule_summary || payload, null, 2);
  if (!res.ok) {
    setMessage(message, payload.error || `Could not save ${label} schedule.`, true);
    return false;
  }
  const summary = (payload.schedule_summary || []).filter((item) => item.prompt_type === promptType);
  result.textContent = JSON.stringify(summary, null, 2);
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

async function hydrateAuthenticatedImages(container) {
  const images = [...container.querySelectorAll('[data-auth-image]')];
  await Promise.all(images.map(async (img) => {
    try {
      const url = await downloadUrl(img.dataset.src, { 'x-study-password': img.dataset.password });
      img.src = url;
    } catch {
      img.replaceWith(document.createTextNode('Image unavailable'));
    }
  }));
}

function initResearcher() {
  const form = document.querySelector('#researcher-auth');
  const message = document.querySelector('#researcher-auth-message');
  const dashboard = document.querySelector('#researcher-dashboard');
  const metrics = document.querySelector('#researcher-metrics');
  const devices = document.querySelector('#researcher-devices');
  const sensors = document.querySelector('#researcher-sensors');
  const esmResponses = document.querySelector('#researcher-esm-responses');
  const batteryUsageCleaned = document.querySelector('#researcher-battery-usage-cleaned');
  const batteryUsageScreenshots = document.querySelector('#researcher-battery-usage-screenshots');
  const esmScheduleForm = document.querySelector('#researcher-esm-schedule');
  const esmScheduleResult = document.querySelector('#researcher-esm-schedule-result');
  const batteryScheduleForm = document.querySelector('#researcher-battery-schedule');
  const batteryScheduleResult = document.querySelector('#researcher-battery-schedule-result');
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
    const headers = { 'x-study-password': password };

    const res = await fetch(`/api/v1/studies/${encodeURIComponent(studyId)}/dashboard/summary`, { headers });
    const payload = await readJson(res);
    if (!res.ok) {
      dashboard.classList.add('hidden');
      return setMessage(message, payload.error || 'Could not load study dashboard.', true);
    }

    renderMetricCards(metrics, [
      { label: 'Study', value: payload.study.name || payload.study.study_id },
      { label: 'Devices', value: String(payload.summary.device_count) },
      { label: 'Sensors', value: String(payload.summary.sensor_count) },
      { label: 'Rows', value: String(payload.summary.total_rows) },
    ]);

    renderTable(devices, [
      { label: 'Participant', render: (row) => row.participant || '—' },
      { label: 'Device ID', render: (row) => row.device_id },
      { label: 'First seen', render: (row) => fmtDate(row.first_seen) },
      { label: 'Last seen', render: (row) => fmtDate(row.last_seen) },
    ], payload.devices);

    renderTable(sensors, [
      { label: 'Sensor', render: (row) => row.sensor },
      { label: 'Rows', render: (row) => String(row.rows) },
      {
        label: 'Export',
        render: (row) => `<a href="/api/v1/studies/${encodeURIComponent(studyId)}/export/${encodeURIComponent(row.sensor)}?format=csv" data-download="study" data-study="${escapeHtml(studyId)}" data-password="${escapeHtml(password)}" data-sensor="${escapeHtml(row.sensor)}">CSV</a>`,
      },
    ], payload.sensors);

    dashboard.classList.remove('hidden');
    await loadScheduleSection({
      studyId,
      password,
      sections: [
        { promptType: 'esm_survey', form: esmScheduleForm, result: esmScheduleResult },
        { promptType: 'battery_usage_screenshot', form: batteryScheduleForm, result: batteryScheduleResult },
      ],
      message,
    });
    await loadBatteryUsageDiagnostics({
      studyId,
      password,
      appTable: batteryUsageCleaned,
      screenshotTable: batteryUsageScreenshots,
      message,
    });
    await loadEsmResponses({ studyId, password, sensors: payload.sensors, table: esmResponses, message });
    setMessage(message, `Loaded study ${payload.study.study_id}.`);
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
    });
  });

  document.addEventListener('click', async (event) => {
    const link = event.target.closest('[data-download="study"]');
    if (!link) return;
    event.preventDefault();
    try {
      const url = await downloadUrl(link.getAttribute('href'), { 'x-study-password': link.dataset.password });
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
      const url = await downloadUrl(link.getAttribute('href'), { 'x-study-password': link.dataset.password });
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
      { label: 'Study ID', render: (row) => row.study_id },
      { label: 'Name', render: (row) => row.name },
      { label: 'Devices', render: (row) => String(row.device_count || 0) },
      { label: 'Last activity', render: (row) => fmtDate(row.last_seen) },
    ], studiesPayload.studies);

    renderTable(sensors, [
      { label: 'Sensor', render: (row) => row.sensor },
      { label: 'Rows', render: (row) => String(row.rows) },
      {
        label: 'Export',
        render: (row) => `<a href="/admin/export/${encodeURIComponent(row.sensor)}?format=csv" data-download="admin" data-sensor="${row.sensor}">CSV</a>`,
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
    const body = Object.fromEntries(new FormData(createForm).entries());
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
      createResult.textContent = payload.error || 'Could not create study.';
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
