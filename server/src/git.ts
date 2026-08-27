import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_TEST_COMMAND,
  ORACLE_PATHS,
  workspaceRoot,
  isTestPath,
  type GitRuntime,
  type OutputFile,
  type WorkspaceContext,
} from '../../protocol/index.ts';

const SKIP_COPY_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.choreo',
]);

export function shouldCopyPath(sourceRoot: string, src: string): boolean {
  const rel = path.relative(sourceRoot, src);
  if (!rel || rel === '.') {
    return true;
  }
  return !rel.split(path.sep).some((part) => SKIP_COPY_NAMES.has(part));
}

export function createGitRuntime(fixtureDir: string): GitRuntime {
  function resolveCtx(ctx?: WorkspaceContext) {
    const empty = Boolean(ctx?.empty) || (Boolean(ctx?.persistDir) && !ctx?.sourceDir);
    const sourceDir = empty
      ? undefined
      : path.resolve(ctx?.sourceDir ?? fixtureDir);
    const oraclePaths =
      ctx?.oraclePaths !== undefined
        ? [...ctx.oraclePaths]
        : empty
          ? []
          : [...ORACLE_PATHS];
    const testCommand = [...(ctx?.testCommand ?? DEFAULT_TEST_COMMAND)];
    const persistDir = ctx?.persistDir
      ? path.resolve(ctx.persistDir)
      : undefined;
    const mode = ctx?.mode;
    return { sourceDir, oraclePaths, testCommand, persistDir, empty, mode };
  }

  async function createWorkspace(taskId: string, ctx?: WorkspaceContext) {
    const { sourceDir, persistDir, empty } = resolveCtx(ctx);
    const root = workspaceRoot();
    fs.mkdirSync(root, { recursive: true });
    const dir = persistDir ?? path.join(root, taskId);
    const reusing =
      Boolean(persistDir) &&
      fs.existsSync(dir) &&
      fs.readdirSync(dir).some((name) => name !== '.git');

    if (!reusing) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      if (sourceDir && fs.existsSync(sourceDir)) {
        fs.cpSync(sourceDir, dir, {
          recursive: true,
          filter: (src) => shouldCopyPath(sourceDir, src),
        });
      } else {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    const hadGit = fs.existsSync(path.join(dir, '.git'));
    if (!hadGit) {
      await runGit(dir, ['init']);
    }
    await runGit(dir, ['config', 'user.email', 'choreo@local']);
    await runGit(dir, ['config', 'user.name', 'Choreo']);
    await runGit(dir, ['config', 'commit.gpgsign', 'false']);
    if (!hadGit) {
      if (empty || persistDir || ctx?.sourceDir) {
        await runGit(dir, ['add', '-A']);
        await runGit(
          dir,
          ['commit', '-m', 'loopsync baseline', '--allow-empty', '--no-verify'],
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

    if (!ctx?.sourceDir && !persistDir && !empty) {
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
    const chunks = head.stdout.trim() === '' ? [] : [head.stdout];
    const status = await runGit(
      dir,
      ['status', '--porcelain', '--untracked-files=all'],
      { allowFail: true },
    );
    const untracked = status.stdout
      .split('\n')
      .filter((line) => line.startsWith('?? '))
      .map((line) => porcelainPath(line))
      .filter(Boolean);
    for (const rel of untracked) {
      const file = path.join(dir, rel);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        continue;
      }
      const patch = await runGit(
        dir,
        [
          'diff',
          '--no-index',
          '--',
          process.platform === 'win32' ? 'NUL' : '/dev/null',
          rel,
        ],
        { allowFail: true },
      );
      if (patch.stdout.trim() !== '') {
        chunks.push(patch.stdout);
      }
    }
    return chunks.join('\n');
  }

  async function commitIfDirty(
    dir: string,
    message: string,
    ctx?: WorkspaceContext,
  ) {
    const { sourceDir, oraclePaths, mode } = resolveCtx(ctx);
    const resolved = path.resolve(dir);
    const fixture = path.resolve(fixtureDir);
    if (resolved === fixture || resolved.startsWith(fixture + path.sep)) {
      throw new Error('Never commit in original fixture/');
    }
    if (
      sourceDir &&
      (resolved === sourceDir || resolved.startsWith(sourceDir + path.sep))
    ) {
      throw new Error('Never commit in original source directory');
    }

    if (mode !== 'tests' && (await isOracleDirty(dir, ctx))) {
      throw new Error(
        `ORACLE_TAMPERED: ${oraclePaths.join(', ')} changed; refusing commit`,
      );
    }
    const skip = new Set<string>(
      mode === 'tests' ? ['README.md'] : [...oraclePaths, 'README.md'],
    );
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
    const files: OutputFile[] = [];
    walk(dir, '', (rel, abs) => {
      if (rel.startsWith('.git') || rel === 'README.md' || rel === 'package.json') {
        return;
      }
      const content = fs.readFileSync(abs, 'utf8');
      if (content.length > 80_000) {
        return;
      }
      const locked = oraclePaths.includes(rel) || isTestPath(rel);
      const baseline = sourceDir ? path.join(sourceDir, rel) : '';
      const same =
        Boolean(sourceDir) &&
        fs.existsSync(baseline) &&
        fs.readFileSync(baseline, 'utf8') === content;
      if (same && !locked) {
        return;
      }
      if (same && locked && oraclePaths.includes(rel)) {
        files.push({ path: rel, content, locked: true });
        return;
      }
      if (!same) {
        files.push({ path: rel, content, locked: oraclePaths.includes(rel) });
      }
    });
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  async function checkOracle(dir: string, ctx?: WorkspaceContext) {
    const dirty = await isOracleDirty(dir, ctx);
    return { dirty, oracleSha: oracleSha(dir, ctx) };
  }

  async function resetAll() {
    fs.rmSync(workspaceRoot(), { recursive: true, force: true });
  }

  async function isOracleDirty(dir: string, ctx?: WorkspaceContext) {
    const { sourceDir, oraclePaths } = resolveCtx(ctx);
    if (oraclePaths.length === 0) {
      return false;
    }
    for (const rel of oraclePaths) {
      const current = path.join(dir, rel);
      if (!fs.existsSync(current)) {
        return true;
      }
      const left = fs.readFileSync(current);
      const fromSource =
        sourceDir && fs.existsSync(path.join(sourceDir, rel))
          ? fs.readFileSync(path.join(sourceDir, rel))
          : null;
      if (fromSource && !left.equals(fromSource)) {
        return true;
      }
      if (fromSource) {
        continue;
      }
      const shown = await runGit(dir, ['show', `HEAD:${rel}`], { allowFail: true });
      if (shown.exitCode !== 0) {
        continue;
      }
      if (!left.equals(Buffer.from(shown.stdout))) {
        return true;
      }
    }
    return false;
  }

  async function listTestFiles(dir: string): Promise<string[]> {
    const files: string[] = [];
    walk(dir, '', (rel) => {
      if (isTestPath(rel)) {
        files.push(rel);
      }
    });
    return files.sort();
  }

  async function mergeShards(dest: string, testsDir: string, codeDir: string) {
    fs.mkdirSync(dest, { recursive: true });
    walk(codeDir, '', (rel, abs) => {
      if (isTestPath(rel)) {
        return;
      }
      const target = path.join(dest, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(abs, target);
    });
    walk(testsDir, '', (rel, abs) => {
      if (!isTestPath(rel)) {
        return;
      }
      const target = path.join(dest, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(abs, target);
    });
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
    listTestFiles,
    mergeShards,
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
