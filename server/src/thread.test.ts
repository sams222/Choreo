import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  PlanItem,
  ServerSnapshot,
  TaskState,
} from '../../protocol/index.ts';
import { buildThread } from './thread.ts';

const T0 = 1_700_000_000_000;

function planItem(over: Partial<PlanItem> = {}): PlanItem {
  return {
    id: 'item_1',
    title: 'Write tests',
    prompt: 'author assertions',
    files: ['sqrt.test.js'],
    doneWhen: 'tests describe the contract',
    status: 'pending',
    kind: 'tests',
    ...over,
  };
}

function task(over: Partial<TaskState> = {}): TaskState {
  return {
    id: 'task_1',
    title: 'Write tests',
    prompt: 'p',
    provider: 'claude',
    status: 'running',
    currentIteration: 1,
    maxIterations: 2,
    workspaceDir: '/tmp/ws',
    logs: [],
    startedAt: T0 + 100,
    steps: [
      { id: 'writer', status: 'running', startedAt: T0 + 100 },
      { id: 'tests', status: 'pending' },
      { id: 'review', status: 'skipped' },
      { id: 'git', status: 'pending' },
    ],
    projectId: 'proj_1',
    jobKind: 'tests',
    currentStep: 'writer',
    ...over,
  };
}

function snapshot(over: Partial<ServerSnapshot> = {}): ServerSnapshot {
  return {
    tasks: [],
    slots: [
      { provider: 'claude', isBusy: false },
      { provider: 'codex', isBusy: false },
    ],
    project: {
      id: 'proj_1',
      title: 'Integer square root',
      goal: 'implement integerSqrt',
      workspaceDir: '/tmp/ws',
      testCommand: ['node', '--test'],
      oraclePaths: [],
      writerProvider: 'codex',
      plannerProvider: 'claude',
      maxIterations: 2,
      messages: [{ id: 'msg_1', role: 'user', text: 'build it', ts: T0 }],
      plan: [],
    },
    ...over,
  };
}

test('the thread is ordered by timestamp, not by array position', () => {
  const base = snapshot();
  base.project!.messages = [
    { id: 'msg_1', role: 'user', text: 'first', ts: T0 },
    { id: 'msg_3', role: 'user', text: 'third', ts: T0 + 300 },
    { id: 'msg_2', role: 'orchestrator', text: 'second', ts: T0 + 100 },
  ];
  const thread = buildThread(base);
  assert.deepEqual(
    thread.map((item) => item.body),
    ['first', 'second', 'third'],
  );
});

test('a plan card carries live statuses and the replan delta', () => {
  const base = snapshot();
  const tests = planItem({ id: 'a', status: 'succeeded' });
  const code = planItem({
    id: 'b',
    title: 'Implement',
    kind: 'code',
    files: ['sqrt.js'],
    doneWhen: 'the tests pass',
    status: 'running',
  });
  base.project!.plan = [tests, code];
  base.project!.planCards = [
    {
      id: 'plan_1',
      ts: T0 + 50,
      items: [
        { ...tests, status: 'pending' },
        { ...code, status: 'pending' },
      ],
    },
    {
      id: 'plan_2',
      ts: T0 + 400,
      items: [tests, code],
      delta: { added: ['Implement'], removed: [], changed: [] },
    },
  ];
  const cards = buildThread(base).filter((item) => item.kind === 'plan');
  assert.equal(cards.length, 2);
  // The older card is frozen history…
  assert.equal(cards[0].plan?.[0].status, 'pending');
  // …the newest one mirrors live status.
  assert.equal(cards[1].plan?.[0].status, 'succeeded');
  assert.equal(cards[1].plan?.[1].status, 'running');
  assert.deepEqual(cards[1].planDelta?.added, ['Implement']);
  assert.equal(cards[1].title, 'Updated plan');
});

test('two in-flight tasks with shards collapse into one race card', () => {
  const base = snapshot({
    tasks: [
      task({ id: 'task_tests', jobKind: 'tests', provider: 'claude' }),
      task({ id: 'task_code', jobKind: 'code', provider: 'codex' }),
    ],
  });
  base.project!.shards = { testsDir: '/tmp/a', codeDir: '/tmp/b' };
  const thread = buildThread(base);
  const race = thread.find((item) => item.kind === 'race');
  assert.ok(race, 'expected a race card');
  assert.deepEqual(race.taskIds, ['task_tests', 'task_code']);
  assert.equal(
    thread.some((item) => item.kind === 'live'),
    false,
    'the race card replaces the individual live cards',
  );
});

test('a single in-flight task gets its own live card with steps', () => {
  const base = snapshot({ tasks: [task()] });
  const live = buildThread(base).find((item) => item.kind === 'live');
  assert.ok(live);
  assert.equal(live.taskId, 'task_1');
  assert.equal(live.who, 'Test author');
  assert.equal(live.provider, 'claude');
  assert.equal(live.title, 'Authoring tests');
  assert.equal(live.steps?.[0].status, 'running');
});

test('a finished task contributes its timeline plus a commit card', () => {
  const done = task({
    status: 'succeeded',
    jobKind: 'code',
    provider: 'codex',
    reviewerProvider: 'claude',
    commitSha: 'abc123def456',
    diff: 'diff --git a/sqrt.js b/sqrt.js\n+ok',
    endedAt: T0 + 900,
    timeline: [
      {
        id: 'review_1',
        role: 'review',
        title: 'claude approved',
        body: 'REVIEW_OK',
        ts: T0 + 500,
        provider: 'claude',
        verdict: 'ok',
      },
    ],
  });
  const thread = buildThread(snapshot({ tasks: [done] }));
  const review = thread.find((item) => item.role === 'review');
  assert.equal(review?.verdict, 'ok');
  assert.equal(review?.provider, 'claude');
  assert.equal(review?.who, 'Reviewer');
  const commit = thread.find((item) => item.kind === 'commit');
  assert.equal(commit?.sha, 'abc123def456');
  assert.match(commit?.diff ?? '', /\+ok/);
  // The commit lands after the review it followed.
  assert.ok(thread.indexOf(commit!) > thread.indexOf(review!));
});

test('the freeze beat appears once the oracle locks', () => {
  const base = snapshot();
  base.project!.frozenAt = T0 + 600;
  base.project!.oraclePaths = ['sqrt.test.js'];
  const freeze = buildThread(base).find((item) => item.kind === 'freeze');
  assert.ok(freeze);
  assert.match(freeze.title ?? '', /1 test file frozen/);
  assert.match(freeze.body ?? '', /node --test/);
});

test('queued steering shows as a pending user bubble', () => {
  const base = snapshot();
  base.project!.messages.push({
    id: 'msg_q',
    role: 'user',
    text: 'use binary search',
    ts: T0 + 200,
    pending: true,
  });
  const queued = buildThread(base).find((item) => item.id === 'msg_q');
  assert.equal(queued?.pending, true);
  assert.equal(queued?.kind, 'user');
});

test('a live planner run is visible while it plans and after it fails', () => {
  const base = snapshot();
  base.project!.planner = {
    phase: 'planning',
    provider: 'claude',
    startedAt: T0 + 10,
    events: [],
    text: '',
  };
  const live = buildThread(base).find((item) => item.id.startsWith('planner:'));
  assert.equal(live?.kind, 'live');
  assert.equal(live?.provider, 'claude');

  base.project!.planner = {
    ...base.project!.planner,
    phase: 'failed',
    error: 'the planner timed out',
  };
  const failed = buildThread(base).find((item) => item.id.startsWith('planner:'));
  assert.equal(failed?.kind, 'event');
  assert.equal(failed?.tone, 'fail');

  base.project!.planner = { ...base.project!.planner, phase: 'done' };
  assert.equal(
    buildThread(base).some((item) => item.id.startsWith('planner:')),
    false,
  );
});
