import { randomUUID } from 'node:crypto';
import type {
  LaunchTaskBody,
  ProviderType,
  ServerSnapshot,
  TaskState,
} from '../../protocol/index.ts';
import { DEFAULT_MAX_ITERATIONS } from '../../protocol/index.ts';

const MAX_LOGS = 500;

const IDLE_SLOTS: ServerSnapshot['slots'] = [
  { provider: 'claude', isBusy: false },
  { provider: 'codex', isBusy: false },
];

function cloneTask(task: TaskState): TaskState {
  return {
    ...task,
    logs: [...task.logs],
    steps: task.steps?.map((step) => ({ ...step })),
    timeline: task.timeline?.map((item) => ({ ...item })),
    outputFiles: task.outputFiles?.map((file) => ({ ...file })),
  };
}

function newTaskId(): string {
  return `task_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function capLogs(logs: string[]): string[] {
  if (logs.length <= MAX_LOGS) {
    return [...logs];
  }
  return logs.slice(-MAX_LOGS);
}

export function createStore() {
  let tasks: TaskState[] = [];
  let slots: ServerSnapshot['slots'] = IDLE_SLOTS.map((slot) => ({ ...slot }));

  return {
    getSnapshot(): ServerSnapshot {
      return {
        tasks: tasks.map(cloneTask),
        slots: slots.map((slot) => ({ ...slot })),
      };
    },

    addTask(body: LaunchTaskBody): TaskState {
      const hasReviewer = Boolean(body.reviewerProvider);
      const task: TaskState = {
        id: newTaskId(),
        title: body.title,
        prompt: body.prompt,
        provider: body.provider,
        status: 'queued',
        currentIteration: 0,
        maxIterations: body.maxIterations ?? DEFAULT_MAX_ITERATIONS,
        workspaceDir: '',
        logs: [],
        orchestratorProvider: body.orchestratorProvider,
        reviewerProvider: body.reviewerProvider,
        currentStep: 'writer',
        capsRemaining: body.maxIterations ?? DEFAULT_MAX_ITERATIONS,
        steps: [
          { id: 'writer', status: 'pending' },
          { id: 'tests', status: 'pending' },
          { id: 'review', status: hasReviewer ? 'pending' : 'skipped' },
          { id: 'git', status: 'pending' },
        ],
        timeline: [],
        outputFiles: [],
      };
      tasks = [...tasks, task];
      return cloneTask(task);
    },

    getTask(id: string): TaskState | undefined {
      const task = tasks.find((item) => item.id === id);
      return task ? cloneTask(task) : undefined;
    },

    updateTask(id: string, patch: Partial<TaskState>): TaskState | undefined {
      const index = tasks.findIndex((item) => item.id === id);
      if (index === -1) {
        return undefined;
      }
      const current = tasks[index];
      const next: TaskState = {
        ...current,
        ...patch,
        logs: capLogs(patch.logs ?? current.logs),
        steps: patch.steps
          ? patch.steps.map((step) => ({ ...step }))
          : current.steps?.map((step) => ({ ...step })),
        timeline: patch.timeline
          ? patch.timeline.map((item) => ({ ...item }))
          : current.timeline?.map((item) => ({ ...item })),
        outputFiles: patch.outputFiles
          ? patch.outputFiles.map((file) => ({ ...file }))
          : current.outputFiles?.map((file) => ({ ...file })),
      };
      tasks = tasks.map((item, i) => (i === index ? next : item));
      return cloneTask(next);
    },

    setBusy(provider: ProviderType, isBusy: boolean): void {
      slots = slots.map((slot) =>
        slot.provider === provider ? { ...slot, isBusy } : slot,
      );
    },

    clear(): void {
      tasks = [];
      slots = IDLE_SLOTS.map((slot) => ({ ...slot }));
    },
  };
}

export type Store = ReturnType<typeof createStore>;
