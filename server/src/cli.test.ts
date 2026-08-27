import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { parseCliArgs } from './cli.ts';
import { startChoreo } from './boot.ts';
import { dashboardDefaults } from './http.ts';
import { shouldCopyPath } from './git.ts';
import { PORT } from '../../protocol/index.ts';

test('choreo with no args uses the launch directory', () => {
  const cwd = '/tmp/some-app';
  const opts = parseCliArgs([], cwd);
  assert.equal(opts.projectDir, cwd);
  assert.equal(opts.empty, false);
  assert.equal(opts.open, true);
  assert.equal(opts.port, PORT);
  assert.equal(opts.help, false);
});

test('choreo folder argument is resolved from cwd', () => {
  const opts = parseCliArgs(['../other'], '/tmp/some-app');
  assert.equal(opts.projectDir, path.resolve('/tmp/some-app', '../other'));
});

test('choreo --empty leaves the folder unbound', () => {
  const opts = parseCliArgs(['--empty', '--no-open', '-p', '4099'], '/tmp/app');
  assert.equal(opts.empty, true);
  assert.equal(opts.open, false);
  assert.equal(opts.port, 4099);
  assert.equal(opts.projectDir, '/tmp/app');
});

test('choreo rejects a bad port', () => {
  const opts = parseCliArgs(['--port', 'nope']);
  assert.match(opts.error ?? '', /port/);
});

test('dashboard defaults bind the launch folder', () => {
  const projectDir = path.join(os.tmpdir(), 'loopsync-cli-app');
  const defaults = dashboardDefaults({
    sourceDir: projectDir,
    title: path.basename(projectDir),
  });
  assert.equal(defaults.sourceDir, projectDir);
  assert.equal(defaults.title, 'loopsync-cli-app');
});

test('startChoreo defaults sourceDir to the launch folder', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choreo-cli-'));
  const server = await startChoreo({
    projectDir,
    open: false,
    port: 0,
    host: '127.0.0.1',
  });
  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/api/state`);
  assert.equal(res.ok, true);
  const body = (await res.json()) as {
    defaults?: { sourceDir?: string; title?: string };
  };
  assert.equal(body.defaults?.sourceDir, projectDir);
  assert.equal(body.defaults?.title, path.basename(projectDir));
});

test('workspace copy skips node_modules and .git', () => {
  const root = '/tmp/app';
  assert.equal(shouldCopyPath(root, root), true);
  assert.equal(shouldCopyPath(root, path.join(root, 'src/index.ts')), true);
  assert.equal(shouldCopyPath(root, path.join(root, 'node_modules')), false);
  assert.equal(
    shouldCopyPath(root, path.join(root, 'node_modules/left-pad/index.js')),
    false,
  );
  assert.equal(shouldCopyPath(root, path.join(root, '.git/HEAD')), false);
  assert.equal(shouldCopyPath(root, path.join(root, 'dist/bundle.js')), false);
});
