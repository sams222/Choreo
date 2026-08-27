import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type {
  CLIAdapter,
  ProviderType,
  ServerSnapshot,
} from '../../protocol/index.ts';
import { createGitRuntime } from './git.ts';
import { createHttpApp, dashboardDefaults } from './http.ts';
import { createStore } from './state.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureDir = path.join(repoRoot, 'fixture');

const PYTHON_TEST = `import unittest

from calcapp.sqrt import sqrt


class SqrtTests(unittest.TestCase):
    def test_perfect_square(self):
        self.assertEqual(sqrt(9), 3)

    def test_negative(self):
        with self.assertRaises(ValueError):
            sqrt(-1)
`;

const FAILING_IMPL = `def sqrt(value):
    return 0
`;

const OVERFLOWING_IMPL = `def sqrt(value):
    if value < 0:
        raise ValueError("no real square root")
    guess = float(value)
    for _ in range(100):
        guess = (guess + value / guess) / 2
    return guess
`;

const ROBUST_IMPL = `def sqrt(value):
    if not isinstance(value, int):
        raise TypeError("value must be an integer")
    if value < 0:
        raise ValueError("no real square root")
    if value < 2:
        return value
    estimate = 1 << ((value.bit_length() + 1) // 2)
    while True:
        refined = (estimate + value // estimate) // 2
        if refined >= estimate:
            return estimate
        estimate = refined
`;

async function waitUntil<T>(
  fn: () => Promise<T | null | false | undefined>,
  timeoutMs = 12_000,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('pipeline timed out');
}

test('full pipeline retries red tests, honors review, commits, and applies', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'choreo-pipeline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'project');
  const workspaces = path.join(root, 'workspaces');
  fs.mkdirSync(sourceDir, { recursive: true });
  process.env.LOOPSYNC_WORKSPACE_ROOT = workspaces;

  let codeWrites = 0;
  let reviews = 0;
  const writer: CLIAdapter = {
    provider: 'codex',
    async run(workspaceDir, prompt) {
      const appDir = path.join(workspaceDir, 'calcapp');
      fs.mkdirSync(appDir, { recursive: true });
      if (/Write automated tests only/i.test(prompt)) {
        fs.writeFileSync(path.join(appDir, 'test_sqrt.py'), PYTHON_TEST);
        return { output: 'wrote calcapp/test_sqrt.py', exitCode: 0 };
      }
      codeWrites += 1;
      const implementation = /OverflowError|large non-square/i.test(prompt)
        ? ROBUST_IMPL
        : codeWrites === 1
          ? FAILING_IMPL
          : OVERFLOWING_IMPL;
      fs.writeFileSync(path.join(appDir, 'sqrt.py'), implementation);
      return { output: `wrote implementation ${codeWrites}`, exitCode: 0 };
    },
  };
  const reviewer: CLIAdapter = {
    provider: 'claude',
    async run(_workspaceDir, prompt) {
      reviews += 1;
      assert.match(prompt, /diff --git .*calcapp\/sqrt\.py/s);
      assert.match(prompt, /FROZEN TEST BASELINE/);
      assert.match(prompt, /calcapp\/test_sqrt\.py/);
      return reviews === 1
        ? {
            output:
              'REVIEW_REJECT\n- OverflowError for a valid large non-square integer.',
            exitCode: 0,
          }
        : { output: 'REVIEW_OK', exitCode: 0 };
    },
  };
  const adapters: Record<ProviderType, CLIAdapter> = {
    codex: writer,
    claude: reviewer,
  };
  const store = createStore(dashboardDefaults({ sourceDir }));
  const app = createHttpApp({
    store,
    git: createGitRuntime(fixtureDir),
    adapters,
    repoRoot,
    projectDir: sourceDir,
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const created = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Python square root',
      goal: 'Write an integer square root function in Python without external libraries.',
      sourceDir,
      writerProvider: 'codex',
      reviewerProvider: 'claude',
      maxIterations: 4,
    }),
  });
  assert.equal(created.status, 201, await created.text());

  const complete = await waitUntil(async () => {
    const snapshot = (await (
      await fetch(`${base}/api/state`)
    ).json()) as ServerSnapshot;
    const failed = snapshot.tasks.find((task) => task.status === 'failed');
    if (failed) throw new Error(failed.lastError ?? 'pipeline failed');
    return snapshot.project?.readyAt ? snapshot : null;
  });
  const project = complete.project;
  assert.ok(project);
  assert.deepEqual(project.testCommand, [
    'python3',
    '-m',
    'unittest',
    'calcapp/test_sqrt.py',
  ]);
  assert.equal(codeWrites, 3);
  assert.equal(reviews, 2);
  const codeTask = complete.tasks.find((task) => task.jobKind === 'code');
  assert.equal(codeTask?.status, 'succeeded');
  assert.equal(codeTask?.currentIteration, 3);
  assert.ok(codeTask?.commitSha);

  const applied = await fetch(`${base}/api/projects/${project.id}/apply`, {
    method: 'POST',
  });
  assert.equal(applied.status, 200, await applied.text());
  assert.equal(fs.existsSync(path.join(sourceDir, 'calcapp', 'sqrt.py')), true);
  assert.equal(
    fs.readFileSync(path.join(sourceDir, 'calcapp', 'sqrt.py'), 'utf8'),
    ROBUST_IMPL,
  );
});
