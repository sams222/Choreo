import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  ChatMessage,
  DashboardDefaults,
  LaunchTaskBody,
  PlanItem,
  PlanObject,
  PlanCard,
  PlannerState,
  ProjectState,
  ProviderType,
  ServerSnapshot,
  TaskState,
} from '../../protocol/index.ts';
import {
  DEFAULT_MAX_ITERATIONS,
  MAX_AGENT_EVENTS,
  diffPlans,
  inferJobKind,
  monotonicNow,
} from '../../protocol/index.ts';

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
    events: task.events?.map((event) => ({ ...event })),
    usage: task.usage ? { ...task.usage } : undefined,
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
    steering: project.steering?.map((message) => ({ ...message })),
    planner: project.planner
      ? {
          ...project.planner,
          events: project.planner.events.map((event) => ({ ...event })),
        }
      : undefined,
    planDelta: project.planDelta ? { ...project.planDelta } : undefined,
    planCards: project.planCards?.map((card) => ({
      ...card,
      items: card.items.map((item) => ({ ...item, files: [...item.files] })),
      delta: card.delta ? { ...card.delta } : undefined,
    })),
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
  let rev = 0;

  function bump(): number {
    rev += 1;
    return rev;
  }

  return {
    getSnapshot(): ServerSnapshot {
      return {
        tasks: tasks.map(cloneTask),
        slots: slots.map((slot) => ({ ...slot })),
        project: project ? cloneProject(project) : undefined,
        defaults,
        rev,
        now: Date.now(),
      };
    },

    getRev(): number {
      return rev;
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
      bump();
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
      bump();
      return cloneTask(next);
    },

    setBusy(provider: ProviderType, isBusy: boolean): void {
      slots = slots.map((slot) =>
        slot.provider === provider ? { ...slot, isBusy } : slot,
      );
      bump();
    },

    /** P0.1 — append structured CLI activity, newest last, capped. */
    appendTaskEvents(id: string, incoming: AgentEvent[]): void {
      if (incoming.length === 0) {
        return;
      }
      const index = tasks.findIndex((item) => item.id === id);
      if (index === -1) {
        return;
      }
      const current = tasks[index];
      const merged = [...(current.events ?? []), ...incoming];
      const events =
        merged.length > MAX_AGENT_EVENTS
          ? merged.slice(-MAX_AGENT_EVENTS)
          : merged;
      tasks = tasks.map((item, i) => (i === index ? { ...item, events } : item));
      bump();
    },

    setProject(next: ProjectState): ProjectState {
      project = cloneProject(next);
      bump();
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
        shards:
          'shards' in patch
            ? patch.shards
              ? { ...patch.shards }
              : undefined
            : project.shards
              ? { ...project.shards }
              : undefined,
      });
      bump();
      return cloneProject(project);
    },

    /** P1.6 — the orchestrator's own run, streamed instead of discarded. */
    setPlanner(next: PlannerState | undefined): void {
      if (!project) {
        return;
      }
      project = cloneProject({ ...project, planner: next });
      bump();
    },

    appendPlannerEvents(incoming: AgentEvent[], text: string): void {
      if (!project?.planner) {
        return;
      }
      const merged = [...project.planner.events, ...incoming];
      const events =
        merged.length > MAX_AGENT_EVENTS
          ? merged.slice(-MAX_AGENT_EVENTS)
          : merged;
      project = cloneProject({
        ...project,
        planner: {
          ...project.planner,
          events,
          text: `${project.planner.text}${text}`.slice(-4000),
        },
      });
      bump();
    },

    /** §3 — steering accepted mid-run, applied at the next loop boundary. */
    queueSteering(text: string): ChatMessage | undefined {
      if (!project) {
        return undefined;
      }
      const message: ChatMessage = {
        id: newMessageId(),
        role: 'user',
        text,
        ts: monotonicNow(),
        pending: true,
      };
      project = cloneProject({
        ...project,
        messages: [...project.messages, message],
        steering: [...(project.steering ?? []), message],
      });
      bump();
      return { ...message };
    },

    /** Drain the queue and mark the drained messages applied. */
    takeSteering(): string[] {
      if (!project) {
        return [];
      }
      const queued = (project.steering ?? []).filter(
        (message) => !message.cancelled,
      );
      if (queued.length === 0) {
        return [];
      }
      const appliedAt = Date.now();
      const ids = new Set(queued.map((message) => message.id));
      project = cloneProject({
        ...project,
        steering: [],
        messages: project.messages.map((message) =>
          ids.has(message.id)
            ? { ...message, pending: false, appliedAt }
            : message,
        ),
      });
      bump();
      return queued.map((message) => message.text);
    },

    cancelSteering(messageId: string): boolean {
      if (!project) {
        return false;
      }
      const queued = project.steering ?? [];
      if (!queued.some((message) => message.id === messageId)) {
        return false;
      }
      project = cloneProject({
        ...project,
        steering: queued.filter((message) => message.id !== messageId),
        messages: project.messages.map((message) =>
          message.id === messageId
            ? { ...message, pending: false, cancelled: true }
            : message,
        ),
      });
      bump();
      return true;
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
        ts: monotonicNow(),
      };
      project = cloneProject({
        ...project,
        messages: [...project.messages, message],
      });
      bump();
      return { ...message };
    },

    applyPlanObject(
      parsed: PlanObject,
      runningTaskId: string,
      note?: string,
    ): PlanItem[] | undefined {
      if (!project) {
        return undefined;
      }
      const previous = project.plan;
      const items: PlanItem[] = parsed.items.map((item, index) => {
        // A replan must not un-freeze work that already landed: an item whose
        // title matches a finished one keeps its status and its task.
        const done = previous.find(
          (prev) => prev.title === item.title && prev.status === 'succeeded',
        );
        return {
          id: done?.id ?? newItemId(),
          title: item.title,
          prompt: item.prompt?.trim() || item.title,
          files: [...(item.files ?? [])],
          doneWhen: item.doneWhen,
          status: done
            ? 'succeeded'
            : index === 0 && runningTaskId
              ? 'running'
              : 'pending',
          taskId: done?.taskId ?? (index === 0 && runningTaskId ? runningTaskId : undefined),
          kind: inferJobKind(item),
        };
      });
      const delta = diffPlans(previous, items);
      const changed =
        previous.length === 0 ||
        delta.added.length > 0 ||
        delta.removed.length > 0 ||
        delta.changed.length > 0;
      const card: PlanCard = {
        id: `plan_${(project.planCards?.length ?? 0) + 1}`,
        ts: monotonicNow(),
        items: items.map((item) => ({ ...item, files: [...item.files] })),
        delta: previous.length === 0 ? undefined : delta,
        note,
      };
      project = cloneProject({
        ...project,
        plan: items,
        planDelta: previous.length === 0 ? undefined : delta,
        planCards: changed
          ? [...(project.planCards ?? []), card]
          : (project.planCards ?? []),
      });
      bump();
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
      bump();
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
      bump();
    },

    newProjectId,
    newItemId,
    newTaskId,

    clear(): void {
      tasks = [];
      slots = IDLE_SLOTS.map((slot) => ({ ...slot }));
      project = undefined;
      bump();
    },
  };
}

export type Store = ReturnType<typeof createStore>;
