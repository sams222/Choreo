import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGitRuntime } from './git.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureDir = path.join(repoRoot, 'fixture');

test('review diff includes tracked edits and untracked implementation files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'choreo-review-diff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaceDir = path.join(root, 'workspace');
  const git = createGitRuntime(fixtureDir);
  await git.createWorkspace('review-diff', {
    empty: true,
    persistDir: workspaceDir,
    oraclePaths: [],
    testCommand: ['node', '--test'],
  });

  fs.writeFileSync(path.join(workspaceDir, 'tracked.txt'), 'before\n');
  await git.commitIfDirty(workspaceDir, 'baseline', {
    empty: true,
    persistDir: workspaceDir,
    oraclePaths: [],
    testCommand: ['node', '--test'],
  });
  fs.writeFileSync(path.join(workspaceDir, 'tracked.txt'), 'after\n');
  fs.writeFileSync(
    path.join(workspaceDir, 'sqrt.py'),
    'def sqrt(value):\n    return value\n',
  );

  const diff = await git.getDiff(workspaceDir);
  assert.match(diff, /tracked\.txt/);
  assert.match(diff, /-before/);
  assert.match(diff, /\+after/);
  assert.match(diff, /sqrt\.py/);
  assert.match(diff, /\+def sqrt/);
});
