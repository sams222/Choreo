import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_TEST_COMMAND,
  defaultBuildPlan,
  ensureTestsItem,
  inferJobKind,
  parsePlanObject,
  planObjectPrompt,
  steerPrompt,
  WORKSPACE_ROOT,
  type CLIAdapter,
  type CreateProjectBody,
  type ErrorCode,
  type GitRuntime,
  type JobKind,
  type LaunchTaskBody,
  type PlanItem,
  type ProjectState,
  type ProviderType,
} from '../../protocol/index.ts';
import { runLoop } from './loop.ts';
import type { Ledger } from './ledger.ts';
import type { Store } from './state.ts';

const WEB_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../web',
);

const DEFAULT_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

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
  repoRoot: string,
): string | { error: string } {
  const resolved = path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(repoRoot, input);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { error: `sourceDir is not a directory: ${resolved}` };
  }
  return resolved;
}

export function dashboardDefaults(_repoRoot: string) {
  return {
    sourceDir: '',
    title: '',
    goal: '',
    testCommand: [...DEFAULT_TEST_COMMAND],
    oraclePaths: [] as string[],
  };
}

export function createHttpApp(deps: {
  store: Store;
  git: GitRuntime;
  adapters: Record<ProviderType, CLIAdapter>;
  ledger?: Ledger;
  repoRoot?: string;
}): Express {
  const { store, git, adapters, ledger } = deps;
  const repoRoot = deps.repoRoot ?? DEFAULT_REPO_ROOT;
  const controllers = new Map<string, AbortController>();
  const app = express();

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
    return {
      title: item.title,
      prompt: item.prompt || project.goal,
      provider,
      maxIterations: project.maxIterations,
      reviewerProvider: kind === 'code' ? project.reviewerProvider : undefined,
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
    if (kind === 'code' && project.reviewerProvider) {
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
      store.updateProject({ oraclePaths: testFiles, shards: undefined });
      const ctx = {
        sourceDir: project.sourceDir,
        oraclePaths: testFiles,
        testCommand: project.testCommand,
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
        return;
      }
      await git.createWorkspace(`merge_${project.id}`, ctx);
      const commit = await git.commitIfDirty(
        project.workspaceDir,
        `LoopSync: ${project.title}`,
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
        });
        return;
      }
      if (project.plan.some((item) => item.status === 'running')) {
        return;
      }
    }
    startEligibleItems();
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
    res.status(200).json(store.getSnapshot());
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
      const resolved = resolveSourceDir(parsed.sourceDir, repoRoot);
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
    const testCommand =
      parsed.testCommand && parsed.testCommand.length > 0
        ? parsed.testCommand
        : [...DEFAULT_TEST_COMMAND];
    const projectId = store.newProjectId();
    const workspaceDir = path.join(WORKSPACE_ROOT, projectId);
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
      testCommand,
      oraclePaths,
      plannerProvider: parsed.plannerProvider,
      writerProvider: parsed.writerProvider,
      reviewerProvider: parsed.reviewerProvider,
      maxIterations: parsed.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      messages: [],
      plan: [],
    });
    store.addMessage('user', parsed.goal);

    let plan = defaultBuildPlan(parsed.goal);
    if (oraclePaths.length > 0) {
      plan = {
        reply: 'This folder already has tests. I will implement against them and leave them locked.',
        items: defaultBuildPlan(parsed.goal).items.filter(
          (item) => inferJobKind(item) === 'code',
        ),
      };
    }
    if (parsed.plannerProvider) {
      occupy(involved);
      try {
        await git.createWorkspace(`plan_${projectId}`, {
          sourceDir,
          oraclePaths,
          testCommand,
          persistDir: workspaceDir,
          empty: !sourceDir,
        });
        const result = await adapters[parsed.plannerProvider].run(
          workspaceDir,
          planObjectPrompt(parsed.title, parsed.goal),
          () => {
            /* plan JSON is parsed, not tailed */
          },
          new AbortController().signal,
        );
        const parsedPlan = parsePlanObject(result.output);
        if (parsedPlan) {
          plan =
            oraclePaths.length > 0
              ? parsedPlan
              : ensureTestsItem(parsedPlan, parsed.goal);
        }
      } catch {
        /* keep default plan */
      } finally {
        for (const provider of involved) {
          store.setBusy(provider, false);
        }
      }
    }

    store.addMessage('orchestrator', plan.reply);
    store.applyPlanObject(plan, '');
    startEligibleItems();
    const live = store.getProject();
    if (!live) {
      sendError(res, 500, 'RESET_FAILED', 'failed to create project');
      return;
    }
    res.status(201).json({ projectId, taskId: live.activeTaskId ?? '' });
  });

  app.post('/api/projects/:id/messages', async (req, res) => {
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
    const includePlanner = Boolean(project.plannerProvider);
    const involved = involvedFromProject(project, includePlanner);
    const busy = slotsBusy(involved);
    if (busy) {
      sendError(res, 409, 'SLOT_BUSY', `${busy} is already running a task`);
      return;
    }
    if (project.shards) {
      sendError(res, 409, 'SLOT_BUSY', 'parallel shards are still merging');
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

    let followItem: PlanItem = {
      ...fallbackTarget,
      prompt: `${fallbackTarget.prompt}\n\nFollow-up from the user:\n${userText}`,
    };
    let orchestratorReply = `Applying that to “${fallbackTarget.title}” and running the writer again. Locked tests: ${project.oraclePaths.join(', ')}.`;
    let replacedPlan = false;

    if (project.plannerProvider) {
      occupy(involved);
      const controller = new AbortController();
      try {
        await git.createWorkspace(`steer_${project.id}`, {
          sourceDir: project.sourceDir,
          oraclePaths: project.oraclePaths,
          testCommand: project.testCommand,
          persistDir: project.workspaceDir,
          empty: !project.sourceDir,
        });
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
        const thread = [...(store.getProject()?.messages ?? [])]
          .map((message) => `${message.role}: ${message.text}`)
          .join('\n\n');
        const result = await adapters[project.plannerProvider].run(
          project.workspaceDir,
          steerPrompt(project.goal, planJson, thread, userText),
          () => {
            /* steering output is parsed, not tailed into the last job */
          },
          controller.signal,
        );
        const parsed = parsePlanObject(result.output);
        if (parsed?.reply) {
          orchestratorReply = parsed.reply;
        }
        if (parsed) {
          store.applyPlanObject(parsed, '');
          const first = store.getProject()?.plan[0];
          if (first) {
            followItem = first;
            replacedPlan = true;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        orchestratorReply = `Could not replan (${message}). Running the writer with your follow-up anyway.`;
      } finally {
        for (const provider of involved) {
          store.setBusy(provider, false);
        }
      }
    }

    store.addMessage('orchestrator', orchestratorReply);
    if (!replacedPlan) {
      store.patchPlanItem(followItem.id, { prompt: followItem.prompt });
    }
    const live = store.getProject();
    if (!live) {
      sendError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      return;
    }
    const item =
      live.plan.find((entry) => entry.id === followItem.id) ?? live.plan[0];
    if (!item) {
      sendError(res, 400, 'BAD_REQUEST', 'project has no plan items');
      return;
    }
    const started = startProjectItem(live, {
      ...item,
      kind: 'code',
      prompt: followItem.prompt || item.prompt,
    });
    if (typeof started !== 'string') {
      sendError(res, started.status, started.code, started.error);
      return;
    }
    res.status(201).json({ ok: true, taskId: started });
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
