import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import type {
  CLIAdapter,
  ErrorCode,
  GitRuntime,
  LaunchTaskBody,
  ProviderType,
} from '../../protocol/index.ts';
import { runLoop } from './loop.ts';
import type { Store } from './state.ts';

const WEB_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../web',
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
  if (record.maxIterations !== undefined) {
    if (
      typeof record.maxIterations !== 'number' ||
      !Number.isInteger(record.maxIterations) ||
      record.maxIterations < 1
    ) {
      return { error: 'maxIterations must be a positive integer' };
    }
    launch.maxIterations = record.maxIterations;
  }
  return launch;
}

export function createHttpApp(deps: {
  store: Store;
  git: GitRuntime;
  adapters: Record<ProviderType, CLIAdapter>;
}): Express {
  const { store, git, adapters } = deps;
  const controllers = new Map<string, AbortController>();
  const app = express();

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

    const snapshot = store.getSnapshot();
    const slot = snapshot.slots.find((item) => item.provider === parsed.provider);
    if (slot?.isBusy) {
      sendError(
        res,
        409,
        'SLOT_BUSY',
        `${parsed.provider} is already running a task`,
      );
      return;
    }

    store.setBusy(parsed.provider, true);
    const task = store.addTask(parsed);
    const controller = new AbortController();
    controllers.set(task.id, controller);
    res.status(201).json({ taskId: task.id });
    void runLoop({
      store,
      git,
      adapters,
      taskId: task.id,
      signal: controller.signal,
    }).finally(() => {
      controllers.delete(task.id);
    });
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
