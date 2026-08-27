const API = '';
/** Fallback cadence only — the SSE stream is the primary transport (P0.2). */
const POLL_MS = 300;
/** Mirrors CLI_TIMEOUT_MS in protocol/index.ts. */
const CLI_TIMEOUT_MS = 30 * 60_000;
const REPLAY_SPEED = 10;

const STATUS_LABELS = {
  queued: 'Queued',
  running: 'Running',
  retrying: 'Retrying',
  succeeded: 'Done',
  failed: 'Failed',
};

const PROVIDER_LABEL = { claude: 'Claude', codex: 'Codex' };

/** Status is never colour-only: every state carries a glyph too. */
const STEP_LABEL = { writer: 'write', tests: 'tests', review: 'review', git: 'git' };
const STEP_GLYPH = {
  pending: '○',
  running: '◐',
  ok: '✓',
  fail: '✕',
  skipped: '–',
};
const PLAN_GLYPH = {
  pending: '○',
  running: '◐',
  succeeded: '✓',
  failed: '✕',
};
const EVENT_GLYPH = {
  tool: '↳',
  text: '·',
  reasoning: '…',
  result: '✓',
  error: '!',
  start: '→',
};

const els = {};
for (const id of [
  'unreachable',
  'replayBanner',
  'composer',
  'settings',
  'settingsSummary',
  'title',
  'prompt',
  'sourceDir',
  'provider',
  'orchestratorProvider',
  'reviewerProvider',
  'maxIterations',
  'formError',
  'send',
  'apply',
  'cancel',
  'reset',
  'reset-confirm',
  'reset-yes',
  'reset-no',
  'empty',
  'status',
  'stepper',
  'slots',
  'feed',
  'elapsed',
  'oracleChip',
  'sourceReadout',
  'app-title',
  'composerHint',
]) {
  els[id.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = document.getElementById(id);
}
els.stage = document.querySelector('.stage');

let snapshot = null;
let lastTask = null;
let lastProject = null;
let reachable = true;
let pollInFlight = false;
let renderedKeys = '';
let pinnedToBottom = true;
let serverSkew = 0;
let stream = null;
let replay = null;
let seededLaunch = false;

function serverNow() {
  return Date.now() + serverSkew;
}

/* ---------------------------------------------------------------- helpers */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function providerAvatar(provider) {
  const avatar = el('span', `avatar provider-logo ${provider}`);
  avatar.setAttribute('aria-hidden', 'true');
  return avatar;
}

function formatElapsed(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function formatClock(ts) {
  if (!Number.isFinite(ts)) return '';
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function isInFlight(task) {
  return (
    task &&
    (task.status === 'queued' ||
      task.status === 'running' ||
      task.status === 'retrying')
  );
}

function taskById(id) {
  return (snapshot?.tasks ?? []).find((task) => task.id === id) ?? null;
}

/* ------------------------------------------------------------- identities */

/** §4 — provider is the identity, role is the label. */
function identity(item, provider) {
  const row = el('div', 'identity');
  const who = provider ?? item.provider;
  if (who) {
    row.append(providerAvatar(who));
    row.append(el('strong', `provider ${who}`, PROVIDER_LABEL[who]));
    row.append(el('span', 'sep', '·'));
  }
  row.append(el('span', 'role-label', item.who ?? ''));
  if (Number.isFinite(item.ts)) {
    const time = el('time', 'stamp', formatClock(item.ts));
    time.dateTime = new Date(item.ts).toISOString();
    row.append(time);
  }
  return row;
}

function badge(className, text) {
  return el('span', `chip ${className}`, text);
}

/* ------------------------------------------------------------ step track */

function stepTracker(steps) {
  const wrap = el('ol', 'steps');
  for (const step of steps ?? []) {
    const li = el('li', `step ${step.status}`);
    li.append(el('span', 'glyph', STEP_GLYPH[step.status] ?? '○'));
    li.append(el('span', 'name', STEP_LABEL[step.id] ?? step.id));
    const dur = formatDuration(step.durationMs);
    if (dur) li.append(el('span', 'dur', dur));
    li.append(el('span', 'sr', ` ${step.status}`));
    wrap.append(li);
  }
  return wrap;
}

/* ------------------------------------------------------------- activity */

/** P0.1 — real tool calls and prose from the CLI's JSON event stream. */
function activityFeed(task, limit = 6) {
  const wrap = el('div', 'activity');
  const events = (task?.events ?? []).filter(
    (event) => event.kind !== 'start' && event.kind !== 'result',
  );
  const shown = events.slice(-limit);
  if (shown.length === 0) {
    wrap.append(el('p', 'activity-idle', waitingLine(task)));
    return wrap;
  }
  for (const event of shown) {
    const line = el('p', `act ${event.kind}`);
    line.append(el('span', 'act-glyph', EVENT_GLYPH[event.kind] ?? '·'));
    if (event.kind === 'tool') {
      line.append(el('span', 'act-tool', event.tool ?? 'tool'));
      if (event.target) line.append(el('code', 'act-target', event.target));
    } else {
      line.append(el('span', 'act-text', event.text));
    }
    wrap.append(line);
  }
  return wrap;
}

/**
 * P1.8 — no canned "waiting beats". Show the real clock and how close the
 * process is to the CLI timeout, so a timeout on stage is never a surprise.
 */
function waitingLine(task) {
  const startedAt = currentStepStart(task) ?? task?.startedAt;
  if (!startedAt) return 'Starting the process…';
  const spent = Math.max(0, serverNow() - startedAt);
  return `Working · ${formatElapsed(spent)} elapsed`;
}

function currentStepStart(task) {
  const running = (task?.steps ?? []).find((step) => step.status === 'running');
  return running?.startedAt ?? null;
}

function timeoutMeter(task) {
  const startedAt = currentStepStart(task);
  if (!startedAt) return null;
  const spent = Math.max(0, serverNow() - startedAt);
  const ratio = Math.min(1, spent / CLI_TIMEOUT_MS);
  if (ratio < 0.75) return null;
  const wrap = el('div', 'meter');
  wrap.dataset.hot = ratio > 0.75 ? 'true' : 'false';
  const bar = el('span', 'meter-bar');
  bar.style.width = `${(ratio * 100).toFixed(1)}%`;
  wrap.append(bar);
  wrap.append(
    el('span', 'meter-text', 'Approaching the configured agent runtime limit'),
  );
  return wrap;
}

/* ----------------------------------------------------------------- files */

function fileChips(files) {
  if (!files?.length) return null;
  const wrap = el('div', 'files');
  for (const file of files) {
    const chip = el('div', file.locked ? 'file-chip locked' : 'file-chip');
    const details = document.createElement('details');
    const summary = el(
      'summary',
      null,
      file.locked ? `${file.path} · locked` : file.path,
    );
    const content = String(file.content || '');
    const lines = content.split('\n');
    const pre = el(
      'pre',
      null,
      lines.slice(0, 14).join('\n') + (lines.length > 14 ? '\n…' : ''),
    );
    details.append(summary, pre);
    chip.append(details);
    wrap.append(chip);
  }
  return wrap;
}

/* ------------------------------------------------------------------ diff */

/** P0.3 — the diff is the product. Hand-rolled +/- colouring, no CDN. */
function diffView(diff) {
  const wrap = el('div', 'diff');
  let added = 0;
  let removed = 0;
  for (const raw of String(diff).split('\n')) {
    if (raw.startsWith('index ') || raw.startsWith('diff --git ')) {
      if (raw.startsWith('diff --git ')) {
        wrap.append(el('p', 'diff-file', raw.replace(/^diff --git a\/\S+ b\//, '')));
      }
      continue;
    }
    let cls = 'ctx';
    if (raw.startsWith('+++') || raw.startsWith('---')) cls = 'meta';
    else if (raw.startsWith('@@')) cls = 'hunk';
    else if (raw.startsWith('+')) {
      cls = 'add';
      added += 1;
    } else if (raw.startsWith('-')) {
      cls = 'del';
      removed += 1;
    }
    wrap.append(el('p', `dl ${cls}`, raw || ' '));
  }
  const summary = el('p', 'diff-stat');
  summary.append(el('span', 'add', `+${added}`));
  summary.append(el('span', 'del', `−${removed}`));
  const box = el('div', 'diff-box');
  box.append(summary, wrap);
  return box;
}

/* ------------------------------------------------------------- plan card */

/** §3 — the plan lives in the thread, not in a disconnected strip. */
function planCard(item) {
  const card = el('div', 'plan-card');
  const list = el('ol', 'plan-items');
  for (const entry of item.plan ?? []) {
    const li = el('li', `plan-item ${entry.status}`);
    const head = el('p', 'plan-head');
    head.append(el('span', 'glyph', PLAN_GLYPH[entry.status] ?? '○'));
    head.append(el('span', 'plan-title', entry.title));
    head.append(
      badge(entry.kind === 'tests' ? 'kind tests' : 'kind code',
        entry.kind === 'tests' ? 'unit tests' : 'implementation'),
    );
    head.append(el('span', 'sr', ` — ${entry.status}`));
    li.append(head);
    if (entry.files?.length) {
      const files = el('p', 'plan-files');
      for (const file of entry.files) files.append(el('code', null, file));
      li.append(files);
    }
    if (entry.doneWhen) {
      li.append(el('p', 'plan-done', `Done when: ${entry.doneWhen}`));
    }
    list.append(li);
  }
  card.append(list);
  const delta = item.planDelta;
  if (delta && (delta.added.length || delta.removed.length || delta.changed.length)) {
    const box = el('div', 'plan-delta');
    if (delta.added.length) box.append(el('p', 'add', `+ ${delta.added.join(', ')}`));
    if (delta.removed.length) box.append(el('p', 'del', `− ${delta.removed.join(', ')}`));
    if (delta.changed.length) box.append(el('p', 'chg', `~ ${delta.changed.join(', ')}`));
    card.append(box);
  }
  return card;
}

/* ------------------------------------------------------------- live card */

function liveCard(item, opts = {}) {
  const task = taskById(item.taskId);
  const active = isInFlight(task);
  const state = active ? 'running' : (task?.status ?? 'queued');
  const card = el('div', `live-card role-${item.role} state-${state}`);
  card.dataset.taskId = item.taskId ?? '';
  const head = el('div', 'live-head');
  head.append(identity(item, item.provider));
  if (opts.parallel && task) {
    head.append(
      badge(
        task.status === 'succeeded'
          ? 'lane-status complete'
          : task.status === 'failed'
            ? 'lane-status failed'
            : 'lane-status running',
        task.status === 'succeeded'
          ? 'Complete'
          : task.status === 'failed'
            ? 'Blocked'
            : 'Working',
      ),
    );
  }
  if (task?.currentIteration > 1) {
    head.append(
      badge(
        'attempt warn',
        `Recovery pass ${task.currentIteration - 1}`,
      ),
    );
  }
  card.append(head);
  card.append(el('h3', 'live-title', item.title ?? 'Working'));
  if (item.body && !opts.compact) card.append(el('p', 'sub', item.body));
  if (task?.steps) card.append(stepTracker(task.steps));
  if (active) {
    card.append(activityFeed(task, opts.compact ? 4 : 6));
    const meter = timeoutMeter(task);
    if (meter) card.append(meter);
  } else if (task?.status === 'failed') {
    card.append(el('p', 'lane-result failed', task.lastError || 'This lane needs attention.'));
  } else {
    const latest = task?.timeline?.at(-1);
    card.append(el('p', 'lane-result', latest?.title ?? 'Work complete'));
  }
  return card;
}

/** P1.6 — the orchestrator's own tokens, streamed instead of discarded. */
function plannerCard(item) {
  const planner = lastProject?.planner;
  const card = el('div', 'live-card role-plan');
  const head = el('div', 'live-head');
  head.append(identity(item, item.provider ?? planner?.provider));
  card.append(head);
  card.append(el('h3', 'live-title', item.title ?? 'Planning the work'));
  const wrap = el('div', 'activity');
  const events = (planner?.events ?? []).filter(
    (event) => event.kind !== 'start' && event.kind !== 'result',
  );
  if (events.length === 0) {
    wrap.append(
      el(
        'p',
        'activity-idle',
        planner
          ? `Planning · ${formatElapsed(Math.max(0, serverNow() - planner.startedAt))} elapsed`
          : 'Planning…',
      ),
    );
  } else {
    for (const event of events.slice(-6)) {
      const line = el('p', `act ${event.kind}`);
      line.append(el('span', 'act-glyph', EVENT_GLYPH[event.kind] ?? '·'));
      line.append(el('span', 'act-text', event.text));
      wrap.append(line);
    }
  }
  card.append(wrap);
  return card;
}

/* ------------------------------------------------------------ thread render */

function renderItem(item) {
  const li = el('li', `bubble kind-${item.kind} role-${item.role}`);
  li.dataset.key = item.id;

  if (item.kind === 'user') {
    li.classList.add('user');
    const head = el('div', 'identity');
    head.append(el('span', 'role-label', 'You'));
    if (Number.isFinite(item.ts)) head.append(el('time', 'stamp', formatClock(item.ts)));
    if (item.pending) head.append(badge('queued', 'queued · applies before the next step'));
    if (item.cancelled) head.append(badge('cancelled', 'cancelled'));
    li.append(head);
    li.append(el('p', 'sub', item.body ?? ''));
    if (item.pending) {
      const cancel = el('button', 'link-btn', 'Cancel this steer');
      cancel.type = 'button';
      cancel.addEventListener('click', () => cancelSteering(item.id));
      li.append(cancel);
    }
    return li;
  }

  if (item.kind === 'plan') {
    li.append(identity(item, item.provider));
    li.append(el('h3', null, item.title ?? 'Plan'));
    if (item.body) li.append(el('p', 'sub', item.body));
    li.append(planCard(item));
    return li;
  }

  if (item.kind === 'freeze') {
    li.classList.add('freeze');
    const head = el('div', 'identity');
    head.append(el('span', 'lock', '◆'));
    head.append(el('span', 'role-label', 'Oracle frozen'));
    if (Number.isFinite(item.ts)) head.append(el('time', 'stamp', formatClock(item.ts)));
    li.append(head);
    li.append(el('h3', null, item.title ?? 'Tests frozen'));
    li.append(el('p', 'sub', item.body ?? ''));
    return li;
  }

  if (item.kind === 'race') {
    li.classList.add('race');
    li.append(el('h3', 'race-title', item.title ?? 'Building in parallel'));
    li.append(el('p', 'sub', item.body ?? ''));
    const columns = el('div', 'race-cols');
    for (const taskId of item.taskIds ?? []) {
      const task = taskById(taskId);
      if (!task) continue;
      const role = task.jobKind === 'tests' ? 'tests' : 'writer';
      const complete = task.status === 'succeeded';
      columns.append(
        liveCard(
          {
            ...item,
            taskId,
            role,
            provider: task.provider,
            who: role === 'tests' ? 'Test author' : 'Implementer',
            title:
              role === 'tests'
                ? complete ? 'Tests ready' : 'Writing tests'
                : complete ? 'Implementation ready' : 'Implementing code',
            body: task.title,
          },
          { compact: true, parallel: true },
        ),
      );
    }
    li.append(columns);
    li.append(el('p', 'race-merge', 'Independent worktrees · merged only after both lanes complete'));
    return li;
  }

  if (item.kind === 'merge') {
    li.classList.add('merge');
    const branches = el('div', 'merge-vis');
    branches.setAttribute('aria-hidden', 'true');
    branches.append(el('span', 'branch left'), el('span', 'branch right'), el('span', 'joint'));
    li.append(branches);
    li.append(el('h3', null, item.title ?? 'Merging'));
    li.append(el('p', 'sub', item.body ?? ''));
    return li;
  }

  if (item.kind === 'live') {
    li.classList.add('working');
    li.append(
      item.id.startsWith('planner:') ? plannerCard(item) : liveCard(item),
    );
    return li;
  }

  if (item.kind === 'commit') {
    li.classList.add('commit');
    li.append(identity(item, item.provider));
    const head = el('h3', null, item.title ?? 'Snapshot');
    li.append(head);
    if (item.body) li.append(el('p', 'sub', item.body));
    const meta = el('div', 'commit-meta');
    if (item.steps) meta.append(stepTracker(item.steps));
    if (item.usage?.costUsd) {
      meta.append(badge('cost', `$${item.usage.costUsd.toFixed(4)}`));
    }
    if (item.usage?.numTurns) {
      meta.append(badge('turns', `${item.usage.numTurns} turns`));
    }
    li.append(meta);
    if (item.diff) li.append(diffView(item.diff));
    const chips = fileChips(item.files);
    if (chips) li.append(chips);
    return li;
  }

  // kind === 'event'
  li.append(identity(item, item.provider));
  const head = el('div', 'event-head');
  head.append(el('h3', null, item.title ?? ''));
  if (item.verdict) {
    head.append(
      badge(
        item.verdict === 'ok' ? 'verdict ok' : 'verdict reject',
        item.verdict === 'ok' ? '✓ approved' : '✕ changes requested',
      ),
    );
  }
  if (item.timedOut) head.append(badge('timeout', '⏱ timed out'));
  if (item.attempt > 1 && item.maxAttempts > 1) {
    head.append(badge('attempt warn', `attempt ${item.attempt} of ${item.maxAttempts}`));
  }
  const dur = formatDuration(item.durationMs);
  if (dur) head.append(badge('dur', dur));
  li.append(head);
  if (item.body) li.append(el('p', 'sub', item.body));
  const chips = fileChips(item.files);
  if (chips) li.append(chips);
  return li;
}

function threadKey(items) {
  return items
    .map((item) =>
      item.kind === 'live' || item.kind === 'race' || item.kind === 'merge'
        ? `${item.id}#live`
        : item.id,
    )
    .join('|');
}

function renderFeed(items) {
  if (!els.feed) return;
  const key = threadKey(items);
  if (key !== renderedKeys) {
    renderedKeys = key;
    els.feed.replaceChildren(...items.map(renderItem));
    scrollStage();
    return;
  }
  // Same shape: refresh only the volatile cards in place.
  for (const item of items) {
    if (item.kind !== 'live' && item.kind !== 'race' && item.kind !== 'merge') {
      continue;
    }
    const node = els.feed.querySelector(`[data-key="${CSS.escape(item.id)}"]`);
    if (!node) continue;
    const fresh = renderItem(item);
    node.replaceChildren(...fresh.childNodes);
    node.className = fresh.className;
  }
  scrollStage();
}

function scrollStage() {
  const scroller = els.stage ?? els.feed;
  if (!scroller || !pinnedToBottom) return;
  scroller.scrollTop = scroller.scrollHeight;
}

/* ---------------------------------------------------------------- chrome */

/** §4 — always-visible slot chips, so "busy" is not just a disabled option. */
function renderSlots(slots) {
  if (!els.slots) return;
  const busyOn = new Map();
  for (const task of snapshot?.tasks ?? []) {
    if (!isInFlight(task)) continue;
    const label = task.jobKind === 'tests' ? 'tests' : 'code';
    busyOn.set(task.provider, label);
    if (task.currentStep === 'review' && task.reviewerProvider) {
      busyOn.set(task.reviewerProvider, 'review');
    }
  }
  if (lastProject?.planner && lastProject.planner.phase !== 'done' && lastProject.planner.provider) {
    busyOn.set(lastProject.planner.provider, 'planning');
  }
  els.slots.replaceChildren();
  for (const slot of slots ?? []) {
    const li = el('li', `slot ${slot.provider} ${slot.isBusy ? 'busy' : 'idle'}`);
    li.append(providerAvatar(slot.provider));
    li.append(el('span', 'slot-name', PROVIDER_LABEL[slot.provider]));
    li.append(
      el(
        'span',
        'slot-state',
        slot.isBusy ? `busy · ${busyOn.get(slot.provider) ?? 'working'}` : 'idle',
      ),
    );
    els.slots.append(li);
  }
}

/** A compact mirror of the plan in the sticky header. */
function renderStepper(project) {
  if (!els.stepper) return;
  const items = project?.plan ?? [];
  els.stepper.hidden = items.length === 0;
  els.stepper.replaceChildren();
  for (const item of items) {
    const li = el('li', `pip ${item.status}`);
    li.append(el('span', 'glyph', PLAN_GLYPH[item.status] ?? '○'));
    li.append(el('span', 'pip-title', item.title));
    els.stepper.append(li);
  }
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
      option.disabled = Boolean(slot?.isBusy) && !lastProject;
    }
  }
}

function renderHeader(project, task) {
  els.appTitle.textContent = project ? project.title : 'New project';
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

  if (els.oracleChip) {
    els.oracleChip.hidden = !project;
    if (project) {
      const locked = (project.oraclePaths ?? []).join(', ');
      const frozen = Boolean(project.frozenAt) && locked;
      els.oracleChip.textContent = frozen
        ? `Locked · ${locked}`
        : 'Tests not frozen yet';
      els.oracleChip.classList.toggle('open', !frozen);
      els.oracleChip.classList.toggle('just-locked', Boolean(frozen));
    }
  }

  if (els.sourceReadout) {
    els.sourceReadout.hidden = !project?.sourceDir;
    els.sourceReadout.textContent = project?.sourceDir ?? '';
  }
}

/** P1.7 — elapsed comes off the server clock, so a reload does not reset it. */
function tickClock() {
  if (!els.elapsed) return;
  const live = (snapshot?.tasks ?? []).filter(isInFlight);
  const planner = lastProject?.planner;
  const plannerLive = planner && planner.phase !== 'done' && planner.phase !== 'failed';
  const startedAt = plannerLive
    ? planner.startedAt
    : live.length
      ? Math.min(...live.map((task) => task.startedAt ?? serverNow()))
      : null;
  if (!startedAt) {
    els.elapsed.hidden = true;
    return;
  }
  els.elapsed.hidden = false;
  els.elapsed.textContent = formatElapsed(serverNow() - startedAt);
}

/** Live cards carry their own clocks; refresh them between snapshots. */
function refreshLive() {
  tickClock();
  const thread = snapshot?.thread ?? [];
  if (!replay && thread.some((item) => item.kind === 'live' || item.kind === 'race')) {
    renderFeed(thread);
  }
}

function updateActions() {
  const running = (snapshot?.tasks ?? []).some(isInFlight);
  if (els.send) els.send.disabled = !reachable || Boolean(replay);
  if (els.cancel) {
    els.cancel.disabled = !reachable || !running;
    els.cancel.hidden = !lastProject;
  }
  if (els.reset) els.reset.disabled = !reachable;
  if (els.apply) {
    const ready = Boolean(lastProject?.readyAt);
    const applied = Boolean(lastProject?.appliedAt);
    els.apply.hidden = !ready;
    els.apply.disabled = !reachable || applied || Boolean(replay);
    els.apply.textContent = applied
      ? `Applied · ${lastProject?.appliedFiles?.length ?? 0} files`
      : 'Apply changes';
    els.apply.title = lastProject?.applyTarget
      ? `Write completed files to ${lastProject.applyTarget}`
      : '';
  }
  if (els.send) {
    els.send.textContent = lastProject ? (running ? 'Steer' : 'Send') : 'Run';
  }
  if (els.prompt) {
    els.prompt.placeholder = lastProject
      ? running
        ? 'Steer the run — it lands in the thread now and applies at the next step.'
        : 'Steer the orchestrator: change the approach, drop a step, tighten the contract.'
      : 'Describe what you want to build…';
  }
  if (els.composerHint) {
    els.composerHint.textContent = running
      ? 'Sending now queues the steer — it applies at the next loop boundary.'
      : 'Tests freeze before a SHA · commits are owned by Choreo';
  }
}

function applyLaunchDefaults(force = false) {
  if (!force && seededLaunch) return;
  if (!force && lastProject) {
    seededLaunch = true;
    return;
  }
  const defaults = snapshot?.defaults ?? {};
  if (els.sourceDir && (force || !els.sourceDir.value)) {
    els.sourceDir.value = defaults.sourceDir ?? '';
  }
  if (els.title && (force || !els.title.value)) {
    els.title.value = defaults.title ?? '';
  }
  seededLaunch = true;
}

/** An open project owns the cast; the row mirrors it instead of the defaults. */
function syncSettings(project) {
  const fields = [
    [els.orchestratorProvider, project?.plannerProvider ?? ''],
    [els.provider, project?.writerProvider ?? els.provider?.value],
    [els.reviewerProvider, project?.reviewerProvider ?? ''],
  ];
  for (const [field, value] of fields) {
    if (!field) continue;
    if (project && field.value !== value) field.value = value;
    field.disabled = Boolean(project);
  }
  if (els.maxIterations) {
    if (project) els.maxIterations.value = String(project.maxIterations);
    els.maxIterations.disabled = Boolean(project);
  }
  renderSettingsSummary();
}

function renderSettingsSummary() {
  if (!els.settingsSummary) return;
  const author = els.orchestratorProvider?.value;
  const writer = els.provider?.value;
  const reviewer = els.reviewerProvider?.value;
  const parts = [
    `tests: ${author ? PROVIDER_LABEL[author] : (PROVIDER_LABEL[writer] ?? '—')}`,
    `code: ${PROVIDER_LABEL[writer] ?? '—'}`,
    `review: ${reviewer ? PROVIDER_LABEL[reviewer] : 'tests only'}`,
    `recovery cap: ${els.maxIterations?.value ?? 5} passes`,
  ];
  els.settingsSummary.textContent = parts.join(' · ');
}

function render(next) {
  snapshot = next;
  if (Number.isFinite(next?.now)) serverSkew = next.now - Date.now();
  const project = next?.project ?? null;
  lastProject = project;
  lastTask =
    (project?.activeTaskId
      ? (next?.tasks ?? []).find((item) => item.id === project.activeTaskId)
      : null) ??
    (next?.tasks ?? []).at(-1) ??
    null;

  document.body.classList.toggle('session', Boolean(project));
  document.body.classList.toggle(
    'busy',
    (next?.tasks ?? []).some(isInFlight) || Boolean(project?.shards),
  );
  applySlotBusy(next?.slots ?? []);
  renderSlots(next?.slots ?? []);
  renderStepper(project);
  renderHeader(project, lastTask);
  if (els.reset) els.reset.hidden = !project;
  if (els.settings) els.settings.classList.toggle('locked', Boolean(project));
  syncSettings(project);
  applyLaunchDefaults();

  const thread = next?.thread ?? [];
  const hasSession = Boolean(project || thread.length);
  els.empty.hidden = hasSession;
  els.feed.hidden = !hasSession;
  if (hasSession) renderFeed(thread);
  else {
    renderedKeys = '';
    els.feed.replaceChildren();
  }
  tickClock();
  updateActions();
}

/* ------------------------------------------------------------- transport */

function setUnreachable(isUnreachable) {
  reachable = !isUnreachable;
  els.unreachable.hidden = !isUnreachable;
}

function setFormError(message) {
  els.formError.hidden = !message;
  els.formError.textContent = message || '';
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

async function poll() {
  if (pollInFlight || replay) return;
  pollInFlight = true;
  try {
    const res = await fetch(`${API}/api/state`);
    if (!res.ok) throw new Error('state');
    setUnreachable(false);
    render(await res.json());
  } catch {
    setUnreachable(true);
    updateActions();
  } finally {
    pollInFlight = false;
  }
}

/** P0.2 — SSE first; polling stays as a fallback if the stream drops. */
function openStream() {
  if (replay || typeof EventSource === 'undefined') return;
  try {
    stream = new EventSource(`${API}/api/events`);
  } catch {
    stream = null;
    return;
  }
  stream.addEventListener('message', (event) => {
    try {
      setUnreachable(false);
      render(JSON.parse(event.data));
    } catch {
      /* ignore a malformed frame */
    }
  });
  stream.addEventListener('error', () => {
    stream?.close();
    stream = null;
    setTimeout(openStream, 2000);
  });
}

/* --------------------------------------------------------------- actions */

async function cancelCurrent() {
  const running = (snapshot?.tasks ?? []).filter(isInFlight);
  if (running.length === 0) return;
  setFormError('');
  try {
    for (const task of running) {
      await fetch(`${API}/api/tasks/${task.id}/cancel`, { method: 'POST' });
    }
    await poll();
  } catch {
    setUnreachable(true);
  }
}

async function cancelSteering(messageId) {
  if (!lastProject?.id) return;
  try {
    await fetch(
      `${API}/api/projects/${lastProject.id}/steering/${messageId}/cancel`,
      { method: 'POST' },
    );
    await poll();
  } catch {
    setUnreachable(true);
  }
}

function hideResetConfirm() {
  if (els.resetConfirm) els.resetConfirm.hidden = true;
}

async function resetAll() {
  hideResetConfirm();
  setFormError('');
  renderedKeys = '';
  seededLaunch = false;
  applyLaunchDefaults(true);
  if (els.prompt) els.prompt.value = '';
  try {
    const res = await fetch(`${API}/api/reset`, { method: 'POST' });
    if (!res.ok) setFormError(await readErrorMessage(res));
    else await poll();
  } catch {
    setUnreachable(true);
  }
}

async function applyProject() {
  if (!lastProject?.id || !els.apply) return;
  setFormError('');
  els.apply.disabled = true;
  els.apply.textContent = 'Applying…';
  try {
    const res = await fetch(`${API}/api/projects/${lastProject.id}/apply`, {
      method: 'POST',
    });
    if (!res.ok) {
      setFormError(await readErrorMessage(res));
      updateActions();
      return;
    }
    await poll();
  } catch {
    setUnreachable(true);
    setFormError('Could not apply changes to the project folder');
    updateActions();
  }
}

async function createProject(goal) {
  const attempts = Number.parseInt(els.maxIterations?.value ?? '5', 10);
  const res = await fetch(`${API}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: els.title.value.trim() || 'Untitled',
      goal,
      ...(els.sourceDir.value.trim() ? { sourceDir: els.sourceDir.value.trim() } : {}),
      writerProvider: els.provider.value,
      maxIterations: Number.isFinite(attempts) && attempts > 0 ? attempts : 5,
      ...(els.reviewerProvider?.value
        ? { reviewerProvider: els.reviewerProvider.value }
        : {}),
      ...(els.orchestratorProvider?.value
        ? { plannerProvider: els.orchestratorProvider.value }
        : {}),
    }),
  });
  return res;
}

async function sendMessage(text) {
  return fetch(`${API}/api/projects/${lastProject.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

/** §3 — one composer. The first message opens the project, later ones steer. */
els.composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  setFormError('');
  const text = els.prompt.value.trim();
  if (!text) {
    setFormError(lastProject ? 'Write a steer first' : 'Describe a goal first');
    return;
  }
  els.prompt.value = '';
  pinnedToBottom = true;
  try {
    const res = lastProject ? await sendMessage(text) : await createProject(text);
    if (!res.ok) {
      els.prompt.value = text;
      setFormError(await readErrorMessage(res));
      return;
    }
    if (!lastProject) {
      renderedKeys = '';
      els.settings?.removeAttribute('open');
    }
    await poll();
  } catch {
    els.prompt.value = text;
    setUnreachable(true);
    setFormError('Can’t reach Choreo on :4055');
  }
});

els.prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    els.composer.requestSubmit();
  }
});

els.cancel.addEventListener('click', cancelCurrent);
els.apply?.addEventListener('click', applyProject);
els.reset?.addEventListener('click', () => {
  if (els.resetConfirm) els.resetConfirm.hidden = false;
});
els.resetYes?.addEventListener('click', resetAll);
els.resetNo?.addEventListener('click', hideResetConfirm);
els.resetConfirm?.addEventListener('click', (event) => {
  if (event.target === els.resetConfirm) hideResetConfirm();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') hideResetConfirm();
});
for (const select of [els.provider, els.reviewerProvider, els.orchestratorProvider, els.maxIterations]) {
  select?.addEventListener('change', () => {
    renderSettingsSummary();
    updateActions();
  });
}

(els.stage ?? els.feed)?.addEventListener('scroll', () => {
  const node = els.stage ?? els.feed;
  pinnedToBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
});

/* ---------------------------------------------------------------- replay */

/**
 * P2 — `?replay=<projectId>` re-renders a recorded run at 10×. Demo insurance
 * against a flaky CLI or hotel wifi: the arc is identical, nothing is live.
 */
async function startReplay(projectId) {
  els.replayBanner.hidden = false;
  stream?.close();
  stream = null;
  const res = await fetch(
    `${API}/api/replay${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
  );
  const body = await res.json();
  const rows = (body.items ?? []).sort((a, b) => a.ts - b.ts);
  if (rows.length === 0) {
    els.replayBanner.textContent = 'No recorded run found for that id.';
    return;
  }
  replay = { rows, shown: [] };
  const base = rows[0].ts;
  const t0 = Date.now();
  const step = () => {
    const virtual = base + (Date.now() - t0) * REPLAY_SPEED;
    const shown = rows.filter((row) => row.ts <= virtual).map((row) => row.item);
    render({ tasks: [], slots: [], thread: shown, now: Date.now() });
    if (shown.length < rows.length) {
      requestAnimationFrame(step);
    } else {
      els.replayBanner.textContent = 'Replay finished — this was a recorded run.';
    }
  };
  step();
}

/* ------------------------------------------------------------------ boot */

renderSettingsSummary();
const replayId = new URLSearchParams(location.search).get('replay');
if (replayId !== null) {
  void startReplay(replayId);
} else {
  void poll();
  openStream();
  setInterval(() => {
    if (!stream) void poll();
  }, POLL_MS);
}
setInterval(refreshLive, 250);
