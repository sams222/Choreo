import { randomUUID } from 'node:crypto';
import type {
  ChatMessage,
  DashboardDefaults,
  LaunchTaskBody,
  PlanItem,
  PlanObject,
  ProjectState,
  ProviderType,
  ServerSnapshot,
  TaskState,
} from '../../protocol/index.ts';
import { DEFAULT_MAX_ITERATIONS, inferJobKind } from '../../protocol/index.ts';

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
    oraclePaths: task.oraclePaths ? [...task.oraclePaths] : undefined,
    testCommand: task.testCommand ? [...task.testCommand] : undefined,
  };
}

function cloneProject(project: ProjectState): ProjectState {
  return {
    ...project,
    testCommand: [...project.testCommand],
    oraclePaths: [...project.oraclePaths],
    messages: project.messages.map((message) => ({ ...message })),
    plan: project.plan.map((item) => ({ ...item, files: [...item.files] })),
  };
}

function newTaskId(): string {
  return `task_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function newProjectId(): string {
  return `proj_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function newItemId(): string {
  return `item_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
}

function newMessageId(): string {
  return `msg_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
}

function capLogs(logs: string[]): string[] {
  if (logs.length <= MAX_LOGS) {
    return [...logs];
  }
  return logs.slice(-MAX_LOGS);
}

export function createStore(defaults?: DashboardDefaults) {
  let tasks: TaskState[] = [];
  let slots: ServerSnapshot['slots'] = IDLE_SLOTS.map((slot) => ({ ...slot }));
  let project: ProjectState | undefined;

  return {
    getSnapshot(): ServerSnapshot {
      return {
        tasks: tasks.map(cloneTask),
        slots: slots.map((slot) => ({ ...slot })),
        project: project ? cloneProject(project) : undefined,
        defaults,
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
        projectId: body.projectId,
        sourceDir: body.sourceDir,
        oraclePaths: body.oraclePaths ? [...body.oraclePaths] : undefined,
        testCommand: body.testCommand ? [...body.testCommand] : undefined,
        persistDir: body.persistDir,
        jobKind: body.jobKind,
        skipTests: body.skipTests,
        skipCommit: body.skipCommit,
        empty: body.empty,
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
        oraclePaths: patch.oraclePaths
          ? [...patch.oraclePaths]
          : current.oraclePaths
            ? [...current.oraclePaths]
            : undefined,
        testCommand: patch.testCommand
          ? [...patch.testCommand]
          : current.testCommand
            ? [...current.testCommand]
            : undefined,
      };
      tasks = tasks.map((item, i) => (i === index ? next : item));
      return cloneTask(next);
    },

    setBusy(provider: ProviderType, isBusy: boolean): void {
      slots = slots.map((slot) =>
        slot.provider === provider ? { ...slot, isBusy } : slot,
      );
    },

    setProject(next: ProjectState): ProjectState {
      project = cloneProject(next);
      return cloneProject(project);
    },

    getProject(): ProjectState | undefined {
      return project ? cloneProject(project) : undefined;
    },

    updateProject(patch: Partial<ProjectState>): ProjectState | undefined {
      if (!project) {
        return undefined;
      }
      project = cloneProject({
        ...project,
        ...patch,
        testCommand: patch.testCommand
          ? [...patch.testCommand]
          : [...project.testCommand],
        oraclePaths: patch.oraclePaths
          ? [...patch.oraclePaths]
          : [...project.oraclePaths],
        messages: patch.messages
          ? patch.messages.map((message) => ({ ...message }))
          : project.messages.map((message) => ({ ...message })),
        plan: patch.plan
          ? patch.plan.map((item) => ({ ...item, files: [...item.files] }))
          : project.plan.map((item) => ({ ...item, files: [...item.files] })),
        shards: patch.shards
          ? { ...patch.shards }
          : project.shards
            ? { ...project.shards }
            : undefined,
      });
      return cloneProject(project);
    },

    addMessage(
      role: ChatMessage['role'],
      text: string,
    ): ChatMessage | undefined {
      if (!project) {
        return undefined;
      }
      const message: ChatMessage = {
        id: newMessageId(),
        role,
        text,
        ts: Date.now(),
      };
      project = cloneProject({
        ...project,
        messages: [...project.messages, message],
      });
      return { ...message };
    },

    applyPlanObject(
      parsed: PlanObject,
      runningTaskId: string,
    ): PlanItem[] | undefined {
      if (!project) {
        return undefined;
      }
      const items: PlanItem[] = parsed.items.map((item, index) => ({
        id: newItemId(),
        title: item.title,
        prompt: item.prompt?.trim() || item.title,
        files: [...(item.files ?? [])],
        doneWhen: item.doneWhen,
        status: index === 0 && runningTaskId ? 'running' : 'pending',
        taskId: index === 0 && runningTaskId ? runningTaskId : undefined,
        kind: inferJobKind(item),
      }));
      project = cloneProject({ ...project, plan: items });
      return cloneProject(project).plan;
    },

    patchPlanItem(
      itemId: string,
      patch: Partial<PlanItem>,
    ): PlanItem | undefined {
      if (!project) {
        return undefined;
      }
      const items = project.plan.map((item) =>
        item.id === itemId
          ? { ...item, ...patch, files: [...(patch.files ?? item.files)] }
          : { ...item, files: [...item.files] },
      );
      project = cloneProject({ ...project, plan: items });
      return items.find((item) => item.id === itemId);
    },

    markPlanItemForTask(
      taskId: string,
      status: PlanItem['status'],
    ): void {
      if (!project) {
        return;
      }
      const items = project.plan.map((item) =>
        item.taskId === taskId ? { ...item, status } : item,
      );
      project = cloneProject({ ...project, plan: items, activeTaskId: taskId });
    },

    newProjectId,
    newItemId,
    newTaskId,

    clear(): void {
      tasks = [];
      slots = IDLE_SLOTS.map((slot) => ({ ...slot }));
      project = undefined;
    },
  };
}

export type Store = ReturnType<typeof createStore>;
