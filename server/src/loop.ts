import {
  CLI_TIMEOUT_MS,
  monotonicNow,
  parsePlanObject,
  parseReviewVerdict,
  planObjectPrompt,
  planPrompt,
  projectWriterPrompt,
  reviewPrompt,
  reviewRetryPrompt,
  retryPrompt,
  steeringAddendum,
  writerPromptWithPlan,
  type AgentEvent,
  type AgentRole,
  type CLIAdapter,
  type GitRuntime,
  PROVIDER_LABEL,
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
  const ctx = jobContext(initial);
  const oracleLabel = (ctx?.oraclePaths ?? ['parse.test.js']).join(', ');

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
    const workspace = await git.createWorkspace(taskId, ctx);
    workspaceDir = workspace.dir;
    const oracle = await git.checkOracle(workspaceDir, ctx);
    store.updateTask(taskId, {
      workspaceDir,
      oracleSha: oracle.oracleSha,
      capsRemaining: maxIterations,
      startedAt: initial.startedAt ?? monotonicNow(),
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
        const planResult = await runAgent({
          store,
          adapters,
          taskId,
          provider: orchestratorProvider,
          role: 'plan',
          workspaceDir,
          prompt: initial.projectId
            ? planObjectPrompt(title, prompt)
            : planPrompt(title, prompt),
          signal,
        });
        planText = extractUsefulCliText(planResult.output);
        const parsedPlan = parsePlanObject(planResult.output);
        if (parsedPlan && initial.projectId) {
          store.applyPlanObject(parsedPlan, taskId);
          if (parsedPlan.reply) {
            store.addMessage('orchestrator', parsedPlan.reply);
          }
        }
        pushTimeline(store, taskId, {
          role: 'plan',
          title: `${PROVIDER_LABEL[orchestratorProvider]} planned the work`,
          body: planText,
          provider: orchestratorProvider,
          attempt,
          durationMs: planResult.usage?.durationMs,
          timedOut: planResult.timedOut,
          tone: planResult.timedOut ? 'fail' : 'info',
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
        // §3 — steering queued mid-run is applied here, at the loop boundary.
        const steering = store.takeSteering();
        if (steering.length > 0) {
          writerPrompt = `${writerPrompt}${steeringAddendum(steering)}`;
          appendLine(
            store,
            taskId,
            `[loop] applied ${steering.length} steering message(s)`,
          );
          pushTimeline(store, taskId, {
            role: 'loop',
            title: 'Applied your steering',
            body: steering.join('\n'),
            tone: 'info',
            attempt,
          });
          record('steering_applied', { attempt, detail: String(steering.length) });
        }
        const thread = project.messages
          .filter((message) => !message.cancelled)
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
      const writerResult = await runAgent({
        store,
        adapters,
        taskId,
        provider,
        role: 'writer',
        workspaceDir,
        prompt: writerPrompt,
        signal,
      });
      setStep(store, taskId, 'writer', writerResult.timedOut ? 'fail' : 'ok');
      if (writerResult.timedOut) {
        store.updateTask(taskId, { timedOut: true });
      }
      await refreshOutputs(store, git, taskId, workspaceDir, ctx);
      const note = timeoutNote(writerResult);
      const wroteTests = initial.jobKind === 'tests';
      pushTimeline(store, taskId, {
        role: 'writer',
        title: note
          ? `${PROVIDER_LABEL[provider]} ${note}`
          : attempt === 1
            ? wroteTests
              ? `${PROVIDER_LABEL[provider]} authored the tests`
              : `${PROVIDER_LABEL[provider]} wrote code`
            : `${PROVIDER_LABEL[provider]} revised the code`,
        body: extractUsefulCliText(writerResult.output),
        provider,
        attempt,
        durationMs: writerResult.usage?.durationMs,
        timedOut: writerResult.timedOut,
        tone: writerResult.timedOut ? 'fail' : 'info',
      });
      record('writer', {
        attempt,
        step: 'writer',
        detail: writerResult.timedOut ? 'timeout' : undefined,
      });
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
        provider,
        attempt,
        tone: 'ok',
      });
      setStep(store, taskId, 'review', 'skipped');
      setStep(store, taskId, 'git', 'running');
      store.updateTask(taskId, { currentStep: 'git' });
      try {
        const commit = await git.commitIfDirty(
          workspaceDir,
          `Choreo tests: ${title}`,
          ctx,
        );
        const parallelShard = Boolean(store.getProject()?.shards);
        if (initial.projectId && !parallelShard) {
          // §4 — the freeze is a beat in the thread, not a silent field change.
          store.updateProject({ oraclePaths: testFiles, frozenAt: monotonicNow() });
        }
        await refreshOutputs(store, git, taskId, workspaceDir, {
          ...ctx,
          oraclePaths: testFiles,
        });
        setStep(store, taskId, 'git', 'ok');
        pushTimeline(store, taskId, {
          role: 'git',
          title: parallelShard
            ? 'Test branch ready'
            : commit
              ? `Froze the tests at ${commit.sha.slice(0, 7)}`
              : 'Froze the tests',
          body: parallelShard
            ? `${testFiles.join(', ')} are ready and waiting for the implementation branch.`
            : `${testFiles.join(', ')} are now the oracle. Coding agents never run git commit.`,
          attempt,
          tone: 'ok',
        });
        store.updateTask(taskId, {
          status: 'succeeded',
          currentStep: 'done',
          commitSha: commit?.sha,
          diff: commit?.diff,
          oraclePaths: testFiles,
          capsRemaining: capsRemaining - 1,
          endedAt: monotonicNow(),
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
        endedAt: monotonicNow(),
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
        title:
          attempt < maxIterations
            ? `Tests failed — retrying (attempt ${attempt + 1} of ${maxIterations})`
            : 'Tests failed',
        body: extractUsefulCliText(tests.output, 800),
        attempt,
        tone: 'fail',
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
      body: `${(ctx?.testCommand ?? ['node', '--test']).join(' ')} is the only SHA veto. It went green.`,
      attempt,
      tone: 'ok',
      durationMs: stepDuration(store, taskId, 'tests'),
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
      let reviewTimedOut = false;
      try {
        const diff = await git.getDiff(workspaceDir);
        const result = await runAgent({
          store,
          adapters,
          taskId,
          provider: reviewerProvider,
          role: 'review',
          workspaceDir,
          prompt: reviewPrompt(diff, prompt),
          signal,
        });
        reviewOutput = result.output;
        reviewTimedOut = result.timedOut === true;
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
          title: reviewTimedOut
            ? `${PROVIDER_LABEL[reviewerProvider]} timed out — treated as a rejection`
            : `${PROVIDER_LABEL[reviewerProvider]} requested changes`,
          body: lastReviewOutput,
          provider: reviewerProvider,
          verdict: 'reject',
          attempt,
          tone: 'fail',
          timedOut: reviewTimedOut,
          durationMs: stepDuration(store, taskId, 'review'),
        });
        record('review_reject', { attempt, step: 'review' });
        continue;
      }
      appendLine(store, taskId, '[review] REVIEW_OK');
      setStep(store, taskId, 'review', 'ok');
      pushTimeline(store, taskId, {
        role: 'review',
        title: `${PROVIDER_LABEL[reviewerProvider]} approved — and did not write this code`,
        body: extractUsefulCliText(reviewOutput, 400) || 'REVIEW_OK',
        provider: reviewerProvider,
        verdict: 'ok',
        attempt,
        tone: 'ok',
        durationMs: stepDuration(store, taskId, 'review'),
      });
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
      const commit = await git.commitIfDirty(
        workspaceDir,
        `Choreo: ${title}`,
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
          endedAt: monotonicNow(),
        });
        store.markPlanItemForTask(taskId, 'succeeded');
        record('succeeded', { attempt, step: 'git', detail: 'clean' });
        return;
      }
      appendLine(store, taskId, `[git] committed ${commit.sha.slice(0, 7)}`);
      setStep(store, taskId, 'git', 'ok');
      await refreshOutputs(store, git, taskId, workspaceDir, ctx);
      store.updateTask(taskId, {
        status: 'succeeded',
        currentStep: 'done',
        commitSha: commit.sha,
        diff: commit.diff,
        capsRemaining: capsRemaining - 1,
        endedAt: monotonicNow(),
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

/**
 * One place where a CLI is invoked: logs still tail, but structured events
 * (P0.1) are stamped with the role that asked for them and stored on the task.
 */
async function runAgent(opts: {
  store: Store;
  adapters: Record<ProviderType, CLIAdapter>;
  taskId: string;
  provider: ProviderType;
  role: AgentRole;
  workspaceDir: string;
  prompt: string;
  signal: AbortSignal;
}): Promise<RunResult> {
  const { store, adapters, taskId, provider, role, workspaceDir, prompt, signal } =
    opts;
  const prefix = `[${role}] `;
  const result = await adapters[provider].run(
    workspaceDir,
    prompt,
    (text) => appendChunk(store, taskId, prefix, text),
    signal,
    (event: AgentEvent) => {
      store.appendTaskEvents(taskId, [{ ...event, role, provider }]);
    },
  );
  if (result.usage) {
    mergeUsage(store, taskId, result.usage);
  }
  return result;
}

function mergeUsage(
  store: Store,
  taskId: string,
  usage: NonNullable<RunResult['usage']>,
): void {
  const task = store.getTask(taskId);
  if (!task) {
    return;
  }
  const current = task.usage ?? {};
  store.updateTask(taskId, {
    usage: {
      durationMs: (current.durationMs ?? 0) + (usage.durationMs ?? 0),
      costUsd: (current.costUsd ?? 0) + (usage.costUsd ?? 0),
      numTurns: (current.numTurns ?? 0) + (usage.numTurns ?? 0),
    },
  });
}

/** P1.10 — a CLI killed by the timeout must not read as a clean success. */
function timeoutNote(result: RunResult): string {
  return result.timedOut
    ? `timed out after ${Math.round(CLI_TIMEOUT_MS / 1000)}s`
    : '';
}

function isGone(store: Store, taskId: string, signal: AbortSignal): boolean {
  return signal.aborted || store.getTask(taskId) === undefined;
}

function markFailed(store: Store, taskId: string, lastError: string): void {
  if (!store.getTask(taskId)) {
    return;
  }
  store.updateTask(taskId, {
    status: 'failed',
    lastError,
    currentStep: 'done',
    endedAt: monotonicNow(),
  });
  store.markPlanItemForTask(taskId, 'failed');
}

function stepDuration(
  store: Store,
  taskId: string,
  id: StepId,
): number | undefined {
  const step = store.getTask(taskId)?.steps?.find((entry) => entry.id === id);
  if (!step?.startedAt) {
    return undefined;
  }
  return (step.endedAt ?? Date.now()) - step.startedAt;
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
  const now = Date.now();
  const steps: StepState[] = (
    task.steps ?? defaultSteps(Boolean(task.reviewerProvider))
  ).map((step) => {
    if (step.id !== id) {
      return step;
    }
    if (status === 'running') {
      return { ...step, status, startedAt: now, endedAt: undefined, durationMs: undefined };
    }
    if (status === 'ok' || status === 'fail') {
      const startedAt = step.startedAt ?? now;
      return {
        ...step,
        status,
        startedAt,
        endedAt: now,
        durationMs: now - startedAt,
      };
    }
    return { ...step, status };
  });
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
    ...event,
    id: `${event.role}_${(task.timeline?.length ?? 0) + 1}`,
    ts: event.ts ?? monotonicNow(),
    attempt: event.attempt ?? task.currentIteration,
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
