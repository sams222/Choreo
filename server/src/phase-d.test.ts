import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { parsePlanObject, parseReviewVerdict } from '../../protocol/index.ts';
import { createAdapters } from './adapters.ts';
import { createGitRuntime } from './git.ts';
import { createHttpApp, dashboardDefaults } from './http.ts';
import { createStore } from './state.ts';
import type { CLIAdapter, ProviderType } from '../../protocol/index.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureDir = path.join(repoRoot, 'fixture');
const sqrtDir = path.join(repoRoot, 'examples/sqrt');

const NAIVE_SQRT = `export function integerSqrt(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError('n must be a non-negative integer');
  }
  let r = 0;
  while ((r + 1) * (r + 1) <= n) r += 1;
  return r;
}
`;

const BINARY_SQRT = `export function integerSqrt(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError('n must be a non-negative integer');
  }
  let lo = 0;
  let hi = n;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const sq = mid * mid;
    if (sq === n) return mid;
    if (sq < n) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi;
}
`;

function sqrtCtx(persistDir: string) {
  return {
    sourceDir: sqrtDir,
    oraclePaths: ['sqrt.test.js'],
    testCommand: ['node', '--test'],
    persistDir,
  };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil<T>(
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 12_000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value) {
      return value;
    }
    await wait(40);
  }
  throw new Error('timed out');
}

test('parsePlanObject reads fenced JSON', () => {
  const parsed = parsePlanObject(`here
\`\`\`json
{"reply":"ok","items":[{"title":"Implement integerSqrt","files":["sqrt.js"],"doneWhen":"integerSqrt(9)===3"}]}
\`\`\`
PLAN_DONE`);
  assert.equal(parsed?.reply, 'ok');
  assert.equal(parsed?.items[0]?.title, 'Implement integerSqrt');
  assert.deepEqual(parsed?.items[0]?.files, ['sqrt.js']);
});

test('parseReviewVerdict only accepts exact verdict lines', () => {
  assert.equal(
    parseReviewVerdict('Prompt said REVIEW_OK and then REVIEW_REJECT, but no verdict.'),
    'reject',
  );
  assert.equal(parseReviewVerdict('Looks good\nREVIEW_OK\n'), 'ok');
  assert.equal(
    parseReviewVerdict('REVIEW_OK\nActually no.\nREVIEW_REJECT\nmissing case'),
    'reject',
  );
});

test('sqrt demo fails until integerSqrt is implemented', async () => {
  const git = createGitRuntime(fixtureDir);
  const persistDir = path.join(os.tmpdir(), `loopsync-test-sqrt-${Date.now()}`);
  const ctx = sqrtCtx(persistDir);
  const workspace = await git.createWorkspace('gate-d', ctx);
  after(() => fs.rmSync(persistDir, { recursive: true, force: true }));

  assert.equal(fs.existsSync(path.join(workspace.dir, 'parse.js')), false);
  assert.equal(fs.existsSync(path.join(workspace.dir, 'sqrt.js')), true);
  const failing = await git.runTests(workspace.dir, ctx);
  assert.equal(failing.passed, false);

  fs.writeFileSync(path.join(workspace.dir, 'sqrt.js'), NAIVE_SQRT);
  const passing = await git.runTests(workspace.dir, ctx);
  assert.equal(passing.passed, true);

  const commit = await git.commitIfDirty(workspace.dir, 'sqrt', ctx);
  assert.ok(commit);
  assert.match(commit.diff, /sqrt\.js/);
  assert.doesNotMatch(commit.diff, /parse\.js/);

  fs.appendFileSync(path.join(workspace.dir, 'sqrt.test.js'), '\n');
  const oracle = await git.checkOracle(workspace.dir, ctx);
  assert.equal(oracle.dirty, true);
  await assert.rejects(
    () => git.commitIfDirty(workspace.dir, 'nope', ctx),
    /ORACLE_TAMPERED/,
  );

  await assert.rejects(
    () => git.commitIfDirty(sqrtDir, 'never', ctx),
    /Never commit in original source directory/,
  );
  await assert.rejects(
    () => git.commitIfDirty(fixtureDir, 'never'),
    /Never commit in original fixture/,
  );

  fs.writeFileSync(path.join(workspace.dir, 'sqrt.js'), BINARY_SQRT);
  const again = await git.createWorkspace('follow-up', ctx);
  assert.equal(again.dir, persistDir);
  assert.match(fs.readFileSync(path.join(again.dir, 'sqrt.js'), 'utf8'), />> 1/);
});

test('fixture workspace still requires parse.js', async () => {
  const git = createGitRuntime(fixtureDir);
  const workspace = await git.createWorkspace(`fix_${Date.now()}`);
  after(() => fs.rmSync(workspace.dir, { recursive: true, force: true }));
  assert.equal(fs.existsSync(path.join(workspace.dir, 'parse.js')), true);
  const tests = await git.runTests(workspace.dir);
  assert.equal(tests.passed, false);
});

function makeTestAdapters(opts?: { tamper?: boolean }): Record<ProviderType, CLIAdapter> {
  const writer: CLIAdapter = {
    provider: 'codex',
    async run(workspaceDir, prompt, onLog) {
      onLog('writing');
      if (opts?.tamper) {
        fs.appendFileSync(path.join(workspaceDir, 'sqrt.test.js'), '\n');
        return { output: 'tampered', exitCode: 0 };
      }
      const source = /binary search/i.test(prompt) ? BINARY_SQRT : NAIVE_SQRT;
      fs.writeFileSync(path.join(workspaceDir, 'sqrt.js'), source);
      return { output: 'wrote sqrt.js', exitCode: 0 };
    },
  };
  const planner: CLIAdapter = {
    provider: 'codex',
    async run(_workspaceDir, prompt, onLog) {
      onLog('planning');
      const binary = /binary search/i.test(prompt);
      const body = {
        reply: binary
          ? 'Switching integerSqrt to binary search and re-running the writer.'
          : 'Implement integerSqrt in sqrt.js. Leave sqrt.test.js locked.',
        items: [
          {
            title: binary ? 'Binary search integerSqrt' : 'Implement integerSqrt',
            files: ['sqrt.js'],
            doneWhen: 'integerSqrt(9) === 3',
            prompt: binary
              ? 'Switch the algorithm to binary search in sqrt.js. Do not change sqrt.test.js.'
              : 'Implement integerSqrt in sqrt.js so integerSqrt(9) === 3. Do not change sqrt.test.js.',
          },
        ],
      };
      return { output: `${JSON.stringify(body)}\nPLAN_DONE`, exitCode: 0 };
    },
  };
  return { claude: planner, codex: writer };
}

async function listen(app: ReturnType<typeof createHttpApp>) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  after(() => server.close());
  return { server, base: `http://127.0.0.1:${port}` };
}

type Snapshot = {
  tasks: Array<{
    id: string;
    status: string;
    lastError?: string;
    commitSha?: string;
    diff?: string;
    workspaceDir?: string;
    outputFiles?: Array<{ path: string }>;
  }>;
  project?: {
    id: string;
    messages: Array<{ text: string }>;
  };
  defaults?: { sourceDir: string };
};

async function json<T = Record<string, unknown>>(
  base: string,
  pathname: string,
  init?: RequestInit,
): Promise<{ res: Response; body: T }> {
  const res = await fetch(`${base}${pathname}`, init);
  const body = (await res.json()) as T;
  return { res, body };
}

test('Gate 2 POST /api/tasks still returns 201', async () => {
  const store = createStore(dashboardDefaults(repoRoot));
  const git = createGitRuntime(fixtureDir);
  const app = createHttpApp({
    store,
    git,
    adapters: createAdapters(),
    repoRoot,
  });
  const { base } = await listen(app);
  const { res, body } = await json<{ taskId: string }>(base, '/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: fs.readFileSync(
      path.join(repoRoot, 'protocol/examples/http-post-tasks.request.json'),
      'utf8',
    ),
  });
  assert.equal(res.status, 201);
  assert.equal(typeof body.taskId, 'string');
  await fetch(`${base}/api/reset`, { method: 'POST' });
});

test('Phase D/E: sqrt project, follow-up reuses workspace, oracle lock', async () => {
  const store = createStore(dashboardDefaults(repoRoot));
  const git = createGitRuntime(fixtureDir);
  const app = createHttpApp({
    store,
    git,
    adapters: makeTestAdapters(),
    repoRoot,
  });
  const { base } = await listen(app);

  const empty = await json<Snapshot>(base, '/api/state');
  assert.equal(empty.body.tasks.length, 0);
  assert.equal(empty.body.defaults?.sourceDir, sqrtDir);

  const created = await json<{ projectId: string; taskId: string }>(base, '/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Integer square root',
      goal: 'Implement integerSqrt in sqrt.js so integerSqrt(9) === 3. Do not change sqrt.test.js.',
      sourceDir: sqrtDir,
      writerProvider: 'codex',
      plannerProvider: 'claude',
      maxIterations: 2,
    }),
  });
  assert.equal(created.res.status, 201, JSON.stringify(created.body));
  const projectId = created.body.projectId;
  const workspaceDir = path.join('/tmp/loopsync-workspaces', projectId);

  const succeeded = await waitUntil(async () => {
    const { body } = await json<Snapshot>(base, '/api/state');
    const task = body.tasks.at(-1);
    if (task?.status === 'failed') {
      throw new Error(task.lastError || 'failed');
    }
    return task?.status === 'succeeded' ? body : null;
  });
  const firstTask = succeeded.tasks.at(-1);
  assert.ok(firstTask);
  assert.ok(firstTask.commitSha);
  assert.match(firstTask.diff ?? '', /sqrt\.js/);
  assert.doesNotMatch(firstTask.diff ?? '', /parse\.js/);
  assert.equal(fs.existsSync(path.join(workspaceDir, 'parse.js')), false);
  assert.ok(firstTask.outputFiles?.some((file) => file.path === 'sqrt.js'));
  assert.equal(succeeded.project?.id, projectId);
  assert.ok((succeeded.project?.messages.length ?? 0) >= 2);

  const follow = await json<{ ok: boolean; taskId: string }>(
    base,
    `/api/projects/${projectId}/messages`,
    {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Switch the algorithm to binary search.' }),
  });
  assert.equal(follow.res.status, 201, JSON.stringify(follow.body));

  const afterFollow = await waitUntil(async () => {
    const { body } = await json<Snapshot>(base, '/api/state');
    const task = body.tasks.at(-1);
    if (task?.id === firstTask.id) return null;
    if (task?.status === 'failed') throw new Error(task.lastError || 'follow-up failed');
    return task?.status === 'succeeded' ? body : null;
  });
  const second = afterFollow.tasks.at(-1);
  assert.ok(second);
  assert.ok(second.commitSha);
  assert.equal(second.workspaceDir, firstTask.workspaceDir);
  assert.match(fs.readFileSync(path.join(workspaceDir, 'sqrt.js'), 'utf8'), />> 1/);
  assert.ok(
    afterFollow.project?.messages.some((message) => /binary search/i.test(message.text)),
  );

  await fetch(`${base}/api/reset`, { method: 'POST' });
});

test('tampering with sqrt.test.js is ORACLE_TAMPERED', async () => {
  const store = createStore(dashboardDefaults(repoRoot));
  const git = createGitRuntime(fixtureDir);
  const app = createHttpApp({
    store,
    git,
    adapters: makeTestAdapters({ tamper: true }),
    repoRoot,
  });
  const { base } = await listen(app);
  const created = await json<{ projectId: string }>(base, '/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Integer square root',
      goal: 'Implement integerSqrt in sqrt.js so integerSqrt(9) === 3.',
      sourceDir: 'examples/sqrt',
      writerProvider: 'codex',
      maxIterations: 1,
    }),
  });
  assert.equal(created.res.status, 201, JSON.stringify(created.body));
  const failed = await waitUntil(async () => {
    const { body } = await json<Snapshot>(base, '/api/state');
    const task = body.tasks.at(-1);
    return task?.status === 'failed' ? task : null;
  });
  assert.match(failed.lastError ?? '', /ORACLE_TAMPERED/);
  assert.equal(failed.commitSha, undefined);
  await fetch(`${base}/api/reset`, { method: 'POST' });
});

test('nonzero writer exit fails before tests or commit', async () => {
  const store = createStore(dashboardDefaults(repoRoot));
  const git = createGitRuntime(fixtureDir);
  const badWriter: CLIAdapter = {
    provider: 'codex',
    async run(workspaceDir, _prompt, onLog) {
      onLog('writer crashed');
      fs.writeFileSync(path.join(workspaceDir, 'sqrt.js'), NAIVE_SQRT);
      return { output: 'crash', exitCode: 2 };
    },
  };
  const app = createHttpApp({
    store,
    git,
    adapters: { claude: badWriter, codex: badWriter },
    repoRoot,
  });
  const { base } = await listen(app);
  const created = await json<{ projectId: string }>(base, '/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Integer square root',
      goal: 'Implement integerSqrt in sqrt.js so integerSqrt(9) === 3.',
      sourceDir: 'examples/sqrt',
      writerProvider: 'codex',
      maxIterations: 1,
    }),
  });
  assert.equal(created.res.status, 201, JSON.stringify(created.body));
  const failed = await waitUntil(async () => {
    const { body } = await json<Snapshot>(base, '/api/state');
    const task = body.tasks.at(-1);
    return task?.status === 'failed' ? task : null;
  });
  assert.match(failed.lastError ?? '', /writer exited 2/);
  assert.equal(failed.commitSha, undefined);
  await fetch(`${base}/api/reset`, { method: 'POST' });
});

test('reviewer mutation is re-tested before commit', async () => {
  const store = createStore(dashboardDefaults(repoRoot));
  const git = createGitRuntime(fixtureDir);
  const writer: CLIAdapter = {
    provider: 'codex',
    async run(workspaceDir, _prompt, onLog) {
      onLog('writer fixed sqrt');
      fs.writeFileSync(path.join(workspaceDir, 'sqrt.js'), NAIVE_SQRT);
      return { output: 'fixed', exitCode: 0 };
    },
  };
  const reviewer: CLIAdapter = {
    provider: 'claude',
    async run(workspaceDir, _prompt, onLog) {
      onLog('reviewer approves and edits');
      fs.writeFileSync(path.join(workspaceDir, 'sqrt.js'), 'export function integerSqrt() { return -1; }\n');
      return { output: 'LGTM\nREVIEW_OK\n', exitCode: 0 };
    },
  };
  const app = createHttpApp({
    store,
    git,
    adapters: { claude: reviewer, codex: writer },
    repoRoot,
  });
  const { base } = await listen(app);
  const created = await json<{ projectId: string }>(base, '/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Integer square root',
      goal: 'Implement integerSqrt in sqrt.js so integerSqrt(9) === 3.',
      sourceDir: 'examples/sqrt',
      writerProvider: 'codex',
      reviewerProvider: 'claude',
      maxIterations: 1,
    }),
  });
  assert.equal(created.res.status, 201, JSON.stringify(created.body));
  const failed = await waitUntil(async () => {
    const { body } = await json<Snapshot>(base, '/api/state');
    const task = body.tasks.at(-1);
    return task?.status === 'failed' ? task : null;
  });
  assert.match(failed.lastError ?? '', /Expected values to be strictly equal|notStrictEqual|strictEqual/);
  assert.equal(failed.commitSha, undefined);
  await fetch(`${base}/api/reset`, { method: 'POST' });
});

test('ledger append failure does not leave task running', async () => {
  const store = createStore(dashboardDefaults(repoRoot));
  const git = createGitRuntime(fixtureDir);
  const app = createHttpApp({
    store,
    git,
    adapters: makeTestAdapters(),
    ledger: {
      path: 'throwing-ledger',
      append() {
        throw new Error('disk full');
      },
    },
    repoRoot,
  });
  const { base } = await listen(app);
  const created = await json<{ projectId: string }>(base, '/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Integer square root',
      goal: 'Implement integerSqrt in sqrt.js so integerSqrt(9) === 3.',
      sourceDir: 'examples/sqrt',
      writerProvider: 'codex',
      maxIterations: 1,
    }),
  });
  assert.equal(created.res.status, 201, JSON.stringify(created.body));
  const succeeded = await waitUntil(async () => {
    const { body } = await json<Snapshot>(base, '/api/state');
    const task = body.tasks.at(-1);
    return task?.status === 'succeeded' ? task : null;
  });
  assert.ok(succeeded.commitSha);
  await fetch(`${base}/api/reset`, { method: 'POST' });
});
