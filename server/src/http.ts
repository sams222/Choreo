import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_TEST_COMMAND,
  POLL_MS,
  REPLAY_LOG,
  defaultBuildPlan,
  monotonicNow,
  ensureTestsItem,
  inferJobKind,
  parsePlanObject,
  planObjectPrompt,
  pythonTestCommand,
  steerPrompt,
  workspaceRoot,
  type AgentEvent,
  type CLIAdapter,
  type CreateProjectBody,
  type ErrorCode,
  type GitRuntime,
  type JobKind,
  type LaunchTaskBody,
  type PlanItem,
  type PlanObject,
  type PlannerPhase,
  type ProjectState,
  type ProviderType,
  type ServerSnapshot,
  type ThreadItem,
} from '../../protocol/index.ts';
import { runLoop } from './loop.ts';
import { buildThread } from './thread.ts';
import type { Ledger } from './ledger.ts';
import type { Store } from './state.ts';

const WEB_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../web',
);

export function inferProjectTestCommand(
  goal: string,
  paths: readonly string[] = [],
): string[] {
  const usesPython =
    paths.some((file) => /\.py$/i.test(file)) ||
    /\b(python|pytest|unittest)\b/i.test(goal);
  return usesPython
    ? pythonTestCommand(paths.filter((file) => /\.py$/i.test(file)))
    : [...DEFAULT_TEST_COMMAND];
}

function isProvider(value: unknown): value is ProviderType {
  return value === 'claude' || value === 'codex';
}

function sendError(
  res: Response,
  status: number,
  code: ErrorCode,
  message: string,
): void {
  res.status(status).json({ error: { code, message } });
}

function readOptionalProvider(
  record: Record<string, unknown>,
  key: string,
): ProviderType | undefined | { error: string } {
  const value = record[key];
  if (value === undefined || value === '') {
    return undefined;
  }
  if (!isProvider(value)) {
    return { error: `${key} must be claude or codex` };
  }
  return value;
}

function readMaxIterations(
  record: Record<string, unknown>,
): number | undefined | { error: string } {
  if (record.maxIterations === undefined) {
    return undefined;
  }
  if (
    typeof record.maxIterations !== 'number' ||
    !Number.isInteger(record.maxIterations) ||
    record.maxIterations < 1
  ) {
    return { error: 'maxIterations must be a positive integer' };
  }
  return record.maxIterations;
}

function readStringArray(
  value: unknown,
  label: string,
): string[] | undefined | { error: string } {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.trim() === '')
  ) {
    return { error: `${label} must be an array of strings` };
  }
  return value.map((item) => item.trim());
}

function readLaunchBody(req: Request): LaunchTaskBody | { error: string } {
  const body = req.body as unknown;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'request body must be a JSON object' };
  }
  const record = body as Record<string, unknown>;
  if (!isProvider(record.provider)) {
    return { error: 'provider' };
  }
  if (typeof record.title !== 'string' || record.title.trim() === '') {
    return { error: 'title is required' };
  }
  if (typeof record.prompt !== 'string' || record.prompt.trim() === '') {
    return { error: 'prompt is required' };
  }
  const launch: LaunchTaskBody = {
    title: record.title,
    prompt: record.prompt,
    provider: record.provider,
  };
  const reviewer = readOptionalProvider(record, 'reviewerProvider');
  if (reviewer && typeof reviewer === 'object' && 'error' in reviewer) {
    return reviewer;
  }
  if (reviewer) {
    launch.reviewerProvider = reviewer;
  }
  const orchestrator = readOptionalProvider(record, 'orchestratorProvider');
  if (orchestrator && typeof orchestrator === 'object' && 'error' in orchestrator) {
    return orchestrator;
  }
  if (orchestrator) {
    launch.orchestratorProvider = orchestrator;
  }
  const maxIterations = readMaxIterations(record);
  if (maxIterations && typeof maxIterations === 'object' && 'error' in maxIterations) {
    return maxIterations;
  }
  if (maxIterations) {
    launch.maxIterations = maxIterations;
  }
  if (typeof record.projectId === 'string' && record.projectId.trim() !== '') {
    launch.projectId = record.projectId.trim();
  }
  return launch;
}

function readCreateProjectBody(
  req: Request,
): CreateProjectBody | { error: string } {
  const body = req.body as unknown;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'request body must be a JSON object' };
  }
  const record = body as Record<string, unknown>;
  if (typeof record.goal !== 'string' || record.goal.trim() === '') {
    return { error: 'goal is required' };
  }
  if (!isProvider(record.writerProvider)) {
    return { error: 'writerProvider must be claude or codex' };
  }
  const title =
    typeof record.title === 'string' && record.title.trim() !== ''
      ? record.title.trim()
      : 'Untitled';
  const project: CreateProjectBody = {
    title,
    goal: record.goal.trim(),
    writerProvider: record.writerProvider,
  };
  if (typeof record.sourceDir === 'string' && record.sourceDir.trim() !== '') {
    project.sourceDir = record.sourceDir.trim();
  }
  const planner = readOptionalProvider(record, 'plannerProvider');
  if (planner && typeof planner === 'object' && 'error' in planner) {
    return planner;
  }
  if (planner) {
    project.plannerProvider = planner;
  }
  const reviewer = readOptionalProvider(record, 'reviewerProvider');
  if (reviewer && typeof reviewer === 'object' && 'error' in reviewer) {
    return reviewer;
  }
  if (reviewer) {
    project.reviewerProvider = reviewer;
  }
  const maxIterations = readMaxIterations(record);
  if (maxIterations && typeof maxIterations === 'object' && 'error' in maxIterations) {
    return maxIterations;
  }
  if (maxIterations) {
    project.maxIterations = maxIterations;
  }
  const testCommand = readStringArray(record.testCommand, 'testCommand');
  if (testCommand && typeof testCommand === 'object' && 'error' in testCommand) {
    return testCommand;
  }
  if (testCommand) {
    project.testCommand = testCommand;
  }
  const oraclePaths = readStringArray(record.oraclePaths, 'oraclePaths');
  if (oraclePaths && typeof oraclePaths === 'object' && 'error' in oraclePaths) {
    return oraclePaths;
  }
  if (oraclePaths) {
    project.oraclePaths = oraclePaths;
  }
  return project;
}

function involvedFromLaunch(body: LaunchTaskBody): Set<ProviderType> {
  const involved = new Set<ProviderType>([body.provider]);
  if (body.reviewerProvider) {
    involved.add(body.reviewerProvider);
  }
  if (body.orchestratorProvider) {
    involved.add(body.orchestratorProvider);
  }
  return involved;
}

function involvedFromProject(
  project: Pick<
    ProjectState,
    'writerProvider' | 'reviewerProvider' | 'plannerProvider'
  >,
  includePlanner: boolean,
): Set<ProviderType> {
  const involved = new Set<ProviderType>([project.writerProvider]);
  if (project.reviewerProvider) {
    involved.add(project.reviewerProvider);
  }
  if (includePlanner && project.plannerProvider) {
    involved.add(project.plannerProvider);
  }
  return involved;
}

function detectOraclePaths(sourceDir: string): string[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(sourceDir);
  } catch {
    return [];
  }
  return names
    .filter(
      (name) =>
        /\.(test|spec)\.(js|mjs|cjs|ts)$/i.test(name) ||
        /(_test|\.test)\.py$/i.test(name),
    )
    .sort();
}

function resolveSourceDir(
  input: string,
  baseDir: string,
): string | { error: string } {
  const resolved = path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(baseDir, input);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { error: `sourceDir is not a directory: ${resolved}` };
  }
  return resolved;
}

const APPLY_SKIP_NAMES = new Set([
  '.git',
  '.choreo',
  'node_modules',
  'dist',
  'coverage',
]);

/**
 * Copy a completed isolated workspace into the user's chosen project folder.
 * This is intentionally additive: generated/changed files are written, while
 * files deleted by an agent are not deleted from the user's working tree.
 */
export function applyWorkspace(workspaceDir: string, targetDir: string): string[] {
  const source = path.resolve(workspaceDir);
  const target = path.resolve(targetDir);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    throw new Error(`workspace is not a directory: ${source}`);
  }
  if (source === target || target.startsWith(`${source}${path.sep}`)) {
    throw new Error('apply target must be outside the isolated workspace');
  }
  fs.mkdirSync(target, { recursive: true });
  const applied: string[] = [];

  const copyDir = (current: string, relDir: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (APPLY_SKIP_NAMES.has(entry.name)) continue;
      const rel = relDir ? path.join(relDir, entry.name) : entry.name;
      const from = path.join(current, entry.name);
      const to = path.join(target, rel);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        copyDir(from, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (
        fs.existsSync(to) &&
        fs.statSync(to).isFile() &&
        fs.readFileSync(from).equals(fs.readFileSync(to))
      ) {
        continue;
      }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      fs.chmodSync(to, fs.statSync(from).mode);
      applied.push(rel.split(path.sep).join('/'));
    }
  };

  copyDir(source, '');
  return applied.sort();
}

export function isProjectReady(
  project: ProjectState,
  tasks: ServerSnapshot['tasks'],
): boolean {
  const plannerActive =
    project.planner?.phase === 'planning' ||
    project.planner?.phase === 'steering';
  const taskActive = tasks.some(
    (task) =>
      task.projectId === project.id &&
      (task.status === 'queued' ||
        task.status === 'running' ||
        task.status === 'retrying'),
  );
  return Boolean(
    project.plan.length > 0 &&
      project.plan.every((item) => item.status === 'succeeded') &&
      !project.shards &&
      !plannerActive &&
      !taskActive,
  );
}

export function dashboardDefaults(
  overrides?: Partial<{
    sourceDir: string;
    title: string;
    goal: string;
    testCommand: string[];
    oraclePaths: string[];
  }>,
) {
  return {
    sourceDir: overrides?.sourceDir ?? '',
    title: overrides?.title ?? '',
    goal: overrides?.goal ?? '',
    testCommand: overrides?.testCommand
      ? [...overrides.testCommand]
      : [...DEFAULT_TEST_COMMAND],
    oraclePaths: overrides?.oraclePaths ? [...overrides.oraclePaths] : [],
  };
}

export function createHttpApp(deps: {
  store: Store;
  git: GitRuntime;
  adapters: Record<ProviderType, CLIAdapter>;
  ledger?: Ledger;
  /** Installed package root (fixture, web). Kept for callers; web is served from this file. */
  repoRoot?: string;
  /** Folder the CLI was launched in — relative sourceDir and replay logs resolve here. */
  projectDir?: string;
}): Express {
  const { store, git, adapters, ledger } = deps;
  const projectDir = deps.projectDir ?? deps.repoRoot ?? process.cwd();
  const controllers = new Map<string, AbortController>();
  const app = express();
  const replayPath = path.resolve(projectDir, REPLAY_LOG);
  const replayed = new Set<string>();

  /** §3 — the client renders this; it never rebuilds thread order itself. */
  function snapshot(): ServerSnapshot {
    const base = store.getSnapshot();
    const thread = buildThread(base);
    recordReplay(base, thread);
    return { ...base, thread };
  }

  /**
   * P2 — every thread item is appended once to a JSONL log, so a past run can
   * be replayed at speed when the live CLIs (or the wifi) misbehave on stage.
   */
  function recordReplay(base: ServerSnapshot, thread: ThreadItem[]): void {
    const projectId = base.project?.id;
    if (!projectId) {
      return;
    }
    const rows: string[] = [];
    for (const item of thread) {
      if (item.kind === 'live' || item.kind === 'race' || item.kind === 'merge') {
        continue;
      }
      const key = `${projectId}:${item.id}`;
      if (replayed.has(key)) {
        continue;
      }
      replayed.add(key);
      rows.push(JSON.stringify({ projectId, ts: item.ts, item }));
    }
    if (rows.length === 0) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(replayPath), { recursive: true });
      fs.appendFileSync(replayPath, `${rows.join('\n')}\n`);
    } catch {
      // replay insurance is best-effort; never break the live run for it
    }
  }

  function slotsBusy(involved: Set<ProviderType>): ProviderType | undefined {
    const snapshot = store.getSnapshot();
    for (const provider of involved) {
      const slot = snapshot.slots.find((item) => item.provider === provider);
      if (slot?.isBusy) {
        return provider;
      }
    }
    return undefined;
  }

  function occupy(involved: Set<ProviderType>): void {
    for (const provider of involved) {
      store.setBusy(provider, true);
    }
  }

  function markReadyIfComplete(): void {
    const project = store.getProject();
    if (!project || project.readyAt) return;
    if (isProjectReady(project, store.getSnapshot().tasks)) {
      store.updateProject({ readyAt: monotonicNow() });
    }
  }

  function startLoop(taskId: string): void {
    const controller = new AbortController();
    controllers.set(taskId, controller);
    void runLoop({
      store,
      git,
      adapters,
      ledger,
      taskId,
      signal: controller.signal,
    }).finally(() => {
      controllers.delete(taskId);
      queueNextPlanItem();
    });
  }

  function launchBodyForItem(
    project: ProjectState,
    item: PlanItem,
    opts?: {
      persistDir?: string;
      skipTests?: boolean;
      skipCommit?: boolean;
    },
  ): LaunchTaskBody {
    const kind = inferJobKind(item);
    const testAuthor = project.plannerProvider ?? project.writerProvider;
    const provider = kind === 'tests' ? testAuthor : project.writerProvider;
    const empty = !project.sourceDir;
    // A parallel code shard stops before tests, so it never reaches review.
    const reviews = kind === 'code' && !opts?.skipCommit && !opts?.skipTests;
    return {
      title: item.title,
      prompt: item.prompt || project.goal,
      provider,
      maxIterations: project.maxIterations,
      reviewerProvider: reviews ? project.reviewerProvider : undefined,
      projectId: project.id,
      sourceDir: project.sourceDir,
      oraclePaths: [...project.oraclePaths],
      testCommand: [...project.testCommand],
      persistDir: opts?.persistDir ?? project.workspaceDir,
      jobKind: kind,
      skipTests: opts?.skipTests,
      skipCommit: opts?.skipCommit,
      empty,
    };
  }

  function startProjectItem(
    project: ProjectState,
    item: PlanItem,
    opts?: {
      persistDir?: string;
      skipTests?: boolean;
      skipCommit?: boolean;
    },
  ): string | { error: string; code: ErrorCode; status: number } {
    const kind = inferJobKind(item);
    const provider =
      kind === 'tests'
        ? (project.plannerProvider ?? project.writerProvider)
        : project.writerProvider;
    const involved = new Set<ProviderType>([provider]);
    // Only hold the reviewer's slot when this run will actually review. A
    // parallel code shard skips tests and review, and reserving the reviewer
    // there deadlocks the race whenever reviewer === test author.
    const reviews = kind === 'code' && !opts?.skipCommit && !opts?.skipTests;
    if (reviews && project.reviewerProvider) {
      involved.add(project.reviewerProvider);
    }
    const busy = slotsBusy(involved);
    if (busy) {
      return {
        error: `${busy} is already running a task`,
        code: 'SLOT_BUSY',
        status: 409,
      };
    }
    occupy(involved);
    const live = store.getProject() ?? project;
    const task = store.addTask(launchBodyForItem(live, item, opts));
    store.updateTask(task.id, { planItemId: item.id, startedAt: monotonicNow() });
    store.patchPlanItem(item.id, { status: 'running', taskId: task.id, kind });
    store.updateProject({ activeTaskId: task.id });
    startLoop(task.id);
    return task.id;
  }

  function canRunParallel(project: ProjectState): boolean {
    return Boolean(
      project.plannerProvider &&
        project.plannerProvider !== project.writerProvider,
    );
  }

  async function mergeParallelShards(project: ProjectState): Promise<void> {
    const shards = project.shards;
    if (!shards) {
      return;
    }
    occupy(new Set([project.writerProvider]));
    try {
      await git.mergeShards(project.workspaceDir, shards.testsDir, shards.codeDir);
      const testFiles = await git.listTestFiles(project.workspaceDir);
      const usingPythonDiscovery =
        project.testCommand.join('\0') ===
        ['python3', '-m', 'unittest', 'discover'].join('\0');
      const testCommand = usingPythonDiscovery
        ? pythonTestCommand(testFiles)
        : project.testCommand;
      store.updateProject({
        oraclePaths: testFiles,
        testCommand,
        frozenAt: monotonicNow(),
      });
      const ctx = {
        sourceDir: project.sourceDir,
        oraclePaths: testFiles,
        testCommand,
        persistDir: project.workspaceDir,
        empty: !project.sourceDir,
        mode: 'code' as JobKind,
      };
      const tests = await git.runTests(project.workspaceDir, ctx);
      if (!tests.passed) {
        const codeItem = project.plan.find((item) => inferJobKind(item) === 'code');
        if (codeItem) {
          store.patchPlanItem(codeItem.id, { status: 'pending' });
        }
        store.updateProject({ shards: undefined });
        return;
      }
      await git.createWorkspace(`merge_${project.id}`, ctx);
      const commit = await git.commitIfDirty(
        project.workspaceDir,
        `Choreo: ${project.title}`,
        ctx,
      );
      if (commit) {
        const codeItem = (store.getProject() ?? project).plan.find(
          (item) => inferJobKind(item) === 'code',
        );
        if (codeItem?.taskId) {
          store.updateTask(codeItem.taskId, {
            commitSha: commit.sha,
            diff: commit.diff,
            oraclePaths: testFiles,
          });
        }
      }
      store.updateProject({
        shards: undefined,
        readyAt: monotonicNow(),
      });
    } finally {
      store.setBusy(project.writerProvider, false);
    }
  }

  function startEligibleItems(): void {
    const project = store.getProject();
    if (!project) {
      return;
    }
    if (project.plan.some((item) => item.status === 'running')) {
      return;
    }
    const pending = project.plan.filter((item) => item.status === 'pending');
    if (pending.length === 0) {
      return;
    }
    const testsItem = pending.find((item) => inferJobKind(item) === 'tests');
    const codeItem = pending.find((item) => inferJobKind(item) === 'code');
    if (testsItem && codeItem && canRunParallel(project)) {
      const testsDir = `${project.workspaceDir}-tests`;
      const codeDir = `${project.workspaceDir}-code`;
      store.updateProject({ shards: { testsDir, codeDir } });
      startProjectItem(project, testsItem, { persistDir: testsDir });
      startProjectItem(store.getProject() ?? project, codeItem, {
        persistDir: codeDir,
        skipTests: true,
        skipCommit: true,
      });
      return;
    }
    const next = testsItem ?? pending[0];
    startProjectItem(store.getProject() ?? project, next);
  }

  /**
   * P1.6 — the orchestrator runs in the background with its output streamed
   * into the thread, instead of blocking the HTTP response for up to 120s
   * and throwing its tokens away.
   */
  async function runPlanner(opts: {
    projectId: string;
    provider: ProviderType;
    phase: Exclude<PlannerPhase, 'idle' | 'done' | 'failed'>;
    prompt: string;
    fallback: PlanObject;
    ensureTests: boolean;
    note?: string;
    involved: Set<ProviderType>;
    after?: (plan: PlanObject) => void;
  }): Promise<void> {
    const { projectId, provider, phase, prompt, involved } = opts;
    const startedAt = monotonicNow();
    store.setPlanner({ phase, provider, startedAt, events: [], text: '' });
    let plan = opts.fallback;
    let error: string | undefined;
    try {
      const project = store.getProject();
      if (!project || project.id !== projectId) {
        return;
      }
      await git.createWorkspace(`${phase}_${projectId}`, {
        sourceDir: project.sourceDir,
        oraclePaths: project.oraclePaths,
        testCommand: project.testCommand,
        persistDir: project.workspaceDir,
        empty: !project.sourceDir,
      });
      const result = await adapters[provider].run(
        project.workspaceDir,
        prompt,
        (text) => store.appendPlannerEvents([], text),
        new AbortController().signal,
        (event: AgentEvent) =>
          store.appendPlannerEvents([{ ...event, role: 'plan', provider }], ''),
      );
      const parsed = parsePlanObject(result.output);
      if (parsed) {
        plan = opts.ensureTests
          ? ensureTestsItem(parsed, store.getProject()?.goal ?? '')
          : parsed;
      } else if (result.timedOut) {
        error = 'the planner timed out';
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      for (const provider of involved) {
        store.setBusy(provider, false);
      }
    }

    if (!store.getProject() || store.getProject()?.id !== projectId) {
      return;
    }
    const finished = store.getProject()?.planner;
    store.setPlanner({
      phase: error ? 'failed' : 'done',
      provider,
      startedAt,
      endedAt: monotonicNow(),
      events: finished?.events ?? [],
      text: finished?.text ?? '',
      error,
    });
    store.addMessage('orchestrator', plan.reply);
    store.applyPlanObject(plan, '', opts.note);
    opts.after?.(plan);
  }

  /**
   * §3 — steering that arrived after the last loop boundary still has to land.
   * If nothing is left to run, re-run the last code item with it folded in.
   */
  function drainSteeringIntoRun(): boolean {
    const project = store.getProject();
    if (!project || (project.steering ?? []).length === 0) {
      return false;
    }
    if (project.plan.some((item) => item.status === 'running' || item.status === 'pending')) {
      return false;
    }
    const target =
      [...project.plan].reverse().find((item) => inferJobKind(item) === 'code') ??
      project.plan.at(-1);
    if (!target) {
      return false;
    }
    store.patchPlanItem(target.id, { status: 'pending', taskId: undefined });
    const started = startProjectItem(store.getProject() ?? project, {
      ...target,
      status: 'pending',
    });
    return typeof started === 'string';
  }

  function queueNextPlanItem(): void {
    const project = store.getProject();
    if (!project) {
      return;
    }
    const last = [...store.getSnapshot().tasks]
      .reverse()
      .find((task) => task.projectId === project.id);
    if (last && last.status !== 'succeeded' && last.status !== 'failed') {
      return;
    }
    const shards = project.shards;
    if (shards) {
      const testsDone = project.plan.some(
        (item) => inferJobKind(item) === 'tests' && item.status === 'succeeded',
      );
      const codeDone = project.plan.some(
        (item) => inferJobKind(item) === 'code' && item.status === 'succeeded',
      );
      if (testsDone && codeDone) {
        void mergeParallelShards(store.getProject() ?? project).then(() => {
          startEligibleItems();
          markReadyIfComplete();
        });
        return;
      }
      if (project.plan.some((item) => item.status === 'running')) {
        return;
      }
      const shardFailed = project.plan.some(
        (item) =>
          (inferJobKind(item) === 'tests' || inferJobKind(item) === 'code') &&
          item.status === 'failed',
      );
      if (shardFailed) {
        // A failed lane is terminal after its recovery cap. Leaving shards set
        // makes the UI claim a merge is running and blocks further steering.
        store.updateProject({ shards: undefined });
        markReadyIfComplete();
        return;
      }
    }
    startEligibleItems();
    drainSteeringIntoRun();
    markReadyIfComplete();
  }

  app.use(express.json());
  app.use(cors({ origin: true }));

  app.use(
    (err: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (err instanceof SyntaxError) {
        sendError(res, 400, 'BAD_REQUEST', 'invalid JSON');
        return;
      }
      next(err);
    },
  );

  app.get('/api/state', (_req, res) => {
    res.status(200).json(snapshot());
  });

  /**
   * P0.2 — push instead of poll. The client keeps polling as a fallback, but
   * while this stream is open it only sees frames where something changed.
   */
  app.get('/api/events', (req, res) => {
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    let lastRev = -1;
    const tick = () => {
      const rev = store.getRev();
      if (rev === lastRev) {
        res.write(': ping\n\n');
        return;
      }
      lastRev = rev;
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    };
    tick();
    const timer = setInterval(tick, Math.max(80, Math.floor(POLL_MS / 3)));
    req.on('close', () => {
      clearInterval(timer);
      res.end();
    });
  });

  /** P2 — replay a recorded run: GET /api/replay?projectId=… */
  app.get('/api/replay', (req, res) => {
    let raw = '';
    try {
      raw = fs.readFileSync(replayPath, 'utf8');
    } catch {
      res.status(200).json({ items: [] });
      return;
    }
    const wanted =
      typeof req.query.projectId === 'string' ? req.query.projectId : '';
    const items: Array<{ projectId: string; ts: number; item: ThreadItem }> = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const row = JSON.parse(line);
        if (wanted && row.projectId !== wanted && row.item?.taskId !== wanted) {
          continue;
        }
        items.push(row);
      } catch {
        continue;
      }
    }
    const projects = [...new Set(items.map((row) => row.projectId))];
    res.status(200).json({ items, projects });
  });

  app.post('/api/projects', async (req, res) => {
    const parsed = readCreateProjectBody(req);
    if ('error' in parsed) {
      sendError(res, 400, 'BAD_REQUEST', parsed.error);
      return;
    }
    if (store.getProject()) {
      sendError(
        res,
        409,
        'SLOT_BUSY',
        'a project is already open; Reset first',
      );
      return;
    }
    let sourceDir: string | undefined;
    if (parsed.sourceDir) {
      const resolved = resolveSourceDir(parsed.sourceDir, projectDir);
      if (typeof resolved !== 'string') {
        sendError(res, 400, 'BAD_REQUEST', resolved.error);
        return;
      }
      sourceDir = resolved;
    }
    const existingTests = sourceDir ? detectOraclePaths(sourceDir) : [];
    const oraclePaths =
      parsed.oraclePaths && parsed.oraclePaths.length > 0
        ? parsed.oraclePaths
        : existingTests;
    const explicitTestCommand = Boolean(
      parsed.testCommand && parsed.testCommand.length > 0,
    );
    const testCommand = explicitTestCommand
      ? parsed.testCommand!
      : inferProjectTestCommand(parsed.goal, oraclePaths);
    const projectId = store.newProjectId();
    const workspaceDir = path.join(workspaceRoot(), projectId);
    const involved = involvedFromProject(
      {
        writerProvider: parsed.writerProvider,
        reviewerProvider: parsed.reviewerProvider,
        plannerProvider: parsed.plannerProvider,
      },
      Boolean(parsed.plannerProvider),
    );
    const busy = slotsBusy(involved);
    if (busy) {
      sendError(res, 409, 'SLOT_BUSY', `${busy} is already running a task`);
      return;
    }

    store.setProject({
      id: projectId,
      title: parsed.title,
      goal: parsed.goal,
      sourceDir,
      workspaceDir,
      applyTarget: sourceDir ?? projectDir,
      testCommand,
      oraclePaths,
      plannerProvider: parsed.plannerProvider,
      writerProvider: parsed.writerProvider,
      reviewerProvider: parsed.reviewerProvider,
      maxIterations: parsed.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      messages: [],
      plan: [],
      createdAt: monotonicNow(),
      // Tests that already exist in the folder are frozen from the start.
      frozenAt: oraclePaths.length > 0 ? monotonicNow() : undefined,
    });
    store.addMessage('user', parsed.goal);

    const hasTests = oraclePaths.length > 0;
    const fallback: PlanObject = hasTests
      ? {
          reply:
            'This folder already has tests. I will implement against them and leave them locked.',
          items: defaultBuildPlan(parsed.goal).items.filter(
            (item) => inferJobKind(item) === 'code',
          ),
        }
      : defaultBuildPlan(parsed.goal);

    if (parsed.plannerProvider) {
      // P1.6 — answer now, plan in the background, stream the planner's work.
      occupy(involved);
      res.status(201).json({ projectId, taskId: '' });
      void runPlanner({
        projectId,
        provider: parsed.plannerProvider,
        phase: 'planning',
        prompt: planObjectPrompt(parsed.title, parsed.goal),
        fallback,
        ensureTests: !hasTests,
        involved,
        after: (plan) => {
          if (!explicitTestCommand) {
            const plannedPaths = plan.items.flatMap((item) => item.files ?? []);
            store.updateProject({
              testCommand: inferProjectTestCommand(parsed.goal, [
                ...oraclePaths,
                ...plannedPaths,
              ]),
            });
          }
          startEligibleItems();
        },
      });
      return;
    }

    store.addMessage('orchestrator', fallback.reply);
    store.applyPlanObject(fallback, '');
    startEligibleItems();
    const live = store.getProject();
    if (!live) {
      sendError(res, 500, 'RESET_FAILED', 'failed to create project');
      return;
    }
    res.status(201).json({ projectId, taskId: live.activeTaskId ?? '' });
  });

  app.post('/api/projects/:id/messages', (req, res) => {
    const project = store.getProject();
    if (!project || project.id !== req.params.id) {
      sendError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      return;
    }
    const body = req.body as unknown;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      sendError(res, 400, 'BAD_REQUEST', 'request body must be a JSON object');
      return;
    }
    const text = (body as Record<string, unknown>).text;
    if (typeof text !== 'string' || text.trim() === '') {
      sendError(res, 400, 'BAD_REQUEST', 'text is required');
      return;
    }
    const userText = text.trim();
    store.updateProject({
      readyAt: undefined,
      appliedAt: undefined,
      appliedFiles: [],
    });
    const includePlanner = Boolean(project.plannerProvider);
    const involved = involvedFromProject(project, includePlanner);
    const running = store
      .getSnapshot()
      .tasks.some(
        (task) =>
          task.projectId === project.id &&
          (task.status === 'queued' ||
            task.status === 'running' ||
            task.status === 'retrying'),
      );

    /**
     * §3 — steering used to be rejected with SLOT_BUSY. Now it lands in the
     * thread immediately and the loop folds it in at the next boundary.
     */
    if (running || project.shards || slotsBusy(involved)) {
      const queued = store.queueSteering(userText);
      res.status(202).json({
        ok: true,
        taskId: '',
        queued: true,
        messageId: queued?.id,
      });
      return;
    }

    store.addMessage('user', userText);
    const fallbackTarget =
      [...project.plan].reverse().find((item) => item.status !== 'pending') ??
      project.plan[0];
    if (!fallbackTarget) {
      sendError(res, 400, 'BAD_REQUEST', 'project has no plan items');
      return;
    }

    if (project.plannerProvider) {
      occupy(involved);
      res.status(201).json({ ok: true, taskId: '' });
      const planJson = JSON.stringify(
        project.plan.map((item) => ({
          title: item.title,
          files: item.files,
          doneWhen: item.doneWhen,
          prompt: item.prompt,
          status: item.status,
        })),
        null,
        2,
      );
      const thread = project.messages
        .filter((message) => !message.cancelled)
        .map((message) => `${message.role}: ${message.text}`)
        .join('\n\n');
      void runPlanner({
        projectId: project.id,
        provider: project.plannerProvider,
        phase: 'steering',
        prompt: steerPrompt(project.goal, planJson, thread, userText),
        fallback: {
          reply: `Applying that to “${fallbackTarget.title}” and running the writer again. Locked tests: ${project.oraclePaths.join(', ') || 'none yet'}.`,
          items: project.plan.map((item) => ({
            kind: item.kind,
            title: item.title,
            files: item.files,
            doneWhen: item.doneWhen,
            prompt: `${item.prompt}\n\nFollow-up from the user:\n${userText}`,
          })),
        },
        ensureTests: false,
        note: `Steered by: “${userText}”`,
        involved,
        after: () => startEligibleItems(),
      });
      return;
    }

    const followPrompt = `${fallbackTarget.prompt}\n\nFollow-up from the user:\n${userText}`;
    store.addMessage(
      'orchestrator',
      `Applying that to “${fallbackTarget.title}” and running the writer again. Locked tests: ${project.oraclePaths.join(', ') || 'none yet'}.`,
    );
    store.patchPlanItem(fallbackTarget.id, { prompt: followPrompt });
    const live = store.getProject();
    const item =
      live?.plan.find((entry) => entry.id === fallbackTarget.id) ??
      live?.plan[0];
    if (!live || !item) {
      sendError(res, 400, 'BAD_REQUEST', 'project has no plan items');
      return;
    }
    const started = startProjectItem(live, {
      ...item,
      kind: 'code',
      prompt: followPrompt,
    });
    if (typeof started !== 'string') {
      sendError(res, started.status, started.code, started.error);
      return;
    }
    res.status(201).json({ ok: true, taskId: started });
  });

  app.post('/api/projects/:id/apply', (req, res) => {
    const project = store.getProject();
    if (!project || project.id !== req.params.id) {
      sendError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      return;
    }
    if (!project.readyAt || !isProjectReady(project, store.getSnapshot().tasks)) {
      sendError(
        res,
        409,
        'APPLY_NOT_READY',
        'the project is not ready to apply yet',
      );
      return;
    }
    const target = path.resolve(project.applyTarget ?? project.sourceDir ?? projectDir);
    const workspace = path.resolve(project.workspaceDir);
    const root = path.resolve(workspaceRoot());
    if (workspace !== root && !workspace.startsWith(`${root}${path.sep}`)) {
      sendError(res, 500, 'APPLY_FAILED', 'workspace is outside Choreo isolation');
      return;
    }
    if (project.appliedAt) {
      res.status(200).json({
        ok: true,
        target,
        files: project.appliedFiles ?? [],
        alreadyApplied: true,
      });
      return;
    }
    try {
      const files = applyWorkspace(workspace, target);
      store.updateProject({
        appliedAt: monotonicNow(),
        appliedFiles: files,
      });
      res.status(200).json({ ok: true, target, files });
    } catch (err) {
      sendError(
        res,
        500,
        'APPLY_FAILED',
        err instanceof Error ? err.message : String(err),
      );
    }
  });

  /** §3 — cancel a steering message that has not been folded in yet. */
  app.post('/api/projects/:id/steering/:messageId/cancel', (req, res) => {
    const project = store.getProject();
    if (!project || project.id !== req.params.id) {
      sendError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      return;
    }
    if (!store.cancelSteering(req.params.messageId)) {
      sendError(res, 404, 'TASK_NOT_FOUND', 'no queued message with that id');
      return;
    }
    res.status(200).json({ ok: true });
  });

  app.post('/api/tasks', (req, res) => {
    const parsed = readLaunchBody(req);
    if ('error' in parsed) {
      const message =
        parsed.error === 'provider'
          ? 'provider must be claude or codex'
          : parsed.error;
      sendError(res, 400, 'BAD_REQUEST', message);
      return;
    }

    let launch = parsed;
    if (parsed.projectId) {
      const project = store.getProject();
      if (!project || project.id !== parsed.projectId) {
        sendError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
        return;
      }
      launch = {
        ...parsed,
        sourceDir: project.sourceDir,
        oraclePaths: [...project.oraclePaths],
        testCommand: [...project.testCommand],
        persistDir: project.workspaceDir,
        reviewerProvider: parsed.reviewerProvider ?? project.reviewerProvider,
        orchestratorProvider:
          parsed.orchestratorProvider ?? project.plannerProvider,
      };
    }

    const involved = involvedFromLaunch(launch);
    const busy = slotsBusy(involved);
    if (busy) {
      sendError(res, 409, 'SLOT_BUSY', `${busy} is already running a task`);
      return;
    }

    occupy(involved);
    const task = store.addTask(launch);
    if (launch.projectId) {
      store.updateProject({ activeTaskId: task.id });
    }
    res.status(201).json({ taskId: task.id });
    startLoop(task.id);
  });

  app.post('/api/tasks/:id/cancel', (req, res) => {
    const task = store.getTask(req.params.id);
    if (!task) {
      sendError(res, 404, 'TASK_NOT_FOUND', 'task not found');
      return;
    }
    controllers.get(task.id)?.abort();
    res.status(200).json({ ok: true });
  });

  app.post('/api/reset', async (_req, res) => {
    for (const controller of controllers.values()) {
      controller.abort();
    }
    controllers.clear();
    try {
      await git.resetAll();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, 'RESET_FAILED', message);
      return;
    }
    store.clear();
    res.status(200).json({ ok: true });
  });

  fs.mkdirSync(WEB_DIR, { recursive: true });
  app.use((req, res, next) => {
    if (
      req.path === '/' ||
      req.path.endsWith('.html') ||
      req.path.endsWith('.js') ||
      req.path.endsWith('.css')
    ) {
      res.setHeader('Cache-Control', 'no-store');
    }
    next();
  });
  app.use(express.static(WEB_DIR));

  return app;
}
