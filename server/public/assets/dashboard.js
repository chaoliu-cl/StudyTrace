const page = document.body.dataset.page;

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

function initResearcher() {
  const form = document.querySelector('#researcher-auth');
  const message = document.querySelector('#researcher-auth-message');
  const dashboard = document.querySelector('#researcher-dashboard');
  const metrics = document.querySelector('#researcher-metrics');
  const devices = document.querySelector('#researcher-devices');
  const sensors = document.querySelector('#researcher-sensors');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setMessage(message, 'Loading study dashboard...');
    const formData = new FormData(form);
    const studyId = formData.get('studyId');
    const password = formData.get('password');
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
        render: (row) => `<a href="/api/v1/studies/${encodeURIComponent(studyId)}/export/${encodeURIComponent(row.sensor)}?format=csv" data-download="study" data-study="${studyId}" data-password="${password}" data-sensor="${row.sensor}">CSV</a>`,
      },
    ], payload.sensors);

    dashboard.classList.remove('hidden');
    setMessage(message, `Loaded study ${payload.study.study_id}.`);
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
