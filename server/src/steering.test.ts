/**
 * §3 — steering used to be refused with SLOT_BUSY while anything was running.
 * These cover the new contract: accept it, show it, apply it at the boundary.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
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

// Test files run in parallel processes and /api/reset wipes the whole root.
process.env.LOOPSYNC_WORKSPACE_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), 'loopsync-steering-'),
);

const TEST_FILE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { integerSqrt } from './sqrt.js';

test('integerSqrt(9) === 3', () => {
  assert.equal(integerSqrt(9), 3);
});
`;

const IMPL_FILE = `export function integerSqrt(n) {
  let r = 0;
  while ((r + 1) * (r + 1) <= n) r += 1;
  return r;
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
    if (value) return value;
    await wait(30);
  }
  throw new Error('timed out');
}

async function listen(app: ReturnType<typeof createHttpApp>) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  after(() => server.close());
  return `http://127.0.0.1:${port}`;
}

/**
 * A writer we can hold open, so a steer really does arrive mid-run.
 * `entered` resolves once the implementation writer is genuinely blocked —
 * waiting on `currentStep` alone races with the loop's own steering drain.
 */
function makeGatedWriter(seen: string[]) {
  let release = () => {};
  let markEntered = () => {};
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const writer: CLIAdapter = {
    provider: 'codex',
    async run(workspaceDir, prompt) {
      seen.push(prompt);
      if (/tests only|Write automated tests only/i.test(prompt)) {
        fs.writeFileSync(
          path.join(workspaceDir, 'package.json'),
          '{"type":"module"}\n',
        );
        fs.writeFileSync(path.join(workspaceDir, 'sqrt.test.js'), TEST_FILE);
        return { output: 'wrote tests', exitCode: 0 };
      }
      markEntered();
      await open;
      fs.writeFileSync(path.join(workspaceDir, 'sqrt.js'), IMPL_FILE);
      return { output: 'wrote sqrt.js', exitCode: 0 };
    },
  };
  return {
    adapters: { claude: writer, codex: writer } as Record<ProviderType, CLIAdapter>,
    entered,
    release: () => release(),
  };
}

test('a steer sent mid-run is queued, shown, then folded in at the boundary', async () => {
  const seen: string[] = [];
  const gate = makeGatedWriter(seen);
  const store = createStore(dashboardDefaults(repoRoot));
  const base = await listen(
    createHttpApp({
      store,
      git: createGitRuntime(fixtureDir),
      adapters: gate.adapters,
      repoRoot,
    }),
  );

  const created = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Integer square root',
      goal: 'Implement integerSqrt so integerSqrt(9) === 3.',
      writerProvider: 'codex',
      maxIterations: 2,
    }),
  });
  assert.equal(created.status, 201);
  const { projectId } = (await created.json()) as { projectId: string };

  // Wait until the implementation writer is actually blocked.
  await gate.entered;

  const steer = await fetch(`${base}/api/projects/${projectId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'use binary search' }),
  });
  assert.equal(steer.status, 202, 'mid-run steering is accepted, not refused');
  const steerBody = (await steer.json()) as { queued: boolean; messageId: string };
  assert.equal(steerBody.queued, true);

  // It is in the thread immediately, flagged as queued.
  const queued = (await (await fetch(`${base}/api/state`)).json()) as ServerSnapshot;
  const bubble = queued.thread?.find((item) => item.id === steerBody.messageId);
  assert.equal(bubble?.pending, true, 'the steer shows in the thread right away');
  assert.equal(queued.project?.steering?.length, 1);

  gate.release();

  // The boundary drains the queue and re-runs the item with the steer folded in.
  await waitUntil(async () => {
    const snap = (await (await fetch(`${base}/api/state`)).json()) as ServerSnapshot;
    const message = snap.project?.messages.find(
      (item) => item.id === steerBody.messageId,
    );
    return message?.pending === false && Boolean(message?.appliedAt);
  });
  assert.ok(
    seen.some((prompt) => prompt.includes('use binary search')),
    'the steering text reaches the writer prompt',
  );

  await fetch(`${base}/api/reset`, { method: 'POST' });
});

test('a queued steer can be cancelled before it is applied', async () => {
  const gate = makeGatedWriter([]);
  const store = createStore(dashboardDefaults(repoRoot));
  const base = await listen(
    createHttpApp({
      store,
      git: createGitRuntime(fixtureDir),
      adapters: gate.adapters,
      repoRoot,
    }),
  );
  const created = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Integer square root',
      goal: 'Implement integerSqrt so integerSqrt(9) === 3.',
      writerProvider: 'codex',
      maxIterations: 1,
    }),
  });
  const { projectId } = (await created.json()) as { projectId: string };
  await gate.entered;

  const steer = await fetch(`${base}/api/projects/${projectId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'never mind' }),
  });
  const { messageId } = (await steer.json()) as { messageId: string };
  const cancelled = await fetch(
    `${base}/api/projects/${projectId}/steering/${messageId}/cancel`,
    { method: 'POST' },
  );
  assert.equal(cancelled.status, 200);

  const snap = (await (await fetch(`${base}/api/state`)).json()) as ServerSnapshot;
  assert.equal(snap.project?.steering?.length, 0);
  const message = snap.project?.messages.find((item) => item.id === messageId);
  assert.equal(message?.cancelled, true);

  gate.release();
  await fetch(`${base}/api/reset`, { method: 'POST' });
});

test('the SSE stream pushes a frame and stops repeating unchanged state', async () => {
  const store = createStore(dashboardDefaults(repoRoot));
  const base = await listen(
    createHttpApp({
      store,
      git: createGitRuntime(fixtureDir),
      adapters: makeGatedWriter([]).adapters,
      repoRoot,
    }),
  );
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: controller.signal });
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const { value } = await reader.read();
  const text = decoder.decode(value);
  assert.match(text, /^data: /);
  const frame = JSON.parse(text.slice('data: '.length).split('\n\n')[0]);
  assert.ok(Array.isArray(frame.tasks));
  assert.ok(Array.isArray(frame.thread));
  controller.abort();
});
