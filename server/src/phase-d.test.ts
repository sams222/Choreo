import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { defaultBuildPlan, parsePlanObject } from '../../protocol/index.ts';
import { createAdapters } from './adapters.ts';
import { createGitRuntime } from './git.ts';
import { createHttpApp, dashboardDefaults } from './http.ts';
import { createStore } from './state.ts';
import type { CLIAdapter, ProviderType } from '../../protocol/index.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureDir = path.join(repoRoot, 'fixture');

const TEST_FILE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { integerSqrt } from './sqrt.js';

test('integerSqrt(9) === 3', () => {
  assert.equal(integerSqrt(9), 3);
});
`;

const IMPL_FILE = `export function integerSqrt(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError('n must be a non-negative integer');
  }
  let r = 0;
  while ((r + 1) * (r + 1) <= n) r += 1;
  return r;
}
`;

const BINARY_IMPL = `export function integerSqrt(n) {
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

test('parsePlanObject and defaultBuildPlan split tests from code', () => {
  const parsed = parsePlanObject(`\`\`\`json
{"reply":"ok","items":[{"kind":"tests","title":"Write tests","files":["a.test.js"]},{"kind":"code","title":"Implement","files":["a.js"]}]}
\`\`\`
PLAN_DONE`);
  assert.equal(parsed?.items[0]?.kind, 'tests');
  assert.equal(parsed?.items[1]?.kind, 'code');
  const plan = defaultBuildPlan('integer square root');
  assert.equal(plan.items[0]?.kind, 'tests');
  assert.equal(plan.items[1]?.kind, 'code');
});

test('empty workspace: tests then implementation, no fixture parse.js', async () => {
  const git = createGitRuntime(fixtureDir);
  const persistDir = path.join(os.tmpdir(), `loopsync-empty-${Date.now()}`);
  const ctx = {
    empty: true,
    persistDir,
    oraclePaths: [] as string[],
    testCommand: ['node', '--test'],
    mode: 'tests' as const,
  };
  const workspace = await git.createWorkspace('empty', ctx);
  after(() => fs.rmSync(persistDir, { recursive: true, force: true }));
  assert.equal(fs.existsSync(path.join(workspace.dir, 'parse.js')), false);
  assert.equal(fs.existsSync(path.join(workspace.dir, 'parse.test.js')), false);

  fs.writeFileSync(path.join(workspace.dir, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(workspace.dir, 'sqrt.test.js'), TEST_FILE);
  const authored = await git.commitIfDirty(workspace.dir, 'tests', ctx);
  assert.ok(authored);
  assert.match(authored.diff, /sqrt\.test\.js/);

  fs.writeFileSync(path.join(workspace.dir, 'sqrt.js'), IMPL_FILE);
  const codeCtx = { ...ctx, mode: 'code' as const, oraclePaths: ['sqrt.test.js'] };
  const passing = await git.runTests(workspace.dir, codeCtx);
  assert.equal(passing.passed, true);
  const commit = await git.commitIfDirty(workspace.dir, 'impl', codeCtx);
  assert.ok(commit);
  assert.match(commit.diff, /sqrt\.js/);
  assert.doesNotMatch(commit.diff, /parse\.js/);

  fs.appendFileSync(path.join(workspace.dir, 'sqrt.test.js'), '\n');
  const oracle = await git.checkOracle(workspace.dir, codeCtx);
  assert.equal(oracle.dirty, true);
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
  const writePkg = (workspaceDir: string) => {
    fs.writeFileSync(
      path.join(workspaceDir, 'package.json'),
      '{"type":"module"}\n',
    );
  };
  const writer: CLIAdapter = {
    provider: 'codex',
    async run(workspaceDir, prompt, onLog) {
      onLog('writing');
      writePkg(workspaceDir);
      if (opts?.tamper && /implement/i.test(prompt) && !/tests only/i.test(prompt)) {
        fs.appendFileSync(path.join(workspaceDir, 'sqrt.test.js'), '\n');
        return { output: 'tampered', exitCode: 0 };
      }
      if (/tests only|Write automated tests only/i.test(prompt)) {
        fs.writeFileSync(path.join(workspaceDir, 'sqrt.test.js'), TEST_FILE);
        return { output: 'wrote tests', exitCode: 0 };
      }
      const source = /binary search|Switch the algorithm/i.test(prompt)
        ? BINARY_IMPL
        : IMPL_FILE;
      fs.writeFileSync(path.join(workspaceDir, 'sqrt.js'), source);
      return { output: 'wrote sqrt.js', exitCode: 0 };
    },
  };
  const planner: CLIAdapter = {
    provider: 'claude',
    async run(workspaceDir, prompt, onLog) {
      onLog('planning');
      if (/tests only|Write automated tests only/i.test(prompt)) {
        fs.writeFileSync(
          path.join(workspaceDir, 'package.json'),
          '{"type":"module"}\n',
        );
        fs.writeFileSync(path.join(workspaceDir, 'sqrt.test.js'), TEST_FILE);
        return { output: 'wrote tests', exitCode: 0 };
      }
      const binary = /binary search/i.test(prompt);
      const body = {
        reply: binary
          ? 'Switching the implementation to binary search. Tests stay locked.'
          : 'I will write tests and implementation as separate steps.',
        items: binary
          ? [
              {
                kind: 'code',
                title: 'Binary search',
                files: ['sqrt.js'],
                prompt:
                  'Switch the algorithm to binary search in sqrt.js. Do not change tests.',
              },
            ]
          : [
              {
                kind: 'tests',
                title: 'Write tests',
                files: ['sqrt.test.js'],
                prompt:
                  'Write automated tests only for integerSqrt(9) === 3. Do not implement production code.',
              },
              {
                kind: 'code',
                title: 'Implement',
                files: ['sqrt.js'],
                prompt:
                  'Implement integerSqrt so the tests pass. Do not change test files.',
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
    jobKind?: string;
    outputFiles?: Array<{ path: string }>;
  }>;
  project?: {
    id: string;
    oraclePaths: string[];
    messages: Array<{ text: string }>;
    plan: Array<{ kind?: string; status: string }>;
    shards?: { testsDir: string; codeDir: string };
  };
  defaults?: { sourceDir: string; goal: string };
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

test('empty project writes tests then code; follow-up does not reset', async () => {
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
  assert.equal(empty.body.defaults?.goal, '');
  assert.equal(empty.body.defaults?.sourceDir, '');

  const created = await json<{ projectId: string }>(base, '/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Integer square root',
      goal: 'Implement integerSqrt so integerSqrt(9) === 3.',
      writerProvider: 'codex',
      maxIterations: 2,
    }),
  });
  assert.equal(created.res.status, 201, JSON.stringify(created.body));
  const projectId = created.body.projectId;
  const workspaceDir = path.join('/tmp/loopsync-workspaces', projectId);

  const succeeded = await waitUntil(async () => {
    const { body } = await json<Snapshot>(base, '/api/state');
    const failed = body.tasks.find((task) => task.status === 'failed');
    if (failed) {
      throw new Error(failed.lastError || 'failed');
    }
    const hasTests = body.project?.oraclePaths?.includes('sqrt.test.js');
    const impl = path.join(workspaceDir, 'sqrt.js');
    const committed = body.tasks.some(
      (task) => task.jobKind === 'code' && Boolean(task.commitSha),
    );
    return hasTests && fs.existsSync(impl) && committed && !body.project?.shards
      ? body
      : null;
  });
  assert.ok(succeeded.project?.oraclePaths.includes('sqrt.test.js'));
  assert.equal(fs.existsSync(path.join(workspaceDir, 'parse.js')), false);
  assert.ok(
    succeeded.tasks.some((task) =>
      task.outputFiles?.some((file) => file.path === 'sqrt.test.js'),
    ),
  );
  assert.ok(
    succeeded.tasks.some((task) =>
      task.outputFiles?.some((file) => file.path === 'sqrt.js'),
    ),
  );

  const follow = await json<{ ok: boolean; taskId: string }>(
    base,
    `/api/projects/${projectId}/messages`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Switch the algorithm to binary search.' }),
    },
  );
  assert.equal(follow.res.status, 201, JSON.stringify(follow.body));

  const afterFollow = await waitUntil(async () => {
    const { body } = await json<Snapshot>(base, '/api/state');
    const task = body.tasks.at(-1);
    if (task?.id === follow.body.taskId && task.status === 'failed') {
      throw new Error(task.lastError || 'follow-up failed');
    }
    return task?.id === follow.body.taskId && task.status === 'succeeded'
      ? body
      : null;
  });
  assert.match(fs.readFileSync(path.join(workspaceDir, 'sqrt.js'), 'utf8'), />> 1/);
  assert.ok(afterFollow.project?.id === projectId);

  await fetch(`${base}/api/reset`, { method: 'POST' });
});

test('tampering with frozen tests is ORACLE_TAMPERED', async () => {
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
      goal: 'Implement integerSqrt so integerSqrt(9) === 3.',
      writerProvider: 'codex',
      maxIterations: 1,
    }),
  });
  assert.equal(created.res.status, 201, JSON.stringify(created.body));
  const failed = await waitUntil(async () => {
    const { body } = await json<Snapshot>(base, '/api/state');
    const task = body.tasks.find(
      (item) => item.jobKind === 'code' && item.status === 'failed',
    );
    return task ?? null;
  });
  assert.match(failed.lastError ?? '', /ORACLE_TAMPERED/);
  assert.equal(failed.commitSha, undefined);
  await fetch(`${base}/api/reset`, { method: 'POST' });
});
