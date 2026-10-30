const keys = ['esm_schedule', 'app_usage_screenshot_schedule', 'battery_screenshot_schedule', 'screen_time_activity_schedule'];
const names = ['Questionnaire', 'App-usage screenshots', 'Battery screenshots', 'Screen Time screenshots'];
const types = ['esm_survey', 'app_usage_screenshot', 'battery_usage_screenshot', 'screen_time_activity_screenshot'];
const slugs = ['esm_survey', 'app_usage_screenshot_test', 'battery_screenshot', 'screen_time_activity'];
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const clone = value => structuredClone(value);
const hhmm = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const minute = value => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value || '') ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : null;
const isoDate = value => /^\d{2}-\d{2}-\d{4}$/.test(value || '') ? `${value.slice(6)}-${value.slice(0, 2)}-${value.slice(3, 5)}` : '';
const awareDate = value => value ? `${value.slice(5, 7)}-${value.slice(8)}-${value.slice(0, 4)}` : '';
const times = s => Array.isArray(s.times) && s.times.length ? s.times : (Array.isArray(s.hours) ? s.hours : []).map(h => `${String(h).padStart(2, '0')}:00`);

export function randomWindow(start, end) {
  const lo = minute(start), hi = minute(end);
  if (lo === null || hi === null || hi <= lo || hi - lo > 360 || hi - lo < 2) throw new Error('Use a random window between 2 minutes and 6 hours, ending later on the same day.');
  const jitter = Math.floor((hi - lo) / 2);
  return { times: [hhmm(lo + jitter)], hours: [Math.floor((lo + jitter) / 60)], randomize: jitter };
}

export function newSchedule(key) {
  const index = keys.indexOf(key);
  const screenshot = index !== 0;
  const q = screenshot ? { esm_type: 14, esm_title: "Today's app usage screenshots", esm_instructions: "Upload one or more screenshots of today's usage so far from iPhone Screen Time or Android Digital Wellbeing.", esm_trigger: 'app_usage_screenshot', esm_submit: 'Upload screenshots', esm_na: false }
    : { esm_type: 2, esm_title: 'New question', esm_instructions: '', esm_radios: ['First choice', 'Second choice'], esm_trigger: `q_${crypto.randomUUID()}`, esm_submit: 'Submit', esm_na: true };
  return { schedule_id: `studytrace_${slugs[index]}_${crypto.randomUUID()}`, studytrace_label: screenshot ? 'App-usage screenshots' : 'New questionnaire',
    studytrace_prompt_type: types[index], times: [screenshot ? '20:00' : '10:30'], hours: [screenshot ? 20 : 10],
    randomize: screenshot ? 45 : 90, studytrace_delivery_mode: 'random', expiration: 60,
    studytrace_window_start: screenshot ? '19:15' : '09:00', studytrace_window_end: screenshot ? '20:45' : '12:00',
    start_date: '', end_date: '', notification_title: screenshot ? 'StudyTrace app usage screenshot' : 'StudyTrace questionnaire',
    notification_body: screenshot ? "Please upload screenshots of today's app usage so far." : 'Please complete your study questionnaire.',
    interface: 0, esms: [{ esm: q }], ...(screenshot ? { studytrace_period: 'test', studytrace_usage_day: 'today' } : {}) };
}

export function configurationFromJson(value) {
  const raw = typeof value === 'string' ? JSON.parse(value) : value;
  if (!raw || keys.some(key => !Array.isArray(raw[key]))) throw new Error('Configuration JSON must contain all four schedule arrays. For a question-only file, use Import questions in the selected questionnaire.');
  if (keys.some(key => raw[key].some(s => !s || typeof s.schedule_id !== 'string' || !Array.isArray(s.esms) || s.esms.some(q => !q?.esm || typeof q.esm !== 'object')))) throw new Error('Each task needs a schedule ID and an array of wrapped question definitions.');
  return Object.fromEntries(keys.map(key => [key, clone(raw[key])]));
}

export function initScheduleEditor(root) {
  const status = root.querySelector('[data-protocol-status]');
  const list = root.querySelector('[data-protocol-list]');
  const editor = root.querySelector('[data-protocol-editor]');
  const save = root.querySelector('[data-protocol-save]');
  const advanced = root.querySelector('[data-protocol-json]');
  let templates = [];
  const templatesReady = fetch('/assets/survey-templates.json').then(r => r.json()).then(body => { templates = body.templates || []; }).catch(() => {});
  let studyId = '', password = '', revision = '', config = null, selected = null, previous = null, context = false, dirty = false, token = 0;
  const modes = new Map();
  const message = (text, error = false) => { status.textContent = text; status.classList.toggle('is-error', error); };
  const entries = () => config ? keys.flatMap(key => config[key].map(s => ({ key, s }))) : [];
  const current = () => entries().find(({ s }) => s.schedule_id === selected);
  const label = s => s.studytrace_label || s.notification_title || s.schedule_id;
  const mode = s => modes.get(s.schedule_id) || (Number(s.randomize) > 0 ? (times(s).length === 1 ? 'window' : 'anchors') : 'fixed');
  function changed() { dirty = true; message('Unsaved draft. Review the task list, then Save all schedules to update this study.'); }
  function download(value, suffix) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `${studyId}-${suffix}.json`; a.click(); URL.revokeObjectURL(url);
  }
  async function request(path, options = {}) {
    const r = await fetch(`/api/v1/studies/${encodeURIComponent(studyId)}/${path}`, { ...options,
      headers: { 'Content-Type': 'application/json', 'x-researcher-password': password } });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || `Request failed (${r.status}).`);
    return body;
  }
  function renderList() {
    list.innerHTML = `<div class="table-wrap"><table class="schedule-table"><thead><tr><th>Task</th><th>Delivery, phone-local time</th><th>Questions</th><th>Actions</th></tr></thead><tbody>${entries().map(({ key, s }) => {
      const t = times(s), jitter = Number(s.randomize || 0);
      const ranges = t.map(v => { const m = minute(v); return m === null ? 'Review times' : jitter ? `${hhmm(Math.max(0, m - jitter))}–${hhmm(Math.min(1439, m + jitter))}` : v; });
      const n = s.esms?.length || 0, extra = key === 'esm_schedule' && context ? ' + 5 context' : '';
      return `<tr${s.schedule_id === selected ? ' class="schedule-selected"' : ''}><td><strong>${esc(label(s))}</strong><br><small>${names[keys.indexOf(key)]}</small></td><td>${jitter ? 'Random within ' : 'Fixed: '}${esc(ranges.join(', '))}<br><small>${t.length} notification${t.length === 1 ? '' : 's'}/day · ${esc(s.start_date || 'No start bound')} → ${esc(s.end_date || 'No end bound')}</small></td><td>${n}${extra}</td><td><div class="schedule-actions"><button type="button" class="button" data-edit="${esc(s.schedule_id)}" aria-label="Edit ${esc(label(s))}">Edit</button><button type="button" class="button" data-duplicate="${esc(s.schedule_id)}" aria-label="Duplicate ${esc(label(s))}">Duplicate</button><button type="button" class="button" data-remove="${esc(s.schedule_id)}" aria-label="Remove ${esc(label(s))}">Remove</button></div></td></tr>`;
    }).join('') || '<tr><td colspan="4">No tasks configured. Add a questionnaire or load the pilot preset.</td></tr>'}</tbody></table></div>`;
    const count = entries().reduce((n, { s }) => n + times(s).length, 0);
    root.querySelector('[data-protocol-count]').textContent = `${entries().length} tasks · ${count} intended notifications/day. Environment context ${context ? 'on' : 'off'}; edit it in Environment collection below.`;
    root.querySelector('[data-protocol-previous]').disabled = !previous;
  }
  function field(title, name, value, type = 'text', extra = '') {
    return `<label><span>${title}</span><input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
  }
  function renderEditor() {
    const item = current();
    if (!item) { editor.innerHTML = '<p class="section-note">Choose Edit on a task to customize it.</p>'; return; }
    const { key, s } = item, m = mode(s), anchor = minute(times(s)[0]) ?? 630, jitter = Number(s.randomize || 0);
    editor.innerHTML = `<h3>Edit ${esc(label(s))}</h3><div data-schedule-fields class="stack">
      ${field('Task name', 'studytrace_label', label(s))}
      <label><span>Delivery mode</span><select name="delivery_mode"><option value="window" ${m === 'window' ? 'selected' : ''}>One random time daily within a window</option><option value="fixed" ${m === 'fixed' ? 'selected' : ''}>Fixed time(s)</option><option value="anchors" ${m === 'anchors' ? 'selected' : ''}>Randomized around listed times</option></select></label>
      ${m === 'window' ? `<div class="schedule-grid">${field('Random window start', 'target_start', hhmm(Math.max(0, anchor - jitter)), 'time', 'required')}${field('Random window end', 'target_end', hhmm(Math.min(1439, anchor + jitter)), 'time', 'required')}</div>` : field('Daily times (24-hour HH:MM, comma separated)', 'times', times(s).join(', '))}
      ${m === 'anchors' ? field('Randomization before/after each time (minutes)', 'randomize', jitter, 'number', 'min="1" max="180"') : ''}
      <div class="schedule-grid">${field('Response window (minutes)', 'expiration', s.expiration ?? 60, 'number', 'min="0" max="1440"')}${field('Start date (optional)', 'start_date', isoDate(s.start_date), 'date')}${field('End date (optional)', 'end_date', isoDate(s.end_date), 'date')}</div>
      ${field('Notification title', 'notification_title', s.notification_title || '')}${field('Notification message', 'notification_body', s.notification_body || '')}
      <details><summary>Delivery limits and schedule ID</summary><p class="section-note">Limits apply to new prompts; a delivered response can remain open afterward. Current iPhone randomization supports windows up to 6 hours. Times are local to each phone.</p><div class="schedule-grid">${field('Earliest new notification (optional)', 'studytrace_window_start', s.studytrace_window_start || '', 'time')}${field('Latest new notification (optional)', 'studytrace_window_end', s.studytrace_window_end || '', 'time')}</div><p class="section-note">Schedule ID: <code>${esc(s.schedule_id)}</code>. Kept stable when editing to preserve occurrence history.</p></details>
      <section data-question-list></section>
      ${key === 'app_usage_screenshot_schedule' ? '<p class="section-note">This task requests today’s usage screenshots. Participants can upload multiple images; iPhone uses its built-in screenshot workflow.</p>' : `<div class="schedule-actions"><button type="button" class="button" data-add-question="2">Add choice question</button><button type="button" class="button" data-add-question="1">Add text question</button><button type="button" class="button" data-add-question="14">Add photo question</button><label class="button">Import questions JSON<input type="file" accept=".json,application/json" data-import-questions hidden></label></div>${templates.length ? `<label><span>Optional question template</span><select data-question-template><option value="">Choose a template…</option>${templates.map(t => `<option value="${esc(t.id)}">${esc(t.label)}</option>`).join('')}</select></label><button type="button" class="button" data-add-template>Add template questions</button>` : ''}`}
    </div>`;
    renderQuestions();
  }
  function renderQuestions() {
    const item = current(); if (!item) return;
    const host = editor.querySelector('[data-question-list]');
    const open = new Set([...host.querySelectorAll('details[open]')].map(node => Number(node.querySelector('[data-question]')?.dataset.question)));
    if (item.key === 'app_usage_screenshot_schedule') { host.innerHTML = ''; return; }
    host.innerHTML = `<h4>Questions (${item.s.esms.length})</h4>${item.s.esms.map(({ esm: q }, i) => `<details class="question-card" ${open.has(i) ? 'open' : ''}><summary>${i + 1}. ${esc(q.esm_title || 'Untitled question')}</summary><div class="stack" data-question="${i}">
      <label><span>Question type</span><select data-question-field="esm_type">${[[2, 'Single choice'], [1, 'Text'], [14, 'Photo']].map(([v, text]) => `<option value="${v}" ${q.esm_type === v ? 'selected' : ''}>${text}</option>`).join('')}${![1, 2, 14].includes(q.esm_type) ? `<option value="${q.esm_type}" selected>Existing type ${q.esm_type} (advanced fields preserved)</option>` : ''}</select></label>
      <label><span>Question title</span><input data-question-field="esm_title" value="${esc(q.esm_title)}"></label>
      <label><span>Question text / instructions</span><textarea rows="3" data-question-field="esm_instructions">${esc(q.esm_instructions || '')}</textarea></label>
      ${q.esm_type === 2 ? `<label><span>Answer choices (one per line)</span><textarea rows="5" data-question-field="esm_radios">${esc((Array.isArray(q.esm_radios) ? q.esm_radios : []).join('\n'))}</textarea></label>` : ''}
      ${q.esm_type === 14 ? '<p class="section-note">Participants can choose existing photos or use their camera, up to 10 images per answer on updated apps.</p>' : ''}
      <label><span>Item ID in exports</span><input data-question-field="esm_trigger" value="${esc(q.esm_trigger || '')}"></label>
      <div class="schedule-actions"><button type="button" class="button" data-question-up="${i}" ${i === 0 ? 'disabled' : ''}>Move up</button><button type="button" class="button" data-question-down="${i}" ${i === item.s.esms.length - 1 ? 'disabled' : ''}>Move down</button><button type="button" class="button" data-question-remove="${i}">Remove question</button></div></div></details>`).join('')}`;
  }
  function storeCurrent(silent = false) {
    const item = current(); if (!item) return true;
    const fields = editor.querySelector('[data-schedule-fields]'); if (!fields) return true;
    const get = name => fields.querySelector(`[name="${name}"]`)?.value;
    try {
      const s = item.s, m = get('delivery_mode');
      let timing;
      if (m === 'window') timing = randomWindow(get('target_start'), get('target_end'));
      else timing = { times: (get('times') || '').split(',').map(v => v.trim()).filter(Boolean), randomize: m === 'fixed' ? 0 : Number(get('randomize')) };
      if (m === 'window' && (times(s)[0] !== timing.times[0] || s.randomize !== timing.randomize)) {
        fields.querySelector('[name="studytrace_window_start"]').value = get('target_start');
        fields.querySelector('[name="studytrace_window_end"]').value = get('target_end');
      }
      Object.assign(s, timing);
      s.studytrace_delivery_mode = s.randomize > 0 ? (s.studytrace_delivery_mode === 'periods' ? 'periods' : 'random') : 'fixed';
      for (const name of ['studytrace_label', 'notification_title', 'notification_body', 'studytrace_window_start', 'studytrace_window_end']) s[name] = get(name) || '';
      s.expiration = Number(get('expiration'));
      s.start_date = awareDate(get('start_date')); s.end_date = awareDate(get('end_date'));
      modes.set(s.schedule_id, m);
      return true;
    } catch (error) { if (!silent) message(error.message, true); return false; }
  }
  function adopt(body) {
    config = configurationFromJson(body); revision = body.revision || revision; previous = body.previous_configuration || previous;
    context = Boolean(body.context_questions_enabled); selected = entries()[0]?.s.schedule_id || null; modes.clear(); dirty = false;
    save.disabled = false; renderList(); renderEditor();
  }
  root.addEventListener('input', event => {
    if (!config || !editor.contains(event.target)) return;
    if (event.target.name === 'delivery_mode') return;
    const qfield = event.target.dataset.questionField;
    if (qfield) {
      const q = current().s.esms[Number(event.target.closest('[data-question]').dataset.question)].esm;
      q[qfield] = qfield === 'esm_radios' ? event.target.value.split('\n') : qfield === 'esm_type' ? Number(event.target.value) : event.target.value;
      if (qfield === 'esm_title') event.target.closest('details').querySelector('summary').textContent = `${Number(event.target.closest('[data-question]').dataset.question) + 1}. ${event.target.value}`;
    } else storeCurrent(true);
    changed(); renderList();
  });
  root.addEventListener('change', async event => {
    if (event.target.name === 'delivery_mode' && current()) {
      const s = current().s, next = event.target.value;
      modes.set(s.schedule_id, next);
      if (next === 'fixed') { s.randomize = 0; s.studytrace_window_start = ''; s.studytrace_window_end = ''; }
      else if (!s.randomize) s.randomize = 30;
      if (next === 'window') s.times = [times(s)[0] || '10:30'];
      renderEditor(); changed(); renderList();
    }
    if (event.target.dataset.questionField === 'esm_type') { renderQuestions(); changed(); }
    if (event.target.matches('[data-import-questions]') && event.target.files[0]) {
      try {
        if (event.target.files[0].size > 512000) throw new Error('Question JSON is too large.');
        const raw = JSON.parse(await event.target.files[0].text());
        if (!Array.isArray(raw) || !raw.length || raw.length > 100 || raw.some(q => !q || typeof (q.esm || q).esm_title !== 'string')) throw new Error('Question JSON must contain 1–100 question definitions with titles.');
        current().s.esms = raw.map(q => q.esm ? q : { esm: q });
        renderQuestions(); changed(); renderList();
      } catch (error) { message(error.message, true); }
    }
    if (event.target.matches('[data-protocol-file]') && event.target.files[0]) {
      try { if (event.target.files[0].size > 512000) throw new Error('Configuration JSON is too large.'); advanced.value = await event.target.files[0].text(); importDraft(); } catch (error) { message(error.message, true); }
      event.target.value = '';
    }
  });
  function importDraft() {
    const next = configurationFromJson(advanced.value);
    config = next; selected = entries()[0]?.s.schedule_id || null; modes.clear(); renderList(); renderEditor(); changed();
  }
  root.addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button || !root.contains(button)) return;
    try {
      if (!config) throw new Error('Load a study first.');
      const action = button.dataset;
      if (action.edit) { if (!storeCurrent()) return; selected = action.edit; renderList(); renderEditor(); }
      if (action.remove || action.duplicate) {
        if (!storeCurrent()) return;
        const found = entries().find(({ s }) => s.schedule_id === (action.remove || action.duplicate));
        if (action.remove) config[found.key] = config[found.key].filter(s => s !== found.s);
        else { const copy = clone(found.s); copy.schedule_id = `studytrace_${slugs[keys.indexOf(found.key)]}_${crypto.randomUUID()}`; copy.studytrace_label = `${label(copy)} (copy)`; config[found.key].push(copy); selected = copy.schedule_id; }
        if (!current()) selected = entries()[0]?.s.schedule_id || null;
        renderList(); renderEditor(); changed();
      }
      if (action.addSchedule) {
        if (!storeCurrent()) return; const s = newSchedule(action.addSchedule); config[action.addSchedule].push(s); selected = s.schedule_id;
        renderList(); renderEditor(); changed();
      }
      if ('addQuestion' in action) {
        const q = newSchedule('esm_schedule').esms[0]; q.esm.esm_type = Number(action.addQuestion);
        if (q.esm.esm_type !== 2) delete q.esm.esm_radios;
        if (q.esm.esm_type === 14) q.esm.esm_title = 'Photo question';
        current().s.esms.push(q); current().s.esms.forEach((v, i, items) => { v.esm.esm_submit = i === items.length - 1 ? 'Submit' : 'Next'; });
        renderQuestions(); renderList(); changed();
      }
      if ('addTemplate' in action) {
        const template = templates.find(t => t.id === editor.querySelector('[data-question-template]').value);
        if (!template) throw new Error('Choose a template first.');
        const items = current().s.esms, ids = new Set(items.map(q => q.esm.esm_trigger));
        items.push(...template.questions.filter(q => !ids.has(q.esm_trigger)).map(q => ({ esm: clone(q) })));
        items.forEach((q, i) => { q.esm.esm_submit = i === items.length - 1 ? 'Submit' : 'Next'; });
        renderQuestions(); renderList(); changed(); message(`Template added to the draft. Source: ${template.source}. Review wording before saving.`);
      }
      for (const [attribute, delta] of [['questionUp', -1], ['questionDown', 1], ['questionRemove', 0]]) {
        if (!(attribute in action)) continue;
        const items = current().s.esms, index = Number(action[attribute]);
        if (!delta) items.splice(index, 1); else [items[index], items[index + delta]] = [items[index + delta], items[index]];
        items.forEach((q, i) => { q.esm.esm_submit = i === items.length - 1 ? 'Submit' : 'Next'; });
        renderQuestions(); renderList(); changed();
      }
      if ('protocolPreset' in action) {
        const captured = token, body = await request('prompt-schedule-preset'); if (captured !== token) return;
        config = configurationFromJson(body); selected = entries()[0]?.s.schedule_id || null; modes.clear();
        renderList(); renderEditor(); changed(); message('Pilot preset loaded into the draft: three questionnaires and one evening photo task. Review dates and timing, then Save all schedules. Existing schedules change only when saved.');
      }
      if ('protocolExport' in action) { if (storeCurrent()) download(config, 'schedules'); }
      if ('protocolPrevious' in action && previous) download(previous, 'previous-schedules');
      if ('protocolJsonLoad' in action) importDraft();
      if ('protocolJsonShow' in action) { if (storeCurrent()) advanced.value = JSON.stringify(config, null, 2); }
      if ('protocolReload' in action) { await load(studyId, password); }
      if ('protocolSave' in action) {
        if (!storeCurrent()) return;
        save.disabled = true;
        const captured = token;
        try {
          const body = await request('prompt-schedules', { method: 'PUT', body: JSON.stringify({ ...config, expected_revision: revision }) });
          if (captured !== token) return;
          adopt(body); message('All schedules saved. A previous-configuration backup is available. Ask participants to refresh StudyTrace; collected data and environment settings were preserved.');
        } finally { if (captured === token) save.disabled = false; }
      }
    } catch (error) { message(error.message, true); }
  });
  async function load(id, secret) {
    const captured = ++token; studyId = id; password = secret; config = null; revision = ''; previous = null; save.disabled = true;
    list.innerHTML = ''; editor.innerHTML = ''; message('Loading all schedules...');
    try {
      const body = await request('prompt-schedules'); await templatesReady; if (captured !== token) return;
      adopt(body); message(body.unmanaged_count ? `${body.unmanaged_count} unsupported embedded schedule(s) will be preserved. Review advanced configuration before changing this protocol.` : 'Schedules loaded. Changes stay in the draft until you save.');
    } catch (error) { if (captured === token) message(error.message, true); }
  }
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  return { load, setContextEnabled(enabled) { context = Boolean(enabled); if (config) renderList(); } };
}
