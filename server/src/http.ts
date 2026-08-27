import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_SQRT,
  DEFAULT_TEST_COMMAND,
  parsePlanObject,
  steerPrompt,
  WORKSPACE_ROOT,
  type CLIAdapter,
  type CreateProjectBody,
  type ErrorCode,
  type GitRuntime,
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
  if (typeof record.title !== 'string' || record.title.trim() === '') {
    return { error: 'title is required' };
  }
  if (typeof record.goal !== 'string' || record.goal.trim() === '') {
    return { error: 'goal is required' };
  }
  if (typeof record.sourceDir !== 'string' || record.sourceDir.trim() === '') {
    return { error: 'sourceDir is required' };
  }
  if (!isProvider(record.writerProvider)) {
    return { error: 'writerProvider must be claude or codex' };
  }
  const project: CreateProjectBody = {
    title: record.title.trim(),
    goal: record.goal.trim(),
    sourceDir: record.sourceDir.trim(),
    writerProvider: record.writerProvider,
  };
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

export function dashboardDefaults(repoRoot: string) {
  return {
    sourceDir: path.join(repoRoot, 'examples/sqrt'),
    title: DEFAULT_SQRT.title,
    goal: DEFAULT_SQRT.goal,
    testCommand: [...DEFAULT_TEST_COMMAND],
    oraclePaths: [...(DEFAULT_SQRT.oraclePaths ?? ['sqrt.test.js'])],
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
    includePlanner: boolean,
  ): LaunchTaskBody {
    return {
      title: item.title,
      prompt: item.prompt || project.goal,
      provider: project.writerProvider,
      maxIterations: project.maxIterations,
      reviewerProvider: project.reviewerProvider,
      orchestratorProvider: includePlanner
        ? project.plannerProvider
        : undefined,
      projectId: project.id,
      sourceDir: project.sourceDir,
      oraclePaths: [...project.oraclePaths],
      testCommand: [...project.testCommand],
      persistDir: project.workspaceDir,
    };
  }

  function startProjectItem(
    project: ProjectState,
    item: PlanItem,
    includePlanner: boolean,
  ): string | { error: string; code: ErrorCode; status: number } {
    const involved = involvedFromProject(project, includePlanner);
    const busy = slotsBusy(involved);
    if (busy) {
      return {
        error: `${busy} is already running a task`,
        code: 'SLOT_BUSY',
        status: 409,
      };
    }
    occupy(involved);
    const task = store.addTask(launchBodyForItem(project, item, includePlanner));
    store.patchPlanItem(item.id, { status: 'running', taskId: task.id });
    store.updateProject({ activeTaskId: task.id });
    startLoop(task.id);
    return task.id;
  }

  function queueNextPlanItem(): void {
    const project = store.getProject();
    if (!project) {
      return;
    }
    const next = project.plan.find((item) => item.status === 'pending');
    if (!next) {
      return;
    }
    const last = [...store.getSnapshot().tasks]
      .reverse()
      .find((task) => task.projectId === project.id);
    if (!last || last.status !== 'succeeded') {
      return;
    }
    const result = startProjectItem(project, next, false);
    if (typeof result !== 'string') {
      return;
    }
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

  app.post('/api/projects', (req, res) => {
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
    const sourceDir = resolveSourceDir(parsed.sourceDir, repoRoot);
    if (typeof sourceDir !== 'string') {
      sendError(res, 400, 'BAD_REQUEST', sourceDir.error);
      return;
    }
    const oraclePaths =
      parsed.oraclePaths && parsed.oraclePaths.length > 0
        ? parsed.oraclePaths
        : detectOraclePaths(sourceDir);
    if (oraclePaths.length === 0) {
      sendError(
        res,
        400,
        'BAD_REQUEST',
        'oraclePaths is required (no test files found in sourceDir)',
      );
      return;
    }
    const testCommand =
      parsed.testCommand && parsed.testCommand.length > 0
        ? parsed.testCommand
        : [...DEFAULT_TEST_COMMAND];
    const projectId = store.newProjectId();
    const itemId = store.newItemId();
    const workspaceDir = path.join(WORKSPACE_ROOT, projectId);
    const includePlanner = Boolean(parsed.plannerProvider);
    const involved = involvedFromProject(
      {
        writerProvider: parsed.writerProvider,
        reviewerProvider: parsed.reviewerProvider,
        plannerProvider: parsed.plannerProvider,
      },
      includePlanner,
    );
    const busy = slotsBusy(involved);
    if (busy) {
      sendError(res, 409, 'SLOT_BUSY', `${busy} is already running a task`);
      return;
    }

    const item: PlanItem = {
      id: itemId,
      title: parsed.title,
      prompt: parsed.goal,
      files: [],
      status: 'running',
    };
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
      plan: [item],
    });
    store.addMessage('user', parsed.goal);
    occupy(involved);
    const live = store.getProject();
    if (!live) {
      sendError(res, 500, 'RESET_FAILED', 'failed to create project');
      return;
    }
    const task = store.addTask(launchBodyForItem(live, item, includePlanner));
    store.patchPlanItem(itemId, { status: 'running', taskId: task.id });
    store.updateProject({ activeTaskId: task.id });
    res.status(201).json({ projectId, taskId: task.id });
    startLoop(task.id);
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
    const started = startProjectItem(
      live,
      { ...item, prompt: followItem.prompt || item.prompt },
      false,
    );
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
  app.use(express.static(WEB_DIR));

  return app;
}
