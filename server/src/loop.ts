import {
  parsePlanObject,
  parseReviewVerdict,
  planObjectPrompt,
  planPrompt,
  projectWriterPrompt,
  reviewPrompt,
  reviewRetryPrompt,
  retryPrompt,
  writerPromptWithPlan,
  type CLIAdapter,
  type GitRuntime,
  type ProviderType,
  type RunResult,
  type StepId,
  type StepState,
  type StepStatus,
  type TaskState,
  type TimelineEvent,
  type WorkspaceContext,
} from '../../protocol/index.ts';
import { extractUsefulCliText, isCliNoise } from './cli-log.ts';
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

  const record = (
    event: string,
    extra?: { attempt?: number; step?: string; detail?: string },
  ) => {
    safeRecord(ledger, taskId, event, extra);
  };

  try {
    await executeLoop({
      store,
      git,
      adapters,
      ledger,
      taskId,
      signal,
    });
  } catch (err) {
    const message = errorMessage(err);
    appendLine(store, taskId, `[loop] crashed: ${message}`);
    markFailed(store, taskId, message);
    record('loop_crashed', { detail: message });
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
  const ctx = jobContext(initial);
  const oracleLabel = (ctx?.oraclePaths ?? ['parse.test.js']).join(', ');

  const record = (
    event: string,
    extra?: { attempt?: number; step?: string; detail?: string },
  ) => {
    safeRecord(ledger, taskId, event, extra);
  };

  if (isGone(store, taskId, signal)) {
    markFailed(store, taskId, 'cancelled');
    record('cancelled');
    return;
  }

  let workspaceDir = '';
  try {
    const workspace = await git.createWorkspace(taskId, ctx);
    workspaceDir = workspace.dir;
    const oracle = await git.checkOracle(workspaceDir, ctx);
    store.updateTask(taskId, {
      workspaceDir,
      oracleSha: oracle.oracleSha,
      capsRemaining: maxIterations,
    });
    await refreshOutputs(store, git, taskId, workspaceDir, ctx);
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
      `[loop] attempt ${attempt}/${maxIterations}`,
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
          initial.projectId
            ? planObjectPrompt(title, prompt)
            : planPrompt(title, prompt),
          (text) => appendChunk(store, taskId, '[plan] ', text),
          signal,
          'plan',
        );
        planText = extractUsefulCliText(planResult.output);
        assertCleanCliResult(planResult, 'plan');
        const parsedPlan = parsePlanObject(planResult.output);
        if (parsedPlan && initial.projectId) {
          store.applyPlanObject(parsedPlan, taskId);
          if (parsedPlan.reply) {
            store.addMessage('orchestrator', parsedPlan.reply);
          }
        }
        pushTimeline(store, taskId, {
          role: 'plan',
          title: `${orchestratorProvider} planned the work`,
          body: planText,
        });
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
    if (initial.projectId) {
      const project = store.getProject();
      if (project && project.id === initial.projectId) {
        const thread = project.messages
          .map((message) => `${message.role}: ${message.text}`)
          .join('\n\n');
        writerPrompt = projectWriterPrompt({
          goal: project.goal,
          itemPrompt: writerPrompt,
          oraclePaths: project.oraclePaths,
          thread,
        });
      }
    }

    try {
      const writerResult = await adapters[provider].run(
        workspaceDir,
        writerPrompt,
        (text) => appendChunk(store, taskId, '[writer] ', text),
        signal,
        'writer',
      );
      assertCleanCliResult(writerResult, 'writer');
      setStep(store, taskId, 'writer', 'ok');
      await refreshOutputs(store, git, taskId, workspaceDir, ctx);
      pushTimeline(store, taskId, {
        role: 'writer',
        title:
          attempt === 1
            ? `${provider} wrote code`
            : `${provider} revised the code`,
        body: extractUsefulCliText(writerResult.output),
      });
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

    const jobKind = initial.jobKind ?? 'code';

    if (jobKind === 'tests') {
      let testFiles: string[] = [];
      try {
        testFiles = await git.listTestFiles(workspaceDir);
      } catch (err) {
        markFailed(store, taskId, errorMessage(err));
        return;
      }
      if (testFiles.length === 0) {
        lastTestOutput = 'test author wrote no test files';
        appendLine(store, taskId, '[loop] no test files yet');
        setStep(store, taskId, 'tests', 'fail');
        pushTimeline(store, taskId, {
          role: 'tests',
          title: 'No tests written yet',
          body: 'The test author must add automated tests before implementation starts.',
        });
        record('tests_missing', { attempt, step: 'tests' });
        continue;
      }
      setStep(store, taskId, 'tests', 'ok');
      pushTimeline(store, taskId, {
        role: 'tests',
        title: 'Tests authored',
        body: testFiles.join(', '),
      });
      setStep(store, taskId, 'review', 'skipped');
      setStep(store, taskId, 'git', 'running');
      store.updateTask(taskId, { currentStep: 'git' });
      try {
        const commit = await git.commitIfDirty(
          workspaceDir,
          `LoopSync tests: ${title}`,
          ctx,
        );
        if (initial.projectId) {
          store.updateProject({ oraclePaths: testFiles });
        }
        await refreshOutputs(store, git, taskId, workspaceDir, {
          ...ctx,
          oraclePaths: testFiles,
        });
        store.updateTask(taskId, {
          status: 'succeeded',
          currentStep: 'done',
          commitSha: commit?.sha,
          diff: commit?.diff,
          oraclePaths: testFiles,
          capsRemaining: capsRemaining - 1,
        });
        store.markPlanItemForTask(taskId, 'succeeded');
        record('succeeded', { attempt, step: 'git', detail: testFiles.join(',') });
        return;
      } catch (err) {
        const message = errorMessage(err);
        setStep(store, taskId, 'git', 'fail');
        markFailed(store, taskId, message);
        return;
      }
    }

    if (initial.skipTests && initial.skipCommit) {
      setStep(store, taskId, 'tests', 'skipped');
      setStep(store, taskId, 'review', 'skipped');
      setStep(store, taskId, 'git', 'skipped');
      await refreshOutputs(store, git, taskId, workspaceDir, ctx);
      store.updateTask(taskId, {
        status: 'succeeded',
        currentStep: 'done',
        capsRemaining: capsRemaining - 1,
      });
      store.markPlanItemForTask(taskId, 'succeeded');
      record('succeeded', { attempt, step: 'writer', detail: 'shard' });
      return;
    }

    store.updateTask(taskId, { currentStep: 'oracle' });
    let oracle;
    try {
      oracle = await git.checkOracle(workspaceDir, ctx);
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
        `[loop] ORACLE_TAMPERED ${oracleLabel} changed; refusing commit`,
      );
      setStep(store, taskId, 'tests', 'fail');
      setStep(store, taskId, 'git', 'fail');
      markFailed(store, taskId, 'ORACLE_TAMPERED');
      record('oracle_tampered', { attempt, step: 'oracle' });
      return;
    }

    setStep(store, taskId, 'tests', 'running');
    store.updateTask(taskId, { currentStep: 'tests' });

    let tests;
    try {
      tests = await git.runTests(workspaceDir, ctx);
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
      pushTimeline(store, taskId, {
        role: 'tests',
        title: 'Tests failed',
        body: extractUsefulCliText(tests.output, 800),
      });
      await refreshOutputs(store, git, taskId, workspaceDir, ctx);
      record('tests_fail', { attempt, step: 'tests' });
      continue;
    }

    appendLine(store, taskId, `[tests] pass exit=${tests.exitCode}`);
    setStep(store, taskId, 'tests', 'ok');
    pushTimeline(store, taskId, {
      role: 'tests',
      title: 'Tests passed',
      body: 'The oracle accepted the change.',
    });
    record('tests_pass', { attempt, step: 'tests' });

    if (reviewerProvider) {
      if (isGone(store, taskId, signal)) {
        markFailed(store, taskId, 'cancelled');
        return;
      }
      setStep(store, taskId, 'review', 'running');
      store.updateTask(taskId, { currentStep: 'review' });
      let reviewOutput = '';
      try {
        const diff = await git.getDiff(workspaceDir);
        const result = await adapters[reviewerProvider].run(
          workspaceDir,
          reviewPrompt(diff, prompt),
          (text) => appendChunk(store, taskId, '[review] ', text),
          signal,
          'review',
        );
        reviewOutput = result.output;
        assertCleanCliResult(result, 'review');
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
        lastReviewOutput = extractUsefulCliText(reviewOutput);
        appendLine(store, taskId, '[review] REVIEW_REJECT');
        setStep(store, taskId, 'review', 'fail');
        setStep(store, taskId, 'git', 'pending');
        store.updateTask(taskId, { lastError: lastReviewOutput || 'REVIEW_REJECT' });
        pushTimeline(store, taskId, {
          role: 'review',
          title: `${reviewerProvider} requested changes`,
          body: lastReviewOutput,
        });
        record('review_reject', { attempt, step: 'review' });
        continue;
      }
      appendLine(store, taskId, '[review] REVIEW_OK');
      setStep(store, taskId, 'review', 'ok');
      pushTimeline(store, taskId, {
        role: 'review',
        title: `${reviewerProvider} approved`,
        body: extractUsefulCliText(reviewOutput, 400) || 'REVIEW_OK',
      });
      record('review_ok', { attempt, step: 'review' });
    } else {
      setStep(store, taskId, 'review', 'skipped');
    }

    if (reviewerProvider) {
      store.updateTask(taskId, { currentStep: 'oracle' });
      let postReviewOracle;
      try {
        postReviewOracle = await git.checkOracle(workspaceDir, ctx);
      } catch (err) {
        const message = errorMessage(err);
        markFailed(store, taskId, message);
        return;
      }
      store.updateTask(taskId, { oracleSha: postReviewOracle.oracleSha });
      if (postReviewOracle.dirty) {
        appendLine(
          store,
          taskId,
          `[loop] ORACLE_TAMPERED after review: ${oracleLabel} changed; refusing commit`,
        );
        setStep(store, taskId, 'tests', 'fail');
        setStep(store, taskId, 'git', 'fail');
        markFailed(store, taskId, 'ORACLE_TAMPERED');
        record('oracle_tampered_after_review', { attempt, step: 'oracle' });
        return;
      }

      setStep(store, taskId, 'tests', 'running');
      store.updateTask(taskId, { currentStep: 'tests' });
      let postReviewTests;
      try {
        postReviewTests = await git.runTests(workspaceDir, ctx);
      } catch (err) {
        const message = errorMessage(err);
        appendLine(store, taskId, `[tests] post-review error: ${message}`);
        setStep(store, taskId, 'tests', 'fail');
        markFailed(store, taskId, message);
        return;
      }
      if (!postReviewTests.passed) {
        lastTestOutput = postReviewTests.output;
        lastReviewOutput = '';
        appendLine(
          store,
          taskId,
          `[tests] post-review fail exit=${postReviewTests.exitCode}`,
        );
        setStep(store, taskId, 'tests', 'fail');
        store.updateTask(taskId, { lastError: postReviewTests.output });
        pushTimeline(store, taskId, {
          role: 'tests',
          title: 'Tests failed after review',
          body: extractUsefulCliText(postReviewTests.output, 800),
        });
        await refreshOutputs(store, git, taskId, workspaceDir, ctx);
        record('post_review_tests_fail', { attempt, step: 'tests' });
        continue;
      }
      appendLine(
        store,
        taskId,
        `[tests] post-review pass exit=${postReviewTests.exitCode}`,
      );
      setStep(store, taskId, 'tests', 'ok');
      record('post_review_tests_pass', { attempt, step: 'tests' });
    }

    if (isGone(store, taskId, signal)) {
      markFailed(store, taskId, 'cancelled');
      return;
    }

    setStep(store, taskId, 'git', 'running');
    store.updateTask(taskId, { currentStep: 'git' });
    try {
      const commit = await git.commitIfDirty(
        workspaceDir,
        `LoopSync: ${title}`,
        ctx,
      );
      if (!commit) {
        appendLine(
          store,
          taskId,
          '[git] working tree clean after passing tests',
        );
        setStep(store, taskId, 'git', 'ok');
        await refreshOutputs(store, git, taskId, workspaceDir, ctx);
        store.updateTask(taskId, {
          status: 'succeeded',
          currentStep: 'done',
          capsRemaining: capsRemaining - 1,
        });
        store.markPlanItemForTask(taskId, 'succeeded');
        record('succeeded', { attempt, step: 'git', detail: 'clean' });
        return;
      }
      appendLine(store, taskId, `[git] committed ${commit.sha.slice(0, 7)}`);
      setStep(store, taskId, 'git', 'ok');
      await refreshOutputs(store, git, taskId, workspaceDir, ctx);
      const files = store.getTask(taskId)?.outputFiles ?? [];
      pushTimeline(store, taskId, {
        role: 'git',
        title: 'Saved a snapshot',
        body:
          files.length > 0
            ? files.map((file) => file.path).join(', ')
            : commit.sha.slice(0, 7),
      });
      store.updateTask(taskId, {
        status: 'succeeded',
        currentStep: 'done',
        commitSha: commit.sha,
        diff: commit.diff,
        capsRemaining: capsRemaining - 1,
      });
      store.markPlanItemForTask(taskId, 'succeeded');
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
  store.markPlanItemForTask(taskId, 'failed');
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
    .filter((line) => line.length > 0 && !isCliNoise(line))
    .map((line) => `${prefix}${line}`);
  appendLines(store, taskId, lines);
}

function jobContext(task: TaskState): WorkspaceContext | undefined {
  if (
    !task.sourceDir &&
    !task.persistDir &&
    !task.oraclePaths &&
    !task.testCommand
  ) {
    return undefined;
  }
  return {
    sourceDir: task.sourceDir,
    oraclePaths: task.oraclePaths,
    testCommand: task.testCommand,
    persistDir: task.persistDir,
    empty: task.empty,
    mode: task.jobKind,
  };
}

async function refreshOutputs(
  store: Store,
  git: GitRuntime,
  taskId: string,
  workspaceDir: string,
  ctx?: WorkspaceContext,
): Promise<void> {
  try {
    const outputFiles = await git.listOutputs(workspaceDir, ctx);
    store.updateTask(taskId, { outputFiles });
  } catch {
    // keep last known files
  }
}

function pushTimeline(
  store: Store,
  taskId: string,
  event: Omit<TimelineEvent, 'id'>,
): void {
  const task = store.getTask(taskId);
  if (!task) {
    return;
  }
  const next: TimelineEvent = {
    id: `${event.role}_${(task.timeline?.length ?? 0) + 1}`,
    role: event.role,
    title: event.title,
    body: event.body,
  };
  store.updateTask(taskId, { timeline: [...(task.timeline ?? []), next] });
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

function assertCleanCliResult(result: RunResult, step: string): void {
  if (result.aborted) {
    throw new Error(`${step} aborted`);
  }
  if (result.timedOut) {
    throw new Error(`${step} timed out`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`${step} exited ${result.exitCode}`);
  }
}

function safeRecord(
  ledger: Ledger | undefined,
  taskId: string,
  event: string,
  extra?: { attempt?: number; step?: string; detail?: string },
): void {
  try {
    ledger?.append({ taskId, event, ...extra });
  } catch {
    // Ledger durability should never decide task correctness.
  }
}
