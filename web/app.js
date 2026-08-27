const API = '';
const POLL_MS = 300;

const STATUS_LABELS = {
  queued: 'Queued',
  running: 'Running',
  retrying: 'Retrying',
  succeeded: 'Done',
  failed: 'Failed',
};

const STEP_LABELS = {
  writer: 'Write',
  tests: 'Tests',
  review: 'Review',
  git: 'Save',
};

const ROLE_KICKER = {
  plan: 'Plan',
  writer: 'Writer',
  tests: 'Tests',
  review: 'Review',
  git: 'Saved',
  loop: 'Loop',
};

const els = {
  unreachable: document.getElementById('unreachable'),
  form: document.getElementById('launch-form'),
  followForm: document.getElementById('follow-form'),
  title: document.getElementById('title'),
  prompt: document.getElementById('prompt'),
  sourceDir: document.getElementById('sourceDir'),
  provider: document.getElementById('provider'),
  orchestratorProvider: document.getElementById('orchestratorProvider'),
  reviewerProvider: document.getElementById('reviewerProvider'),
  formError: document.getElementById('formError'),
  followError: document.getElementById('followError'),
  followup: document.getElementById('followup'),
  launch: document.getElementById('launch'),
  send: document.getElementById('send'),
  cancel: document.getElementById('cancel'),
  reset: document.getElementById('reset'),
  resetConfirm: document.getElementById('reset-confirm'),
  resetYes: document.getElementById('reset-yes'),
  resetNo: document.getElementById('reset-no'),
  followCancel: document.getElementById('followCancel'),
  empty: document.getElementById('empty'),
  job: document.getElementById('job'),
  status: document.getElementById('status'),
  attempt: document.getElementById('attempt'),
  steps: document.getElementById('steps'),
  timeline: document.getElementById('timeline'),
  plan: document.getElementById('plan'),
  shaLine: document.getElementById('shaLine'),
  logs: document.getElementById('logs'),
  lastError: document.getElementById('lastError'),
  filesHint: document.getElementById('filesHint'),
  fileTabs: document.getElementById('fileTabs'),
  fileView: document.getElementById('fileView'),
  filesEmpty: document.getElementById('filesEmpty'),
  thread: document.getElementById('thread'),
  oracleChip: document.getElementById('oracleChip'),
  sourceReadout: document.getElementById('sourceReadout'),
  appTitle: document.getElementById('app-title'),
};

let lastTask = null;
let lastProject = null;
let reachable = true;
let pollInFlight = false;
let selectedFile = null;
let defaultsApplied = false;

function setUnreachable(isUnreachable) {
  reachable = !isUnreachable;
  els.unreachable.hidden = !isUnreachable;
}

function setFormError(message) {
  els.formError.hidden = !message;
  els.formError.textContent = message || '';
  if (els.followError) {
    els.followError.hidden = !message;
    els.followError.textContent = message || '';
  }
}

let userTouchedForm = false;

function markFormTouched() {
  userTouchedForm = true;
}

function scrubHomeworkAutofill() {
  if (userTouchedForm) return;
  const blob = `${els.sourceDir?.value ?? ''} ${els.title?.value ?? ''} ${els.prompt?.value ?? ''}`;
  if (
    /examples\/sqrt|parseIndex|parse\.test\.js|Do not change sqrt\.test\.js/i.test(
      blob,
    )
  ) {
    if (els.sourceDir) els.sourceDir.value = '';
    if (els.title) els.title.value = '';
    if (els.prompt) els.prompt.value = '';
  }
}

function applyDefaults() {
  /* no canned project — keep the form empty */
}

function applySlotBusy(slots) {
  const list = Array.isArray(slots) ? slots : [];
  for (const select of [els.provider, els.reviewerProvider, els.orchestratorProvider]) {
    if (!select) continue;
    for (const option of select.options) {
      if (!option.value) {
        option.disabled = false;
        continue;
      }
      const slot = list.find((item) => item.provider === option.value);
      option.disabled = Boolean(slot?.isBusy);
    }
  }
}

function isInFlight(task) {
  return (
    task &&
    (task.status === 'queued' ||
      task.status === 'running' ||
      task.status === 'retrying')
  );
}

function updateActions(task) {
  const selectedBusy = Boolean(els.provider.selectedOptions[0]?.disabled);
  const inFlight = isInFlight(task);
  if (els.launch) els.launch.disabled = !reachable || selectedBusy;
  if (els.send) els.send.disabled = !reachable || inFlight;
  for (const button of [els.cancel, els.followCancel]) {
    if (button) button.disabled = !reachable || !inFlight;
  }
  for (const button of [els.reset]) {
    if (button) button.disabled = !reachable;
  }
}

function renderSteps(task) {
  els.steps.replaceChildren();
  const steps = task?.steps ?? [];
  for (const step of steps) {
    const li = document.createElement('li');
    li.className = `step ${step.status}`;
    li.textContent = `${STEP_LABELS[step.id] ?? step.id}`;
    els.steps.append(li);
  }
}

function renderPlan(project) {
  const items = Array.isArray(project?.plan) ? project.plan : [];
  if (!els.plan) return;
  if (items.length === 0) {
    els.plan.hidden = true;
    els.plan.replaceChildren();
    return;
  }
  els.plan.hidden = false;
  els.plan.replaceChildren();
  for (const item of items) {
    const li = document.createElement('li');
    li.className = `plan-item ${item.status}`;
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.setAttribute('aria-hidden', 'true');
    const title = document.createElement('h3');
    title.textContent = item.title;
    const meta = document.createElement('p');
    meta.className = 'meta';
    const files = Array.isArray(item.files) && item.files.length
      ? item.files.join(', ')
      : item.kind === 'tests'
        ? 'tests'
        : 'implementation';
    const kind = item.kind === 'tests' ? 'tests' : item.kind === 'code' ? 'code' : '';
    meta.textContent = kind
      ? `${kind} · ${item.status} · ${files}`
      : `${item.status} · ${files}`;
    li.append(mark, title, meta);
    els.plan.append(li);
  }
}

function renderTimeline(task) {
  els.timeline.replaceChildren();
  const events = Array.isArray(task?.timeline) ? task.timeline : [];
  for (const event of events) {
    const li = document.createElement('li');
    const fail = /fail|reject|request/i.test(event.title);
    li.className = `card ${event.role}${fail ? ' fail' : ''}`;
    const kicker = document.createElement('p');
    kicker.className = 'kicker';
    kicker.textContent = ROLE_KICKER[event.role] ?? event.role;
    const title = document.createElement('h3');
    title.textContent = event.title;
    const body = document.createElement('p');
    body.textContent = event.body || '';
    li.append(kicker, title);
    if (event.body) li.append(body);
    els.timeline.append(li);
  }
}

function renderThread(project) {
  const messages = Array.isArray(project?.messages) ? project.messages : [];
  if (!els.thread) return;
  if (!project) {
    els.thread.hidden = true;
    els.thread.replaceChildren();
    return;
  }
  els.thread.hidden = messages.length === 0;
  els.thread.replaceChildren();
  for (const message of messages) {
    const li = document.createElement('li');
    li.className = `msg ${message.role}`;
    const who = document.createElement('p');
    who.className = 'who';
    who.textContent = message.role === 'user' ? 'You' : 'Orchestrator';
    const body = document.createElement('p');
    body.textContent = message.text;
    li.append(who, body);
    els.thread.append(li);
  }
  els.thread.scrollTop = els.thread.scrollHeight;
}

function filesFromSnapshot(snapshot, task) {
  const files = Array.isArray(task?.outputFiles) ? task.outputFiles : [];
  if (files.length > 0) return files;
  const previous = [...(snapshot?.tasks ?? [])]
    .reverse()
    .find((item) => Array.isArray(item.outputFiles) && item.outputFiles.length > 0);
  return previous?.outputFiles ?? [];
}

function renderFiles(task, snapshot) {
  const files = filesFromSnapshot(snapshot, task);
  if (files.length === 0) {
    els.fileTabs.hidden = true;
    els.fileView.hidden = true;
    els.filesEmpty.hidden = false;
    els.filesHint.textContent = 'Output appears here';
    els.fileTabs.replaceChildren();
    els.fileView.textContent = '';
    selectedFile = null;
    return;
  }

  els.filesEmpty.hidden = true;
  els.fileTabs.hidden = false;
  els.fileView.hidden = false;
  els.filesHint.textContent = `${files.length} file${files.length === 1 ? '' : 's'}`;

  if (!selectedFile || !files.some((file) => file.path === selectedFile)) {
    selectedFile = files[0].path;
  }

  els.fileTabs.replaceChildren();
  for (const file of files) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = file.locked ? `${file.path} (locked)` : file.path;
    button.className = file.path === selectedFile ? 'active' : '';
    button.addEventListener('click', () => {
      selectedFile = file.path;
      renderFiles(lastTask, { tasks: snapshot?.tasks ?? [] });
    });
    els.fileTabs.append(button);
  }

  const active = files.find((file) => file.path === selectedFile) ?? files[0];
  els.fileView.textContent = active.content;
}

function renderComposer(project) {
  const open = Boolean(project);
  els.form.hidden = open;
  els.followForm.hidden = !open;
  if (els.reset) els.reset.hidden = !open;
  els.appTitle.textContent = open ? project.title : 'New project';
  if (els.oracleChip) {
    els.oracleChip.hidden = !open;
    if (open) {
      const locked = (project.oraclePaths ?? []).join(', ');
      els.oracleChip.textContent = locked
        ? `Locked · ${locked}`
        : 'Tests not frozen yet';
      els.oracleChip.classList.toggle('open', !locked);
    } else {
      els.oracleChip.textContent = '';
    }
  }
  if (els.sourceReadout) {
    els.sourceReadout.hidden = !open;
    els.sourceReadout.textContent = open ? project.sourceDir : '';
  }
}

function render(snapshot) {
  applyDefaults();
  applySlotBusy(snapshot?.slots ?? []);
  const project = snapshot?.project ?? null;
  const task =
    (project?.activeTaskId
      ? (snapshot?.tasks ?? []).find((item) => item.id === project.activeTaskId)
      : null) ??
    (snapshot?.tasks ?? []).at(-1) ??
    null;
  lastTask = task;
  lastProject = project;

  renderComposer(project);
  renderThread(project);
  renderPlan(project);

  if (!task && !project) {
    els.empty.hidden = false;
    els.job.hidden = true;
    els.status.hidden = true;
    renderFiles(null, snapshot);
    updateActions(null);
    return;
  }

  if (els.reset) els.reset.hidden = !project;
  els.empty.hidden = true;
  els.job.hidden = false;
  if (task) {
    els.status.hidden = false;
    els.status.className = `badge ${task.status}`;
    els.status.textContent = STATUS_LABELS[task.status] ?? task.status;
    els.attempt.textContent =
      task.status === 'queued'
        ? 'Starting…'
        : `Pass ${task.currentIteration} of ${task.maxIterations}`;
    renderSteps(task);
    renderTimeline(task);
    els.logs.textContent = Array.isArray(task.logs) ? task.logs.join('\n') : '';
    els.lastError.hidden = !task.lastError;
    els.lastError.textContent = task.lastError || '';
    if (task.commitSha) {
      els.shaLine.hidden = false;
      els.shaLine.textContent = `Snapshot ${task.commitSha.slice(0, 12)}`;
    } else {
      els.shaLine.hidden = true;
      els.shaLine.textContent = '';
    }
  } else {
    els.status.hidden = true;
    els.attempt.textContent = project ? project.goal : '';
    els.steps.replaceChildren();
    els.timeline.replaceChildren();
    els.shaLine.hidden = true;
  }
  renderFiles(task, snapshot);
  updateActions(task);
}

async function readErrorMessage(res) {
  try {
    const body = await res.json();
    if (body?.error?.message) return body.error.message;
  } catch {
    /* ignore */
  }
  return `Request failed (${res.status})`;
}

async function fetchState() {
  const res = await fetch(`${API}/api/state`);
  if (!res.ok) throw new Error('state');
  return res.json();
}

async function poll() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const snapshot = await fetchState();
    setUnreachable(false);
    render(snapshot);
  } catch {
    setUnreachable(true);
    updateActions(lastTask);
  } finally {
    pollInFlight = false;
  }
}

async function cancelCurrent() {
  if (!lastTask?.id) return;
  setFormError('');
  try {
    const res = await fetch(`${API}/api/tasks/${lastTask.id}/cancel`, {
      method: 'POST',
    });
    if (!res.ok) setFormError(await readErrorMessage(res));
    else await poll();
  } catch {
    setUnreachable(true);
  }
}

function hideResetConfirm() {
  if (els.resetConfirm) els.resetConfirm.hidden = true;
}

function showResetConfirm() {
  if (els.resetConfirm) els.resetConfirm.hidden = false;
}

async function resetAll() {
  hideResetConfirm();
  setFormError('');
  selectedFile = null;
  defaultsApplied = false;
  userTouchedForm = false;
  if (els.sourceDir) els.sourceDir.value = '';
  if (els.title) els.title.value = '';
  if (els.prompt) els.prompt.value = '';
  try {
    const res = await fetch(`${API}/api/reset`, { method: 'POST' });
    if (!res.ok) setFormError(await readErrorMessage(res));
    else await poll();
  } catch {
    setUnreachable(true);
  }
}

els.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setFormError('');
  selectedFile = null;
  const goal = els.prompt.value.trim();
  if (!goal) {
    setFormError('Describe a goal first');
    return;
  }
  try {
    const res = await fetch(`${API}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: els.title.value.trim() || 'Untitled',
        goal,
        ...(els.sourceDir.value.trim()
          ? { sourceDir: els.sourceDir.value.trim() }
          : {}),
        writerProvider: els.provider.value,
        maxIterations: 2,
        testCommand: ['node', '--test'],
        ...(els.reviewerProvider?.value
          ? { reviewerProvider: els.reviewerProvider.value }
          : {}),
        ...(els.orchestratorProvider?.value
          ? { plannerProvider: els.orchestratorProvider.value }
          : {}),
      }),
    });
    if (!res.ok) {
      setFormError(await readErrorMessage(res));
      return;
    }
    await poll();
  } catch {
    setUnreachable(true);
    setFormError('Can’t reach LoopSync on :4055');
  }
});

els.followForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!lastProject?.id) return;
  const text = els.followup.value.trim();
  if (!text) {
    setFormError('Write a follow-up first');
    return;
  }
  setFormError('');
  try {
    const res = await fetch(`${API}/api/projects/${lastProject.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      setFormError(await readErrorMessage(res));
      return;
    }
    els.followup.value = '';
    await poll();
  } catch {
    setUnreachable(true);
    setFormError('Can’t reach LoopSync on :4055');
  }
});

els.cancel.addEventListener('click', cancelCurrent);
els.followCancel.addEventListener('click', cancelCurrent);
els.reset?.addEventListener('click', showResetConfirm);
els.resetYes?.addEventListener('click', resetAll);
els.resetNo?.addEventListener('click', hideResetConfirm);
els.resetConfirm?.addEventListener('click', (event) => {
  if (event.target === els.resetConfirm) hideResetConfirm();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') hideResetConfirm();
});
for (const field of [els.sourceDir, els.title, els.prompt]) {
  field?.addEventListener('input', markFormTouched);
}

els.provider.addEventListener('change', () => updateActions(lastTask));
els.reviewerProvider?.addEventListener('change', () => updateActions(lastTask));
els.orchestratorProvider?.addEventListener('change', () => updateActions(lastTask));

scrubHomeworkAutofill();
window.addEventListener('load', scrubHomeworkAutofill);
setTimeout(scrubHomeworkAutofill, 0);
setTimeout(scrubHomeworkAutofill, 400);
poll();
setInterval(poll, POLL_MS);
