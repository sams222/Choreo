import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WORKSPACE_ROOT, type GitRuntime } from '../../protocol/index.ts';

export function createGitRuntime(fixtureDir: string): GitRuntime {
  async function createWorkspace(taskId: string) {
    fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
    const dir = path.join(WORKSPACE_ROOT, taskId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.cpSync(fixtureDir, dir, { recursive: true });

    const hadGit = fs.existsSync(path.join(dir, '.git'));
    if (!hadGit) {
      await runGit(dir, ['init']);
    }
    await runGit(dir, ['config', 'user.email', 'loopsync@local']);
    await runGit(dir, ['config', 'user.name', 'LoopSync']);
    await runGit(dir, ['config', 'commit.gpgsign', 'false']);
    if (!hadGit) {
      await runGit(dir, ['add', 'parse.js', 'parse.test.js', 'package.json']);
      await runGit(dir, ['commit', '-m', 'failing parseIndex', '--no-verify'], {
        env: { GIT_EDITOR: 'true' },
      });
    }
    await runGit(dir, ['checkout', '-b', `loopsync/${taskId}`]);

    if (
      !fs.existsSync(path.join(dir, 'parse.js')) ||
      !fs.existsSync(path.join(dir, 'parse.test.js'))
    ) {
      throw new Error('parse.js or parse.test.js missing');
    }

    return { dir, branch: `loopsync/${taskId}` };
  }

  async function runTests(dir: string) {
    const { output, exitCode } = await run('node', ['--test'], dir);
    return { passed: exitCode === 0, exitCode, output };
  }

  async function getDiff(dir: string) {
    const head = await runGit(dir, ['diff', 'HEAD'], { allowFail: true });
    const vsHead = head.stdout;
    if (vsHead.trim() !== '') {
      return vsHead;
    }
    const cached = await runGit(dir, ['diff', '--cached'], { allowFail: true });
    return cached.stdout;
  }

  async function commitIfDirty(dir: string, message: string) {
    const resolved = path.resolve(dir);
    const fixture = path.resolve(fixtureDir);
    if (resolved === fixture || resolved.startsWith(fixture + path.sep)) {
      throw new Error('Never commit in original fixture/');
    }

    // Only the homework file. `git add -A` also stages untracked fixture
    // extras (README.md) and pollutes the demo SHA.
    await runGit(dir, ['add', '--', 'parse.js']);
    const status = await runGit(dir, ['status', '--porcelain']);
    if (status.stdout.trim() === '') {
      return null;
    }

    await runGit(dir, ['commit', '-m', message, '--no-verify'], {
      env: { GIT_EDITOR: 'true' },
    });
    const shaResult = await runGit(dir, ['rev-parse', 'HEAD']);
    const sha = shaResult.stdout.trim();
    const diffResult = await runGit(dir, ['diff', 'HEAD~1', 'HEAD']);
    return { sha, diff: diffResult.stdout };
  }

  async function resetAll() {
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }

  return { createWorkspace, runTests, getDiff, commitIfDirty, resetAll };
}

type SpawnResult = {
  stdout: string;
  stderr: string;
  output: string;
  exitCode: number;
};

function run(
  command: string,
  args: string[],
  cwd: string,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    let stdout = '';
    let stderr = '';
    let output = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      stdout += text;
      output += text;
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      stderr += text;
      output += text;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, output, exitCode: code ?? 1 });
    });
  });
}

async function runGit(
  cwd: string,
  args: string[],
  options?: { allowFail?: boolean; env?: NodeJS.ProcessEnv },
): Promise<SpawnResult> {
  const result = await run('git', args, cwd, options?.env);
  if (!options?.allowFail && result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}
