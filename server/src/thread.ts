/**
 * §3 — the server owns thread order.
 *
 * The dashboard used to zipper messages and tasks together with an index
 * heuristic. Everything here is keyed off a real timestamp instead, so the
 * client renders a list rather than reconstructing history.
 */
import {
  PROVIDER_LABEL,
  ROLE_LABEL,
  inferJobKind,
  type AgentRole,
  type ChatMessage,
  type PlanItem,
  type ProjectState,
  type ProviderType,
  type ServerSnapshot,
  type TaskState,
  type ThreadItem,
} from '../../protocol/index.ts';

function isInFlight(task: TaskState): boolean {
  return (
    task.status === 'queued' ||
    task.status === 'running' ||
    task.status === 'retrying'
  );
}

/** Role is the label, provider is the identity (§4). */
export function whoFor(role: AgentRole, task?: TaskState): string {
  if (role === 'writer') {
    return task?.jobKind === 'tests' ? ROLE_LABEL.tests : ROLE_LABEL.writer;
  }
  if (role === 'tests') {
    return 'Test runner';
  }
  return ROLE_LABEL[role] ?? role;
}

export function providerForRole(
  role: AgentRole,
  task?: TaskState,
): ProviderType | undefined {
  if (!task) {
    return undefined;
  }
  if (role === 'plan') return task.orchestratorProvider;
  if (role === 'review') return task.reviewerProvider;
  if (role === 'writer') return task.provider;
  return undefined;
}

function planItemFor(
  project: ProjectState | undefined,
  task: TaskState,
): PlanItem | undefined {
  return (project?.plan ?? []).find((item) => item.taskId === task.id);
}

/**
 * The headline for a task that is still running.
 *
 * `role` drives the colour, `who` the label — they differ for the one case
 * where the same colour covers two casts: authoring tests vs running them.
 */
export function liveTitle(task: TaskState): {
  title: string;
  role: AgentRole;
  who: string;
} {
  switch (task.currentStep) {
    case 'plan':
      return { title: 'Planning the work', role: 'plan', who: ROLE_LABEL.plan };
    case 'writer':
      return task.jobKind === 'tests'
        ? { title: 'Authoring tests', role: 'tests', who: ROLE_LABEL.tests }
        : { title: 'Implementing', role: 'writer', who: ROLE_LABEL.writer };
    case 'oracle':
      return {
        title: 'Checking the locked tests',
        role: 'tests',
        who: ROLE_LABEL.loop,
      };
    case 'tests':
      return { title: 'Running the tests', role: 'tests', who: 'Test runner' };
    case 'review':
      return { title: 'Reviewing the diff', role: 'review', who: ROLE_LABEL.review };
    case 'git':
      return { title: 'Taking the snapshot', role: 'git', who: ROLE_LABEL.git };
    default:
      if (task.status === 'queued') {
        return {
          title: 'Opening a workspace',
          role: 'loop',
          who: ROLE_LABEL.loop,
        };
      }
      return task.jobKind === 'tests'
        ? { title: 'Authoring tests', role: 'tests', who: ROLE_LABEL.tests }
        : { title: 'Implementing', role: 'writer', who: ROLE_LABEL.writer };
  }
}

function messageItem(message: ChatMessage): ThreadItem {
  return {
    id: message.id,
    ts: message.ts,
    kind: message.role === 'user' ? 'user' : 'orchestrator',
    role: message.role === 'user' ? 'user' : 'plan',
    who: message.role === 'user' ? 'You' : ROLE_LABEL.plan,
    body: message.text,
    pending: message.pending === true,
    cancelled: message.cancelled === true,
  };
}

function liveItem(task: TaskState, project?: ProjectState): ThreadItem {
  const { title, role, who } = liveTitle(task);
  const item = planItemFor(project, task);
  const provider = role === 'review' ? task.reviewerProvider : task.provider;
  return {
    id: `live:${task.id}`,
    ts: task.startedAt ?? Date.now(),
    kind: 'live',
    role,
    who,
    provider,
    title,
    body: item?.title ?? task.title,
    taskId: task.id,
    steps: task.steps,
    attempt: task.currentIteration,
    maxAttempts: task.maxIterations,
  };
}

function timelineItems(task: TaskState, project?: ProjectState): ThreadItem[] {
  const out: ThreadItem[] = [];
  const base = task.startedAt ?? 0;
  (task.timeline ?? []).forEach((event, index) => {
    out.push({
      id: `${task.id}:${event.id}`,
      ts: event.ts ?? base + index,
      kind: 'event',
      role: event.role,
      who: whoFor(event.role, task),
      provider: event.provider ?? providerForRole(event.role, task),
      title: event.title,
      body: event.body,
      taskId: task.id,
      attempt: event.attempt,
      maxAttempts: task.maxIterations,
      verdict: event.verdict,
      durationMs: event.durationMs,
      tone: event.tone,
      timedOut: event.timedOut,
    });
  });
  return out;
}

function commitItem(task: TaskState): ThreadItem | null {
  if (task.status !== 'succeeded' || !task.commitSha) {
    return null;
  }
  return {
    id: `commit:${task.id}`,
    ts: (task.endedAt ?? Date.now()) + 1,
    kind: 'commit',
    role: 'git',
    who: ROLE_LABEL.git,
    title: `Snapshot ${task.commitSha.slice(0, 7)}`,
    body: 'Coding agents never run git commit. Node owns the SHA.',
    taskId: task.id,
    sha: task.commitSha,
    diff: task.diff,
    files: task.outputFiles,
    steps: task.steps,
    usage: task.usage,
    tone: 'ok',
  };
}

export function buildThread(snapshot: ServerSnapshot): ThreadItem[] {
  const project = snapshot.project;
  const tasks = snapshot.tasks;
  const items: ThreadItem[] = [];

  for (const message of project?.messages ?? []) {
    items.push(messageItem(message));
  }

  for (const card of project?.planCards ?? []) {
    const live = new Map((project?.plan ?? []).map((item) => [item.id, item]));
    const isLatest = card === (project?.planCards ?? []).at(-1);
    items.push({
      id: `plan:${card.id}`,
      ts: card.ts,
      kind: 'plan',
      role: 'plan',
      who: ROLE_LABEL.plan,
      provider: project?.plannerProvider,
      title: card.delta ? 'Updated plan' : 'Plan',
      body: card.note,
      plan: card.items.map((item) =>
        isLatest ? (live.get(item.id) ?? item) : item,
      ),
      planDelta: card.delta,
    });
  }

  if (project?.frozenAt) {
    const locked = project.oraclePaths ?? [];
    items.push({
      id: 'freeze',
      ts: project.frozenAt,
      kind: 'freeze',
      role: 'tests',
      who: 'Oracle',
      title: `${locked.length} test file${locked.length === 1 ? '' : 's'} frozen`,
      body: locked.length
        ? `${locked.join(', ')} — from here, \`${(project.testCommand ?? []).join(' ')}\` is the only SHA veto.`
        : 'The oracle is locked.',
      files: [],
      tone: 'ok',
    });
  }

  for (const task of tasks) {
    items.push(...timelineItems(task, project));
    const commit = commitItem(task);
    if (commit) {
      items.push(commit);
    }
  }

  const live = tasks.filter(isInFlight);
  if (project?.shards && live.length >= 2) {
    const [left, right] = orderShards(live, project);
    items.push({
      id: 'race',
      ts: Math.min(...live.map((task) => task.startedAt ?? Date.now())),
      kind: 'race',
      role: 'loop',
      who: 'Parallel run',
      title: 'Two processes, two worktrees',
      body: 'Tests and implementation are racing in separate git trees.',
      taskIds: [left.id, right.id],
    });
  } else {
    for (const task of live) {
      items.push(liveItem(task, project));
    }
  }

  if (project?.shards && live.length === 0) {
    items.push({
      id: 'merge',
      ts: Date.now(),
      kind: 'merge',
      role: 'loop',
      who: 'LoopSync',
      title: 'Merging the two worktrees',
      body: 'Both branches finished. Combining shards before the tests can freeze.',
    });
  }

  if (project?.planner && project.planner.phase !== 'done') {
    const failed = project.planner.phase === 'failed';
    items.push({
      id: `planner:${project.planner.startedAt}`,
      ts: project.planner.startedAt,
      kind: failed ? 'event' : 'live',
      role: 'plan',
      who: ROLE_LABEL.plan,
      provider: project.planner.provider,
      title: failed
        ? 'Planning failed — using the built-in split'
        : project.planner.phase === 'steering'
          ? 'Replanning around your steer'
          : 'Planning the work',
      body: failed ? project.planner.error : undefined,
      tone: failed ? 'fail' : undefined,
    });
  }

  items.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  return items;
}

function orderShards(
  live: TaskState[],
  project: ProjectState,
): [TaskState, TaskState] {
  const tests = live.find((task) => {
    const item = planItemFor(project, task);
    return (
      task.jobKind === 'tests' || (item && inferJobKind(item) === 'tests')
    );
  });
  const code = live.find((task) => task !== tests);
  return [tests ?? live[0], code ?? live[1] ?? live[0]];
}

export { isInFlight, PROVIDER_LABEL };
