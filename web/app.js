const API = '';
const USE_MOCK = false;
const POLL_MS = 300;

const MOCK_SUCCEEDED = {
  tasks: [
    {
      id: 'task_01hxyz',
      title: 'Fix Off-By-One Index in Array Parser',
      prompt:
        'The test in parse.test.js fails. Make parseIndex return the correct value so the test passes. Do not change the test. Do not ask questions. Do not run git commit.',
      provider: 'codex',
      status: 'succeeded',
      currentIteration: 1,
      maxIterations: 2,
      workspaceDir: '/tmp/loopsync-workspaces/task_01hxyz',
      logs: [
        '[loop] attempt 1/2 provider=codex',
        '[codex] Updated parseIndex to return text.length.',
        '[tests] pass exit=0',
        '[git] committed 2e38bf1',
      ],
      diff: 'diff --git a/parse.js b/parse.js\n--- a/parse.js\n+++ b/parse.js\n@@ -1 +1 @@\n-export function parseIndex(text) { return text.length - 1; }\n+export function parseIndex(text) { return text.length; }\n',
      commitSha: '2e38bf1086d1d962ddbb5fd06b3970769d32c637',
    },
  ],
  slots: [
    { provider: 'claude', isBusy: false },
    { provider: 'codex', isBusy: false },
  ],
};

const STATUS_LABELS = {
  queued: 'Queued',
  running: 'Running',
  retrying: 'Retrying',
  succeeded: 'Succeeded',
  failed: 'Failed',
};

const els = {
  unreachable: document.getElementById('unreachable'),
  form: document.getElementById('launch-form'),
  title: document.getElementById('title'),
  prompt: document.getElementById('prompt'),
  provider: document.getElementById('provider'),
  formError: document.getElementById('formError'),
  launch: document.getElementById('launch'),
  cancel: document.getElementById('cancel'),
  reset: document.getElementById('reset'),
  empty: document.getElementById('empty'),
  job: document.getElementById('job'),
  status: document.getElementById('status'),
  attempt: document.getElementById('attempt'),
  logs: document.getElementById('logs'),
  lastError: document.getElementById('lastError'),
  lastErrorWrap: document.getElementById('lastErrorWrap'),
  diff: document.getElementById('diff'),
  diffWrap: document.getElementById('diffWrap'),
  sha: document.getElementById('sha'),
  shaWrap: document.getElementById('shaWrap'),
};

let lastTask = null;
let reachable = true;
let pollInFlight = false;
let pollPaused = false;

function setUnreachable(isUnreachable) {
  reachable = !isUnreachable;
  els.unreachable.hidden = !isUnreachable;
}

function setFormError(message) {
  if (!message) {
    els.formError.hidden = true;
    els.formError.textContent = '';
    return;
  }
  els.formError.hidden = false;
  els.formError.textContent = message;
}

function setHidden(el, hidden) {
  if (!el) return;
  el.hidden = hidden;
}

function applySlotBusy(slots) {
  const list = Array.isArray(slots) ? slots : [];
  for (const option of els.provider.options) {
    const slot = list.find((item) => item.provider === option.value);
    option.disabled = Boolean(slot?.isBusy);
  }
}

function updateActions(task) {
  const selected = els.provider.selectedOptions[0];
  const selectedBusy = Boolean(selected?.disabled);
  const inFlight =
    task &&
    (task.status === 'queued' ||
      task.status === 'running' ||
      task.status === 'retrying');

  els.launch.disabled = !reachable || selectedBusy;
  els.cancel.disabled = !reachable || !inFlight;
  els.reset.disabled = !reachable;
}

function render(snapshot) {
  const slots = snapshot?.slots ?? [];
  applySlotBusy(slots);

  const tasks = snapshot?.tasks ?? [];
  const task = tasks.at(-1);

  lastTask = task ?? null;

  if (!task) {
    setHidden(els.empty, false);
    setHidden(els.job, true);
    els.status.textContent = '';
    els.status.className = 'badge';
    els.attempt.textContent = '';
    els.logs.textContent = '';
    els.lastError.textContent = '';
    els.diff.textContent = '';
    els.sha.textContent = '';
    setHidden(els.lastErrorWrap, true);
    setHidden(els.diffWrap, true);
    setHidden(els.shaWrap, true);
    updateActions(null);
    return;
  }

  setHidden(els.empty, true);
  setHidden(els.job, false);

  const status = task.status;
  els.status.className = `badge ${status}`;
  els.status.textContent = STATUS_LABELS[status] ?? status;
  els.attempt.textContent = `Attempt ${task.currentIteration}/${task.maxIterations}`;
  els.logs.textContent = Array.isArray(task.logs) ? task.logs.join('\n') : '';
  els.logs.scrollTop = els.logs.scrollHeight;

  const showError = status === 'retrying' || status === 'failed';
  setHidden(els.lastErrorWrap, !showError);
  els.lastError.textContent = showError && task.lastError ? task.lastError : '';

  const showSuccess = status === 'succeeded';
  setHidden(els.diffWrap, !showSuccess);
  setHidden(els.shaWrap, !showSuccess);
  els.diff.textContent = showSuccess && task.diff ? task.diff : '';
  els.sha.textContent = showSuccess && task.commitSha ? task.commitSha : '';

  updateActions(task);
}

async function readErrorMessage(res) {
  try {
    const body = await res.json();
    if (body?.error?.message) return body.error.message;
  } catch {
    /* ignore non-JSON */
  }
  return `Request failed (${res.status})`;
}

async function fetchState() {
  if (USE_MOCK) {
    return MOCK_SUCCEEDED;
  }
  const res = await fetch(`${API}/api/state`);
  if (!res.ok) {
    throw new Error('state');
  }
  return res.json();
}

async function poll() {
  if (pollPaused || pollInFlight) return;
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
  try {
    const res = await fetch(`${API}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: els.title.value,
        prompt: els.prompt.value,
        provider: els.provider.value,
        maxIterations: 2,
      }),
    });
    if (!res.ok) {
      setFormError(await readErrorMessage(res));
      return;
    }
    await poll();
  } catch {
    setUnreachable(true);
    updateActions(lastTask);
    setFormError('Cannot reach orchestrator on :4055');
  }
});

els.cancel.addEventListener('click', async () => {
  if (!lastTask?.id) return;
  setFormError('');
  try {
    const res = await fetch(`${API}/api/tasks/${lastTask.id}/cancel`, {
      method: 'POST',
    });
    if (!res.ok) {
      setFormError(await readErrorMessage(res));
      return;
    }
    await poll();
  } catch {
    setUnreachable(true);
    updateActions(lastTask);
    setFormError('Cannot reach orchestrator on :4055');
  }
});

els.reset.addEventListener('click', async () => {
  setFormError('');
  try {
    const res = await fetch(`${API}/api/reset`, { method: 'POST' });
    if (!res.ok) {
      setFormError(await readErrorMessage(res));
      return;
    }
    await poll();
  } catch {
    setUnreachable(true);
    updateActions(lastTask);
    setFormError('Cannot reach orchestrator on :4055');
  }
});

els.provider.addEventListener('change', () => {
  updateActions(lastTask);
});

poll();
setInterval(poll, POLL_MS);

globalThis.render = render;
globalThis.pausePoll = () => {
  pollPaused = true;
};
