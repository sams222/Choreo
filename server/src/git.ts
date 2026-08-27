import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_TEST_COMMAND,
  ORACLE_PATHS,
  WORKSPACE_ROOT,
  type GitRuntime,
  type OutputFile,
  type WorkspaceContext,
} from '../../protocol/index.ts';

export function createGitRuntime(fixtureDir: string): GitRuntime {
  function resolveCtx(ctx?: WorkspaceContext) {
    const sourceDir = path.resolve(ctx?.sourceDir ?? fixtureDir);
    const oraclePaths = [...(ctx?.oraclePaths ?? ORACLE_PATHS)];
    const testCommand = [...(ctx?.testCommand ?? DEFAULT_TEST_COMMAND)];
    const persistDir = ctx?.persistDir
      ? path.resolve(ctx.persistDir)
      : undefined;
    return { sourceDir, oraclePaths, testCommand, persistDir };
  }

  async function createWorkspace(taskId: string, ctx?: WorkspaceContext) {
    const { sourceDir, persistDir } = resolveCtx(ctx);
    fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
    const dir = persistDir ?? path.join(WORKSPACE_ROOT, taskId);
    const reusing =
      Boolean(persistDir) &&
      fs.existsSync(dir) &&
      fs.readdirSync(dir).some((name) => name !== '.git');

    if (!reusing) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      fs.cpSync(sourceDir, dir, { recursive: true });
    }

    const hadGit = fs.existsSync(path.join(dir, '.git'));
    if (!hadGit) {
      await runGit(dir, ['init']);
    }
    await runGit(dir, ['config', 'user.email', 'loopsync@local']);
    await runGit(dir, ['config', 'user.name', 'LoopSync']);
    await runGit(dir, ['config', 'commit.gpgsign', 'false']);
    if (!hadGit) {
      if (persistDir || ctx?.sourceDir) {
        await runGit(dir, ['add', '-A']);
        await runGit(
          dir,
          ['commit', '-m', 'loopsync baseline', '--no-verify'],
          { env: { GIT_EDITOR: 'true' } },
        );
      } else {
        await runGit(dir, ['add', 'parse.js', 'parse.test.js', 'package.json']);
        await runGit(dir, ['commit', '-m', 'failing parseIndex', '--no-verify'], {
          env: { GIT_EDITOR: 'true' },
        });
      }
    }
    await runGit(dir, ['checkout', '-B', `loopsync/${taskId}`]);

    if (!ctx?.sourceDir && !persistDir) {
      if (
        !fs.existsSync(path.join(dir, 'parse.js')) ||
        !fs.existsSync(path.join(dir, 'parse.test.js'))
      ) {
        throw new Error('parse.js or parse.test.js missing');
      }
    }

    return { dir, branch: `loopsync/${taskId}` };
  }

  async function runTests(dir: string, ctx?: WorkspaceContext) {
    const { testCommand } = resolveCtx(ctx);
    const [bin, ...args] = testCommand;
    if (!bin) {
      throw new Error('testCommand is empty');
    }
    const { output, exitCode } = await run(bin, args, dir);
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

  async function commitIfDirty(
    dir: string,
    message: string,
    ctx?: WorkspaceContext,
  ) {
    const { sourceDir, oraclePaths } = resolveCtx(ctx);
    const resolved = path.resolve(dir);
    const fixture = path.resolve(fixtureDir);
    if (resolved === fixture || resolved.startsWith(fixture + path.sep)) {
      throw new Error('Never commit in original fixture/');
    }
    if (resolved === sourceDir || resolved.startsWith(sourceDir + path.sep)) {
      throw new Error('Never commit in original source directory');
    }

    if (await isOracleDirty(dir, ctx)) {
      throw new Error(
        `ORACLE_TAMPERED: ${oraclePaths.join(', ')} changed; refusing commit`,
      );
    }
    const skip = new Set<string>([...oraclePaths, 'README.md']);
    const status = await runGit(dir, ['status', '--porcelain']);
    const rels = status.stdout
      .split('\n')
      .map((line) => porcelainPath(line))
      .filter((rel) => rel && !skip.has(rel) && !rel.startsWith('.git'));
    if (rels.length === 0) {
      return null;
    }
    await runGit(dir, ['add', '--', ...rels]);

    await runGit(dir, ['commit', '-m', message, '--no-verify'], {
      env: { GIT_EDITOR: 'true' },
    });
    const shaResult = await runGit(dir, ['rev-parse', 'HEAD']);
    const sha = shaResult.stdout.trim();
    const diffResult = await runGit(dir, ['diff', 'HEAD~1', 'HEAD']);
    return { sha, diff: diffResult.stdout };
  }

  async function listOutputs(
    dir: string,
    ctx?: WorkspaceContext,
  ): Promise<OutputFile[]> {
    const { sourceDir, oraclePaths } = resolveCtx(ctx);
    const skip = new Set<string>([
      ...oraclePaths,
      'README.md',
      'package.json',
    ]);
    const files: OutputFile[] = [];
    walk(dir, '', (rel, abs) => {
      if (skip.has(rel) || rel.startsWith('.git')) {
        return;
      }
      const baseline = path.join(sourceDir, rel);
      const content = fs.readFileSync(abs, 'utf8');
      if (content.length > 80_000) {
        return;
      }
      const same =
        fs.existsSync(baseline) &&
        fs.readFileSync(baseline, 'utf8') === content;
      if (same) {
        return;
      }
      files.push({ path: rel, content });
    });
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  async function checkOracle(dir: string, ctx?: WorkspaceContext) {
    const dirty = await isOracleDirty(dir, ctx);
    return { dirty, oracleSha: oracleSha(dir, ctx) };
  }

  async function resetAll() {
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }

  async function isOracleDirty(dir: string, ctx?: WorkspaceContext) {
    const { sourceDir, oraclePaths } = resolveCtx(ctx);
    for (const rel of oraclePaths) {
      const current = path.join(dir, rel);
      const baseline = path.join(sourceDir, rel);
      if (!fs.existsSync(current) || !fs.existsSync(baseline)) {
        return true;
      }
      const left = fs.readFileSync(current);
      const right = fs.readFileSync(baseline);
      if (!left.equals(right)) {
        return true;
      }
    }
    return false;
  }

  function oracleSha(dir: string, ctx?: WorkspaceContext) {
    const { oraclePaths } = resolveCtx(ctx);
    const hash = createHash('sha256');
    for (const rel of oraclePaths) {
      const file = path.join(dir, rel);
      hash.update(rel);
      hash.update(fs.existsSync(file) ? fs.readFileSync(file) : Buffer.from(''));
    }
    return hash.digest('hex');
  }

  return {
    createWorkspace,
    runTests,
    getDiff,
    commitIfDirty,
    resetAll,
    checkOracle,
    listOutputs,
  };
}

function porcelainPath(line: string): string {
  const raw = line.slice(3).trim();
  if (raw.includes(' -> ')) {
    return raw.slice(raw.lastIndexOf(' -> ') + 4);
  }
  return raw.replace(/^"|"$/g, '');
}

function walk(
  root: string,
  rel: string,
  visit: (rel: string, abs: string) => void,
): void {
  const abs = rel ? path.join(root, rel) : root;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') {
      continue;
    }
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const childAbs = path.join(abs, entry.name);
    if (entry.isDirectory()) {
      walk(root, childRel, visit);
    } else if (entry.isFile()) {
      visit(childRel, childAbs);
    }
  }
}

function spawnEnv(extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = extraEnv ? { ...process.env, ...extraEnv } : { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
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
      env: spawnEnv(extraEnv),
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
