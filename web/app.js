const API = '';
const USE_MOCK = false;
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
  title: document.getElementById('title'),
  prompt: document.getElementById('prompt'),
  provider: document.getElementById('provider'),
  orchestratorProvider: document.getElementById('orchestratorProvider'),
  reviewerProvider: document.getElementById('reviewerProvider'),
  formError: document.getElementById('formError'),
  launch: document.getElementById('launch'),
  cancel: document.getElementById('cancel'),
  reset: document.getElementById('reset'),
  empty: document.getElementById('empty'),
  job: document.getElementById('job'),
  status: document.getElementById('status'),
  attempt: document.getElementById('attempt'),
  steps: document.getElementById('steps'),
  timeline: document.getElementById('timeline'),
  shaLine: document.getElementById('shaLine'),
  logs: document.getElementById('logs'),
  lastError: document.getElementById('lastError'),
  filesHint: document.getElementById('filesHint'),
  fileTabs: document.getElementById('fileTabs'),
  fileView: document.getElementById('fileView'),
  filesEmpty: document.getElementById('filesEmpty'),
};

let lastTask = null;
let reachable = true;
let pollInFlight = false;
let selectedFile = null;

function setUnreachable(isUnreachable) {
  reachable = !isUnreachable;
  els.unreachable.hidden = !isUnreachable;
}

function setFormError(message) {
  els.formError.hidden = !message;
  els.formError.textContent = message || '';
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

function updateActions(task) {
  const selectedBusy = Boolean(els.provider.selectedOptions[0]?.disabled);
  const inFlight =
    task &&
    (task.status === 'queued' ||
      task.status === 'running' ||
      task.status === 'retrying');
  els.launch.disabled = !reachable || selectedBusy;
  els.cancel.disabled = !reachable || !inFlight;
  els.reset.disabled = !reachable;
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

function renderFiles(task) {
  const files = Array.isArray(task?.outputFiles) ? task.outputFiles : [];
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
    button.textContent = file.path;
    button.className = file.path === selectedFile ? 'active' : '';
    button.addEventListener('click', () => {
      selectedFile = file.path;
      renderFiles(lastTask);
    });
    els.fileTabs.append(button);
  }

  const active = files.find((file) => file.path === selectedFile) ?? files[0];
  els.fileView.textContent = active.content;
}

function render(snapshot) {
  applySlotBusy(snapshot?.slots ?? []);
  const task = (snapshot?.tasks ?? []).at(-1) ?? null;
  lastTask = task;

  if (!task) {
    els.empty.hidden = false;
    els.job.hidden = true;
    els.status.hidden = true;
    renderFiles(null);
    updateActions(null);
    return;
  }

  els.empty.hidden = true;
  els.job.hidden = false;
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
  renderFiles(task);
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

els.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setFormError('');
  selectedFile = null;
  try {
    const res = await fetch(`${API}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: els.title.value,
        prompt: els.prompt.value,
        provider: els.provider.value,
        maxIterations: 2,
        ...(els.reviewerProvider?.value
          ? { reviewerProvider: els.reviewerProvider.value }
          : {}),
        ...(els.orchestratorProvider?.value
          ? { orchestratorProvider: els.orchestratorProvider.value }
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

els.cancel.addEventListener('click', async () => {
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
});

els.reset.addEventListener('click', async () => {
  setFormError('');
  selectedFile = null;
  try {
    const res = await fetch(`${API}/api/reset`, { method: 'POST' });
    if (!res.ok) setFormError(await readErrorMessage(res));
    else await poll();
  } catch {
    setUnreachable(true);
  }
});

els.provider.addEventListener('change', () => updateActions(lastTask));
els.reviewerProvider?.addEventListener('change', () => updateActions(lastTask));
els.orchestratorProvider?.addEventListener('change', () => updateActions(lastTask));

poll();
setInterval(poll, POLL_MS);
