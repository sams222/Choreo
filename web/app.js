const API = '';
const POLL_MS = 300;

const STATUS_LABELS = {
  queued: 'Queued',
  running: 'Running',
  retrying: 'Retrying',
  succeeded: 'Done',
  failed: 'Failed',
};

const ROLE_WHO = {
  plan: 'Orchestrator',
  writer: 'Code writer',
  tests: 'Test runner',
  review: 'Reviewer',
  git: 'Saver',
  loop: 'LoopSync',
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
  status: document.getElementById('status'),
  plan: document.getElementById('plan'),
  feed: document.getElementById('feed'),
  now: document.getElementById('now'),
  nowHeadline: document.getElementById('nowHeadline'),
  nowSub: document.getElementById('nowSub'),
  elapsed: document.getElementById('elapsed'),
  oracleChip: document.getElementById('oracleChip'),
  sourceReadout: document.getElementById('sourceReadout'),
  appTitle: document.getElementById('app-title'),
  stage: document.querySelector('.stage'),
};

let lastTask = null;
let lastProject = null;
let lastSnapshot = null;
let reachable = true;
let pollInFlight = false;
let defaultsApplied = false;
let lastFeedKeys = '';
let pinnedToBottom = true;
let clock = { key: '', t0: Date.now() };

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

function applySlotBusy(slots) {
  const list = Array.isArray(slots) ? slots : [];
  for (const select of [
    els.provider,
    els.reviewerProvider,
    els.orchestratorProvider,
  ]) {
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
  const selectedBusy = [els.provider, els.reviewerProvider, els.orchestratorProvider]
    .filter(Boolean)
    .some((select) => Boolean(select.value && select.selectedOptions[0]?.disabled));
  const inFlight = isInFlight(task);

  if (els.launch) els.launch.disabled = !reachable || selectedBusy;
  if (els.send) els.send.disabled = !reachable || inFlight;
  for (const button of [els.cancel, els.followCancel]) {
    if (button) button.disabled = !reachable || !isInFlight(task);
  }
  if (els.reset) els.reset.disabled = !reachable;
}

function prettyProvider(value) {
  if (value === 'codex') return 'Codex';
  if (value === 'claude') return 'Claude';
  return value || '';
}

function writerWho(task) {
  if (task?.jobKind === 'tests') return 'Unit test writer';
  return 'Code writer';
}

function whoFor(role, task) {
  if (role === 'writer') return writerWho(task);
  return ROLE_WHO[role] ?? role;
}

function itemForTask(project, task) {
  if (!project || !task) return null;
  return (project.plan ?? []).find((item) => item.taskId === task.id) ?? null;
}

function filesLabel(item, task) {
  const files =
    (Array.isArray(item?.files) && item.files.length && item.files) ||
    (task?.outputFiles ?? []).map((file) => file.path);
  return files.length ? files.join(', ') : '';
}

function liveFor(task, project) {
  const item = itemForTask(project, task);
  const files = filesLabel(item, task);
  const provider = prettyProvider(
    task.currentStep === 'plan'
      ? task.orchestratorProvider
      : task.currentStep === 'review'
        ? task.reviewerProvider
        : task.provider,
  );
  const step = task.currentStep;
  let headline = 'Awaiting the orchestrator';
  let sub = 'Opening the loop.';
  let who = 'Orchestrator';
  let role = 'plan';

  if (task.status === 'queued') {
    headline = 'Opening a workspace';
    sub = 'LoopSync is preparing an isolated git tree.';
    who = 'LoopSync';
    role = 'loop';
  } else if (step === 'plan') {
    who = 'Orchestrator';
    headline = 'Awaiting the orchestrator';
    role = 'plan';
    sub = provider
      ? `${provider} is splitting tests and implementation into separate steps.`
      : 'Planning tests and implementation as separate steps.';
  } else if (step === 'writer' && task.jobKind === 'tests') {
    who = 'Unit test writer';
    headline = 'Awaiting the unit test writer';
    role = 'tests';
    sub = files
      ? `Working on ${files}. Assertions only — no production code yet.`
      : 'Writing the tests that will freeze as the oracle.';
  } else if (step === 'writer') {
    who = 'Code writer';
    headline = 'Awaiting the code writer';
    role = 'writer';
    sub = files
      ? `Making changes in ${files}. Locked tests stay frozen.`
      : 'Implementing against the frozen tests.';
  } else if (step === 'tests') {
    who = 'Test runner';
    headline = 'Awaiting the test runner';
    role = 'tests';
    sub = 'node --test is the only SHA veto.';
  } else if (step === 'oracle') {
    who = 'LoopSync';
    headline = 'Checking the locked tests';
    role = 'tests';
    sub = 'The oracle cannot move. A dirty test file cannot commit.';
  } else if (step === 'review') {
    who = 'Reviewer';
    headline = 'Awaiting the reviewer';
    role = 'review';
    sub = provider
      ? `${provider} is reading the diff against the contract.`
      : 'Adversarial review of the change.';
  } else if (step === 'git') {
    who = 'Saver';
    headline = 'Saving a snapshot';
    role = 'git';
    sub = 'Coding agents never git commit. Node owns the SHA.';
  }

  if (item?.title && step === 'writer') {
    sub = `Working on “${item.title}”${files ? ` · ${files}` : ''}.`;
  }
  if (provider && !sub.includes(provider) && who !== 'LoopSync') {
    sub = `${provider} · ${sub}`;
  }
  return { who, headline, sub, role };
}

function liveAgents(snapshot) {
  const project = snapshot?.project ?? null;
  const tasks = (snapshot?.tasks ?? []).filter(isInFlight);
  const agents = tasks.map((task) => liveFor(task, project));
  if (project?.shards && tasks.length === 0) {
    agents.push({
      who: 'Orchestrator',
      headline: 'Merging the test tree with the implementation',
      sub: 'Two processes finished. LoopSync is combining shards before tests can freeze.',
      role: 'plan',
      key: 'merge',
    });
  }
  return agents;
}

function nowCopy(snapshot, task, project) {
  const agents = liveAgents(snapshot);
  if (agents.length >= 2) {
    return {
      mode: 'live',
      headline: 'Awaiting the unit test writer and the code writer',
      sub: 'Two processes, two contexts. Tests will freeze before a SHA.',
    };
  }
  if (agents.length === 1) {
    return { mode: 'live', headline: agents[0].headline, sub: agents[0].sub };
  }
  if (task?.status === 'succeeded') {
    const sha = task.commitSha ? task.commitSha.slice(0, 12) : '';
    return {
      mode: 'done',
      headline: sha ? `Done — snapshot ${sha}` : 'Done — tests frozen',
      sub: 'Steer the orchestrator if you want a change. Locked tests stay locked.',
    };
  }
  if (task?.status === 'failed') {
    return {
      mode: 'fail',
      headline: 'The loop stopped',
      sub: task.lastError || 'See the thread for the veto.',
    };
  }
  if (project && !task) {
    return {
      mode: 'idle',
      headline: 'Awaiting the orchestrator',
      sub: 'The next judged step has not started yet.',
    };
  }
  return {
    mode: 'idle',
    headline: 'Ready when you are',
    sub: 'Tests and implementation run as separate processes. The tests freeze before a SHA.',
  };
}

function clockKey(snapshot) {
  const agents = liveAgents(snapshot);
  if (agents.length === 0) return '';
  const tasks = (snapshot?.tasks ?? []).filter(isInFlight);
  return (
    tasks.map((task) => `${task.id}:${task.currentStep ?? task.status}`).join('|') ||
    'merge'
  );
}

function formatElapsed(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function tickClock() {
  if (!els.elapsed) return;
  const key = clockKey(lastSnapshot);
  if (key !== clock.key) {
    clock = { key, t0: Date.now() };
  }
  if (!key) {
    els.elapsed.hidden = true;
    els.elapsed.textContent = '';
    return;
  }
  els.elapsed.hidden = false;
  els.elapsed.textContent = formatElapsed(Date.now() - clock.t0);
  if (!lastSnapshot) return;
  const items = buildFeed(lastSnapshot);
  for (const item of items) {
    if (item.type !== 'working') continue;
    const node = els.feed?.querySelector(`[data-key="${CSS.escape(item.key)}"]`);
    const stream = node?.querySelector('.stream');
    if (stream && !item.stream) stream.textContent = waitingBeat();
  }
}

const WAIT_BEATS = [
  'Still waiting — the process is up, no tokens yet.',
  'Awaiting tokens from the CLI.',
  'No output yet. The process is still running.',
];

function waitingBeat() {
  return WAIT_BEATS[Math.floor(Date.now() / 2000) % WAIT_BEATS.length];
}

function streamText(item) {
  return item.stream || waitingBeat();
}

function usefulLogs(task) {
  const lines = (task?.logs ?? [])
    .map((line) => String(line).replace(/^\[[^\]]+\]\s?/, '').trim())
    .filter(Boolean);
  const tail = lines.slice(-8);
  return tail.join('\n');
}

function filesFromTask(task) {
  return Array.isArray(task?.outputFiles) ? task.outputFiles : [];
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
    li.className = item.status || 'pending';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');
    const title = document.createElement('h3');
    title.textContent = item.title;
    const meta = document.createElement('p');
    meta.className = 'meta';
    const kind = item.kind === 'tests' ? 'unit tests' : item.kind === 'code' ? 'implementation' : 'step';
    const files = Array.isArray(item.files) && item.files.length ? item.files.join(', ') : kind;
    meta.textContent =
      item.status === 'running'
        ? `in progress · ${files}`
        : item.status === 'succeeded'
          ? `done · ${files}`
          : item.status === 'failed'
            ? `stopped · ${files}`
            : `waiting · ${files}`;
    li.append(dot, title, meta);
    els.plan.append(li);
  }
}

function fileChips(files) {
  if (!files.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'files';
  for (const file of files) {
    const chip = document.createElement('div');
    chip.className = file.locked ? 'file-chip locked' : 'file-chip';
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = file.locked ? `${file.path} · locked` : file.path;
    const pre = document.createElement('pre');
    const content = String(file.content || '');
    const lines = content.split('\n');
    pre.textContent = lines.slice(0, 14).join('\n') + (lines.length > 14 ? '\n…' : '');
    details.append(summary, pre);
    chip.append(details);
    wrap.append(chip);
  }
  return wrap;
}

function dotsEl() {
  const span = document.createElement('span');
  span.className = 'dots';
  span.setAttribute('aria-hidden', 'true');
  span.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
  return span;
}

function pushMessage(items, message) {
  items.push({
    key: message.id,
    type: message.role,
    role: message.role,
    who: message.role === 'user' ? 'You' : 'Orchestrator',
    title: '',
    body: message.text,
  });
}

function pushTask(items, task, project, seenWriterFiles) {
  const skipPlan = (project?.messages ?? []).some((message) => message.role === 'orchestrator');
  for (const event of task.timeline ?? []) {
    if (skipPlan && event.role === 'plan') continue;
    const showFiles =
      (event.role === 'writer' || event.role === 'tests' || event.role === 'git') &&
      !seenWriterFiles.has(task.id);
    if (showFiles) seenWriterFiles.add(task.id);
    items.push({
      key: `${task.id}:${event.id}`,
      type: 'event',
      role: event.role,
      who: whoFor(event.role, task),
      title: event.title,
      body: event.body,
      files: showFiles ? filesFromTask(task) : [],
    });
  }
  if (isInFlight(task)) {
    const live = liveFor(task, project);
    items.push({
      key: `live:${task.id}:${task.currentStep ?? task.status}`,
      type: 'working',
      role: live.role,
      who: live.who,
      title: live.headline,
      body: live.sub,
      stream: usefulLogs(task),
    });
  }
}

function buildFeed(snapshot) {
  const project = snapshot?.project ?? null;
  const tasks = snapshot?.tasks ?? [];
  const items = [];
  const seenWriterFiles = new Set();
  const msgs = project?.messages ?? [];

  if (!project) {
    if (tasks[0]) {
      items.push({
        key: `goal:${tasks[0].id}`,
        type: 'user',
        role: 'user',
        who: 'You',
        title: '',
        body: tasks[0].prompt,
      });
    }
    for (const task of tasks) pushTask(items, task, project, seenWriterFiles);
    return items;
  }

  const userIdx = [];
  msgs.forEach((message, index) => {
    if (message.role === 'user') userIdx.push(index);
  });
  const extraUsers = Math.max(0, userIdx.length - 1);
  const initialCount = Math.max(0, tasks.length - extraUsers);
  let ti = 0;

  if (userIdx.length === 0) {
    for (const task of tasks) pushTask(items, task, project, seenWriterFiles);
  } else {
    for (let u = 0; u < userIdx.length; u += 1) {
      const from = userIdx[u];
      const to = u + 1 < userIdx.length ? userIdx[u + 1] : msgs.length;
      for (let i = from; i < to; i += 1) pushMessage(items, msgs[i]);
      const take = u === 0 ? initialCount : 1;
      for (let k = 0; k < take && ti < tasks.length; k += 1, ti += 1) {
        pushTask(items, tasks[ti], project, seenWriterFiles);
      }
    }
  }
  while (ti < tasks.length) {
    pushTask(items, tasks[ti], project, seenWriterFiles);
    ti += 1;
  }

  if (project.shards && !tasks.some(isInFlight)) {
    items.push({
      key: 'merge',
      type: 'working',
      role: 'plan',
      who: 'Orchestrator',
      title: 'Merging the test tree with the implementation',
      body: 'Two processes finished. Combining shards before tests can freeze.',
      stream: '',
    });
  }

  return items;
}

function renderBubble(item) {
  const li = document.createElement('li');
  const roleClass = item.type === 'working' ? 'working' : item.role;
  li.className = `bubble ${roleClass}`;
  li.dataset.key = item.key;

  const who = document.createElement('p');
  who.className = 'who';
  who.textContent = item.who;

  const title = document.createElement('h3');
  if (item.type === 'working') {
    title.append(document.createTextNode(item.title), dotsEl());
  } else if (item.title) {
    title.textContent = item.title;
  }

  const body = document.createElement('p');
  body.className = 'sub';
  body.textContent = item.body || '';

  li.append(who);
  if (item.title) li.append(title);
  if (item.body) li.append(body);

  if (item.type === 'working') {
    const stream = document.createElement('pre');
    stream.className = 'stream';
    stream.textContent = streamText(item);
    li.classList.toggle('idle-stream', !item.stream);
    li.append(stream);
  }

  if (item.files?.length) {
    const chips = fileChips(item.files);
    if (chips) li.append(chips);
  }
  return li;
}

function renderFeed(snapshot) {
  if (!els.feed) return;
  const items = buildFeed(snapshot);
  const keys = items.map((item) => item.key).join('|');
  if (keys !== lastFeedKeys) {
    lastFeedKeys = keys;
    els.feed.replaceChildren(...items.map(renderBubble));
    scrollStage();
    return;
  }
  for (const item of items) {
    if (item.type !== 'working') continue;
    const node = els.feed.querySelector(`[data-key="${CSS.escape(item.key)}"]`);
    if (!node) continue;
    const stream = node.querySelector('.stream');
    if (stream) {
      stream.textContent = streamText(item);
    }
    node.classList.toggle('idle-stream', !item.stream);
    const sub = node.querySelector('.sub');
    if (sub && item.body) sub.textContent = item.body;
  }
  scrollStage();
}

function scrollStage() {
  const scroller = els.stage ?? els.feed;
  if (!scroller || !pinnedToBottom) return;
  scroller.scrollTop = scroller.scrollHeight;
}

function renderNow(snapshot, task, project) {
  const copy = nowCopy(snapshot, task, project);
  els.nowHeadline.textContent = copy.headline;
  els.nowSub.textContent = copy.sub;
  els.now.className = `now ${copy.mode}`;
  document.body.classList.toggle('busy', copy.mode === 'live');
  if (task) {
    els.status.hidden = false;
    els.status.className = `badge ${task.status}`;
    els.status.textContent = STATUS_LABELS[task.status] ?? task.status;
  } else if (project?.shards) {
    els.status.hidden = false;
    els.status.className = 'badge running';
    els.status.textContent = 'Merging';
  } else {
    els.status.hidden = true;
  }
}

function renderComposer(project) {
  const open = Boolean(project);
  document.body.classList.toggle('session', open);
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
    els.sourceReadout.hidden = !open || !project.sourceDir;
    els.sourceReadout.textContent = open && project.sourceDir ? project.sourceDir : '';
  }
}

function render(snapshot) {
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
  lastSnapshot = snapshot;

  renderComposer(project);
  renderPlan(project);
  renderNow(snapshot, task, project);
  tickClock();

  const hasSession = Boolean(project || task);
  els.empty.hidden = hasSession;
  els.feed.hidden = !hasSession;
  if (hasSession) renderFeed(snapshot);
  else {
    lastFeedKeys = '';
    els.feed.replaceChildren();
  }
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
  defaultsApplied = false;
  userTouchedForm = false;
  lastFeedKeys = '';
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
  lastFeedKeys = '';
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
els.orchestratorProvider?.addEventListener('change', () =>
  updateActions(lastTask),
);

(els.stage ?? els.feed)?.addEventListener('scroll', () => {
  const el = els.stage ?? els.feed;
  pinnedToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
});

scrubHomeworkAutofill();
window.addEventListener('load', scrubHomeworkAutofill);
setTimeout(scrubHomeworkAutofill, 0);
setTimeout(scrubHomeworkAutofill, 400);
poll();
setInterval(poll, POLL_MS);
setInterval(tickClock, 250);
