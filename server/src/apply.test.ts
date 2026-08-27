import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ProjectState, TaskState } from '../../protocol/index.ts';
import { applyWorkspace, isProjectReady } from './http.ts';

function project(over: Partial<ProjectState> = {}): ProjectState {
  return {
    id: 'proj_apply',
    title: 'Calculator',
    goal: 'build a calculator',
    workspaceDir: '/tmp/workspace',
    applyTarget: '/tmp/project',
    testCommand: ['node', '--test'],
    oraclePaths: ['calculator.test.js'],
    writerProvider: 'codex',
    maxIterations: 5,
    messages: [],
    plan: [
      {
        id: 'code',
        title: 'Implement',
        prompt: 'build it',
        files: ['calculator.js'],
        doneWhen: 'tests pass',
        status: 'succeeded',
        kind: 'code',
      },
    ],
    ...over,
  };
}

test('applyWorkspace writes project files and excludes generated internals', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'choreo-apply-'));
  const workspace = path.join(root, 'workspace');
  const target = path.join(root, 'target');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'dist'), { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'calculator.js'), 'export const add = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(workspace, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(workspace, '.git', 'config'), 'private');
  fs.writeFileSync(path.join(workspace, 'node_modules', 'pkg', 'index.js'), 'private');
  fs.writeFileSync(path.join(workspace, 'dist', 'bundle.js'), 'generated');
  fs.writeFileSync(path.join(workspace, 'unchanged.txt'), 'keep\n');
  fs.writeFileSync(path.join(target, 'unchanged.txt'), 'keep\n');

  const files = applyWorkspace(workspace, target);

  assert.deepEqual(files, ['package.json', 'src/calculator.js']);
  assert.equal(
    fs.readFileSync(path.join(target, 'src', 'calculator.js'), 'utf8'),
    'export const add = (a, b) => a + b;\n',
  );
  assert.equal(fs.existsSync(path.join(target, '.git')), false);
  assert.equal(fs.existsSync(path.join(target, 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(target, 'dist')), false);
});

test('project readiness requires successful plans and no active work', () => {
  const done = project();
  assert.equal(isProjectReady(done, []), true);
  assert.equal(
    isProjectReady(done, [
      {
        id: 'task_live',
        title: 'Implement',
        prompt: 'build it',
        provider: 'codex',
        projectId: done.id,
        status: 'running',
        currentIteration: 1,
        maxIterations: 5,
        workspaceDir: '/tmp/workspace',
        logs: [],
      } as TaskState,
    ]),
    false,
  );
  assert.equal(
    isProjectReady(
      project({ plan: [{ ...done.plan[0]!, status: 'failed' }] }),
      [],
    ),
    false,
  );
  assert.equal(
    isProjectReady(project({ shards: { testsDir: '/tmp/a', codeDir: '/tmp/b' } }), []),
    false,
  );
});
