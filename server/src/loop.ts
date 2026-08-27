import {
  retryPrompt,
  type CLIAdapter,
  type GitRuntime,
  type ProviderType,
} from '../../protocol/index.ts';
import type { Store } from './state.ts';

export async function runLoop(opts: {
  store: Store;
  git: GitRuntime;
  adapters: Record<ProviderType, CLIAdapter>;
  taskId: string;
  signal: AbortSignal;
}): Promise<void> {
  const { store, git, adapters, taskId, signal } = opts;
  const initial = store.getTask(taskId);
  if (!initial) {
    return;
  }

  const { provider, prompt, maxIterations, title } = initial;
  store.setBusy(provider, true);

  try {
    await executeLoop({
      store,
      git,
      adapters,
      taskId,
      signal,
      provider,
      prompt,
      maxIterations,
      title,
    });
  } finally {
    store.setBusy(provider, false);
  }
}

async function executeLoop(opts: {
  store: Store;
  git: GitRuntime;
  adapters: Record<ProviderType, CLIAdapter>;
  taskId: string;
  signal: AbortSignal;
  provider: ProviderType;
  prompt: string;
  maxIterations: number;
  title: string;
}): Promise<void> {
  const {
    store,
    git,
    adapters,
    taskId,
    signal,
    provider,
    prompt,
    maxIterations,
    title,
  } = opts;

  if (isGone(store, taskId, signal)) {
    markFailed(store, taskId, 'cancelled');
    return;
  }

  let workspaceDir = '';
  try {
    const workspace = await git.createWorkspace(taskId);
    workspaceDir = workspace.dir;
    store.updateTask(taskId, { workspaceDir });
    appendLine(
      store,
      taskId,
      `[loop] workspace ${workspace.dir} branch ${workspace.branch}`,
    );
  } catch (err) {
    const message = errorMessage(err);
    appendLine(store, taskId, `[loop] createWorkspace failed: ${message}`);
    markFailed(store, taskId, message);
    return;
  }

  let lastTestOutput = '';

  for (let attempt = 1; attempt <= maxIterations; attempt++) {
    if (isGone(store, taskId, signal)) {
      markFailed(store, taskId, 'cancelled');
      return;
    }

    store.updateTask(taskId, {
      status: attempt === 1 ? 'running' : 'retrying',
      currentIteration: attempt,
    });
    appendLine(
      store,
      taskId,
      `[loop] attempt ${attempt}/${maxIterations} provider=${provider}`,
    );

    const attemptPrompt =
      attempt === 1 ? prompt : retryPrompt(prompt, lastTestOutput);

    try {
      await adapters[provider].run(
        workspaceDir,
        attemptPrompt,
        (text) => appendChunk(store, taskId, `[${provider}] `, text),
        signal,
      );
    } catch (err) {
      if (isGone(store, taskId, signal)) {
        markFailed(store, taskId, 'cancelled');
        return;
      }
      const message = errorMessage(err);
      appendLine(store, taskId, `[loop] adapter error: ${message}`);
      markFailed(store, taskId, message);
      return;
    }

    if (isGone(store, taskId, signal)) {
      markFailed(store, taskId, 'cancelled');
      return;
    }

    let tests;
    try {
      tests = await git.runTests(workspaceDir);
    } catch (err) {
      const message = errorMessage(err);
      appendLine(store, taskId, `[tests] error: ${message}`);
      markFailed(store, taskId, message);
      return;
    }

    if (tests.passed) {
      appendLine(store, taskId, `[tests] pass exit=${tests.exitCode}`);
      if (isGone(store, taskId, signal)) {
        markFailed(store, taskId, 'cancelled');
        return;
      }

      try {
        const commit = await git.commitIfDirty(workspaceDir, `LoopSync: ${title}`);
        if (!commit) {
          appendLine(store, taskId, '[git] working tree clean after passing tests');
          markFailed(store, taskId, 'tests passed but nothing to commit');
          return;
        }
        appendLine(store, taskId, `[git] committed ${commit.sha.slice(0, 7)}`);
        store.updateTask(taskId, {
          status: 'succeeded',
          commitSha: commit.sha,
          diff: commit.diff,
        });
        return;
      } catch (err) {
        const message = errorMessage(err);
        appendLine(store, taskId, `[git] commit failed: ${message}`);
        markFailed(store, taskId, message);
        return;
      }
    }

    lastTestOutput = tests.output;
    appendLine(store, taskId, `[tests] fail exit=${tests.exitCode}`);
    store.updateTask(taskId, { lastError: tests.output });
  }

  appendLine(store, taskId, '[loop] giving up');
  markFailed(store, taskId, lastTestOutput || 'tests failed');
}

function isGone(store: Store, taskId: string, signal: AbortSignal): boolean {
  return signal.aborted || store.getTask(taskId) === undefined;
}

function markFailed(store: Store, taskId: string, lastError: string): void {
  if (!store.getTask(taskId)) {
    return;
  }
  store.updateTask(taskId, { status: 'failed', lastError });
}

function appendLine(store: Store, taskId: string, line: string): void {
  appendLines(store, taskId, [line]);
}

function appendChunk(
  store: Store,
  taskId: string,
  prefix: string,
  chunk: string,
): void {
  const lines = chunk
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => `${prefix}${line}`);
  appendLines(store, taskId, lines);
}

function appendLines(store: Store, taskId: string, lines: string[]): void {
  if (lines.length === 0) {
    return;
  }
  const task = store.getTask(taskId);
  if (!task) {
    return;
  }
  store.updateTask(taskId, { logs: [...task.logs, ...lines] });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
