import {
  parseReviewVerdict,
  planPrompt,
  reviewPrompt,
  reviewRetryPrompt,
  retryPrompt,
  writerPromptWithPlan,
  type CLIAdapter,
  type GitRuntime,
  type ProviderType,
  type StepId,
  type StepState,
  type StepStatus,
} from '../../protocol/index.ts';
import type { Ledger } from './ledger.ts';
import type { Store } from './state.ts';

export async function runLoop(opts: {
  store: Store;
  git: GitRuntime;
  adapters: Record<ProviderType, CLIAdapter>;
  taskId: string;
  signal: AbortSignal;
  ledger?: Ledger;
}): Promise<void> {
  const { store, git, adapters, taskId, signal, ledger } = opts;
  const initial = store.getTask(taskId);
  if (!initial) {
    return;
  }

  const involved = new Set<ProviderType>([initial.provider]);
  if (initial.reviewerProvider) {
    involved.add(initial.reviewerProvider);
  }
  if (initial.orchestratorProvider) {
    involved.add(initial.orchestratorProvider);
  }
  for (const provider of involved) {
    store.setBusy(provider, true);
  }

  try {
    await executeLoop({
      store,
      git,
      adapters,
      ledger,
      taskId,
      signal,
    });
  } finally {
    for (const provider of involved) {
      store.setBusy(provider, false);
    }
  }
}

async function executeLoop(opts: {
  store: Store;
  git: GitRuntime;
  adapters: Record<ProviderType, CLIAdapter>;
  ledger?: Ledger;
  taskId: string;
  signal: AbortSignal;
}): Promise<void> {
  const { store, git, adapters, ledger, taskId, signal } = opts;
  const initial = store.getTask(taskId);
  if (!initial) {
    return;
  }

  const {
    provider,
    prompt,
    maxIterations,
    title,
    reviewerProvider,
    orchestratorProvider,
  } = initial;

  const record = (
    event: string,
    extra?: { attempt?: number; step?: string; detail?: string },
  ) => {
    ledger?.append({ taskId, event, ...extra });
  };

  if (isGone(store, taskId, signal)) {
    markFailed(store, taskId, 'cancelled');
    record('cancelled');
    return;
  }

  let workspaceDir = '';
  try {
    const workspace = await git.createWorkspace(taskId);
    workspaceDir = workspace.dir;
    const oracle = await git.checkOracle(workspaceDir);
    store.updateTask(taskId, {
      workspaceDir,
      oracleSha: oracle.oracleSha,
      capsRemaining: maxIterations,
    });
    appendLine(
      store,
      taskId,
      `[loop] workspace ${workspace.dir} branch ${workspace.branch}`,
    );
    record('workspace', { detail: workspace.dir });
  } catch (err) {
    const message = errorMessage(err);
    appendLine(store, taskId, `[loop] createWorkspace failed: ${message}`);
    markFailed(store, taskId, message);
    record('workspace_failed', { detail: message });
    return;
  }

  let lastTestOutput = '';
  let lastReviewOutput = '';
  let planText = '';

  for (let attempt = 1; attempt <= maxIterations; attempt++) {
    if (isGone(store, taskId, signal)) {
      markFailed(store, taskId, 'cancelled');
      record('cancelled', { attempt });
      return;
    }

    const capsRemaining = maxIterations - attempt + 1;
    store.updateTask(taskId, {
      status: attempt === 1 ? 'running' : 'retrying',
      currentIteration: attempt,
      capsRemaining,
    });
    appendLine(
      store,
      taskId,
      `[loop] attempt ${attempt}/${maxIterations} writer=${provider}` +
        (reviewerProvider ? ` reviewer=${reviewerProvider}` : '') +
        (orchestratorProvider ? ` orchestrator=${orchestratorProvider}` : ''),
    );
    record('attempt', { attempt });

    if (orchestratorProvider && attempt === 1) {
      setStep(store, taskId, 'writer', 'pending');
      store.updateTask(taskId, { currentStep: 'plan' });
      appendLine(
        store,
        taskId,
        `[loop] plan via ${orchestratorProvider}`,
      );
      try {
        const planResult = await adapters[orchestratorProvider].run(
          workspaceDir,
          planPrompt(title, prompt),
          (text) => appendChunk(store, taskId, '[plan] ', text),
          signal,
        );
        planText = planResult.output;
        record('plan', { attempt, step: 'plan', detail: 'ok' });
      } catch (err) {
        if (isGone(store, taskId, signal)) {
          markFailed(store, taskId, 'cancelled');
          return;
        }
        const message = errorMessage(err);
        appendLine(store, taskId, `[loop] plan error: ${message}`);
        markFailed(store, taskId, message);
        record('plan_failed', { attempt, detail: message });
        return;
      }
    }

    if (isGone(store, taskId, signal)) {
      markFailed(store, taskId, 'cancelled');
      return;
    }

    setStep(store, taskId, 'writer', 'running');
    store.updateTask(taskId, { currentStep: 'writer' });

    let writerPrompt = prompt;
    if (attempt === 1 && planText) {
      writerPrompt = writerPromptWithPlan(prompt, planText);
    } else if (attempt > 1 && lastReviewOutput) {
      writerPrompt = reviewRetryPrompt(prompt, lastReviewOutput);
    } else if (attempt > 1) {
      writerPrompt = retryPrompt(prompt, lastTestOutput);
    }

    try {
      await adapters[provider].run(
        workspaceDir,
        writerPrompt,
        (text) => appendChunk(store, taskId, '[writer] ', text),
        signal,
      );
      setStep(store, taskId, 'writer', 'ok');
      record('writer', { attempt, step: 'writer' });
    } catch (err) {
      if (isGone(store, taskId, signal)) {
        markFailed(store, taskId, 'cancelled');
        return;
      }
      const message = errorMessage(err);
      appendLine(store, taskId, `[writer] adapter error: ${message}`);
      setStep(store, taskId, 'writer', 'fail');
      markFailed(store, taskId, message);
      record('writer_failed', { attempt, detail: message });
      return;
    }

    if (isGone(store, taskId, signal)) {
      markFailed(store, taskId, 'cancelled');
      return;
    }

    store.updateTask(taskId, { currentStep: 'oracle' });
    let oracle;
    try {
      oracle = await git.checkOracle(workspaceDir);
    } catch (err) {
      const message = errorMessage(err);
      markFailed(store, taskId, message);
      return;
    }
    store.updateTask(taskId, { oracleSha: oracle.oracleSha });
    if (oracle.dirty) {
      appendLine(
        store,
        taskId,
        '[loop] ORACLE_TAMPERED parse.test.js changed; refusing commit',
      );
      setStep(store, taskId, 'tests', 'fail');
      setStep(store, taskId, 'git', 'fail');
      markFailed(store, taskId, 'ORACLE_TAMPERED');
      record('oracle_tampered', { attempt, step: 'oracle' });
      return;
    }
    appendLine(store, taskId, `[loop] oracle ok sha=${oracle.oracleSha.slice(0, 12)}`);

    setStep(store, taskId, 'tests', 'running');
    store.updateTask(taskId, { currentStep: 'tests' });

    let tests;
    try {
      tests = await git.runTests(workspaceDir);
    } catch (err) {
      const message = errorMessage(err);
      appendLine(store, taskId, `[tests] error: ${message}`);
      setStep(store, taskId, 'tests', 'fail');
      markFailed(store, taskId, message);
      return;
    }

    if (!tests.passed) {
      lastTestOutput = tests.output;
      lastReviewOutput = '';
      appendLine(store, taskId, `[tests] fail exit=${tests.exitCode}`);
      setStep(store, taskId, 'tests', 'fail');
      if (reviewerProvider) {
        setStep(store, taskId, 'review', 'skipped');
      }
      store.updateTask(taskId, { lastError: tests.output });
      record('tests_fail', { attempt, step: 'tests' });
      continue;
    }

    appendLine(store, taskId, `[tests] pass exit=${tests.exitCode}`);
    setStep(store, taskId, 'tests', 'ok');
    record('tests_pass', { attempt, step: 'tests' });

    if (reviewerProvider) {
      if (isGone(store, taskId, signal)) {
        markFailed(store, taskId, 'cancelled');
        return;
      }
      setStep(store, taskId, 'review', 'running');
      store.updateTask(taskId, { currentStep: 'review' });
      appendLine(
        store,
        taskId,
        `[review] adversarial pass via ${reviewerProvider}`,
      );
      let reviewOutput = '';
      try {
        const diff = await git.getDiff(workspaceDir);
        const result = await adapters[reviewerProvider].run(
          workspaceDir,
          reviewPrompt(diff),
          (text) => appendChunk(store, taskId, '[review] ', text),
          signal,
        );
        reviewOutput = result.output;
      } catch (err) {
        if (isGone(store, taskId, signal)) {
          markFailed(store, taskId, 'cancelled');
          return;
        }
        const message = errorMessage(err);
        appendLine(store, taskId, `[review] adapter error: ${message}`);
        setStep(store, taskId, 'review', 'fail');
        markFailed(store, taskId, message);
        return;
      }

      const verdict = parseReviewVerdict(reviewOutput);
      store.updateTask(taskId, { lastReview: verdict });
      if (verdict !== 'ok') {
        lastReviewOutput = reviewOutput;
        appendLine(store, taskId, '[review] REVIEW_REJECT');
        setStep(store, taskId, 'review', 'fail');
        setStep(store, taskId, 'git', 'pending');
        store.updateTask(taskId, { lastError: reviewOutput || 'REVIEW_REJECT' });
        record('review_reject', { attempt, step: 'review' });
        continue;
      }
      appendLine(store, taskId, '[review] REVIEW_OK');
      setStep(store, taskId, 'review', 'ok');
      record('review_ok', { attempt, step: 'review' });
    } else {
      setStep(store, taskId, 'review', 'skipped');
    }

    if (isGone(store, taskId, signal)) {
      markFailed(store, taskId, 'cancelled');
      return;
    }

    setStep(store, taskId, 'git', 'running');
    store.updateTask(taskId, { currentStep: 'git' });
    try {
      const commit = await git.commitIfDirty(workspaceDir, `LoopSync: ${title}`);
      if (!commit) {
        appendLine(store, taskId, '[git] working tree clean after passing tests');
        setStep(store, taskId, 'git', 'fail');
        markFailed(store, taskId, 'tests passed but nothing to commit');
        return;
      }
      appendLine(store, taskId, `[git] committed ${commit.sha.slice(0, 7)}`);
      setStep(store, taskId, 'git', 'ok');
      store.updateTask(taskId, {
        status: 'succeeded',
        currentStep: 'done',
        commitSha: commit.sha,
        diff: commit.diff,
        capsRemaining: capsRemaining - 1,
      });
      record('succeeded', { attempt, step: 'git', detail: commit.sha });
      return;
    } catch (err) {
      const message = errorMessage(err);
      appendLine(store, taskId, `[git] commit failed: ${message}`);
      setStep(store, taskId, 'git', 'fail');
      markFailed(store, taskId, message);
      record('commit_failed', { attempt, detail: message });
      return;
    }
  }

  appendLine(store, taskId, '[loop] CAP_EXHAUSTED giving up');
  store.updateTask(taskId, { capsRemaining: 0, currentStep: 'done' });
  markFailed(store, taskId, lastTestOutput || lastReviewOutput || 'CAP_EXHAUSTED');
  record('cap_exhausted');
}

function isGone(store: Store, taskId: string, signal: AbortSignal): boolean {
  return signal.aborted || store.getTask(taskId) === undefined;
}

function markFailed(store: Store, taskId: string, lastError: string): void {
  if (!store.getTask(taskId)) {
    return;
  }
  store.updateTask(taskId, { status: 'failed', lastError, currentStep: 'done' });
}

function setStep(
  store: Store,
  taskId: string,
  id: StepId,
  status: StepStatus,
): void {
  const task = store.getTask(taskId);
  if (!task) {
    return;
  }
  const steps: StepState[] = (task.steps ?? defaultSteps(Boolean(task.reviewerProvider))).map(
    (step) => (step.id === id ? { ...step, status } : step),
  );
  store.updateTask(taskId, { steps });
}

function defaultSteps(hasReviewer: boolean): StepState[] {
  return [
    { id: 'writer', status: 'pending' },
    { id: 'tests', status: 'pending' },
    { id: 'review', status: hasReviewer ? 'pending' : 'skipped' },
    { id: 'git', status: 'pending' },
  ];
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
