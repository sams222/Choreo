/**
 * CHOREO FROZEN PROTOCOL
 * Do not change field names without a team shout in the group chat.
 * JSON examples live in protocol/examples/. Runtime layers share this contract.
 */

export type ProviderType = 'claude' | 'codex';

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'retrying'
  | 'succeeded'
  | 'failed';

export type JobKind = 'tests' | 'code';

export type StepId = 'writer' | 'tests' | 'review' | 'git';
export type StepStatus = 'pending' | 'running' | 'ok' | 'fail' | 'skipped';

export interface StepState {
  id: StepId;
  status: StepStatus;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
}

export const STEP_LABEL: Record<StepId, string> = {
  writer: 'write',
  tests: 'tests',
  review: 'review',
  git: 'git',
};

export type ReviewVerdict = 'ok' | 'reject';

export type AgentRole = 'plan' | 'writer' | 'tests' | 'review' | 'git' | 'loop';

/** Structured activity parsed out of a CLI's JSON event stream. */
export type AgentEventKind =
  | 'start'
  | 'text'
  | 'reasoning'
  | 'tool'
  | 'result'
  | 'error';

export interface AgentEvent {
  id: string;
  ts: number;
  provider: ProviderType;
  role: AgentRole;
  kind: AgentEventKind;
  /** Prose for text/reasoning, a short summary for tool/result. */
  text: string;
  /** Edit / Read / Bash / apply_patch … */
  tool?: string;
  /** File path or command the tool acted on. */
  target?: string;
  /** Present on `result` events when the CLI reports them. */
  durationMs?: number;
  costUsd?: number;
  numTurns?: number;
  isError?: boolean;
}

export interface AgentUsage {
  durationMs?: number;
  costUsd?: number;
  numTurns?: number;
}

export const ROLE_LABEL: Record<AgentRole, string> = {
  plan: 'Orchestrator',
  writer: 'Implementer',
  tests: 'Test author',
  review: 'Reviewer',
  git: 'Git (Node-owned)',
  loop: 'Choreo',
};

export const PROVIDER_LABEL: Record<ProviderType, string> = {
  claude: 'Claude',
  codex: 'Codex',
};

/** Max structured events kept per task. */
export const MAX_AGENT_EVENTS = 120;

let lastStamp = 0;

/**
 * Thread order is timestamp order, and several events are created inside the
 * same millisecond. This never returns the same value twice, so two beats can
 * never tie and fall back to comparing ids.
 */
export function monotonicNow(): number {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return lastStamp;
}

export interface TaskState {
  id: string;
  title: string;
  prompt: string;
  provider: ProviderType;
  status: TaskStatus;
  currentIteration: number;
  maxIterations: number;
  workspaceDir: string;
  logs: string[];
  lastError?: string;
  diff?: string;
  commitSha?: string;
  /** Optional planner CLI. Omit = Node harness only (Gate 2). */
  orchestratorProvider?: ProviderType;
  /** Optional adversarial reviewer. Omit = writer + tests only (Gate 2). */
  reviewerProvider?: ProviderType;
  currentStep?: StepId | 'plan' | 'oracle' | 'done';
  steps?: StepState[];
  oracleSha?: string;
  capsRemaining?: number;
  lastReview?: ReviewVerdict;
  timeline?: TimelineEvent[];
  outputFiles?: OutputFile[];
  /** Phase D: this task belongs to a project (not the homework fixture). */
  projectId?: string;
  sourceDir?: string;
  oraclePaths?: string[];
  testCommand?: string[];
  persistDir?: string;
  jobKind?: JobKind;
  skipTests?: boolean;
  skipCommit?: boolean;
  empty?: boolean;
  /** Structured CLI activity (P0.1). Newest last, capped. */
  events?: AgentEvent[];
  /** Wall clock for the server-authoritative elapsed readout. */
  startedAt?: number;
  endedAt?: number;
  /** The CLI process hit CLI_TIMEOUT_MS instead of exiting on its own. */
  timedOut?: boolean;
  /** Aggregated duration/cost/turns reported by the CLIs. */
  usage?: AgentUsage;
  /** Which plan item this task is executing. */
  planItemId?: string;
}

export interface TimelineEvent {
  id: string;
  role: AgentRole;
  title: string;
  body: string;
  ts?: number;
  provider?: ProviderType;
  attempt?: number;
  verdict?: ReviewVerdict;
  durationMs?: number;
  tone?: 'ok' | 'fail' | 'info';
  timedOut?: boolean;
}

export interface OutputFile {
  path: string;
  content: string;
  /** Frozen oracle — shown in the Code pane, not editable by the writer. */
  locked?: boolean;
}

export interface ProviderSlot {
  provider: ProviderType;
  isBusy: boolean;
}

export interface ServerSnapshot {
  tasks: TaskState[];
  slots: ProviderSlot[];
  /** Phase D/E: at most one live project in RAM. */
  project?: ProjectState;
  defaults?: DashboardDefaults;
  /** Bumped on every mutation so SSE and polling can skip no-op frames. */
  rev?: number;
  /** Server time when the snapshot was taken (authoritative elapsed). */
  now?: number;
  /** Server-assembled chronological thread. The client renders, not rebuilds. */
  thread?: ThreadItem[];
}

export type ThreadItemKind =
  | 'user'
  | 'orchestrator'
  | 'plan'
  | 'event'
  | 'live'
  | 'race'
  | 'merge'
  | 'freeze'
  | 'commit';

export interface ThreadItem {
  id: string;
  ts: number;
  kind: ThreadItemKind;
  role: AgentRole | 'user';
  who: string;
  provider?: ProviderType;
  title?: string;
  body?: string;
  taskId?: string;
  /** Two task ids for the parallel race card. */
  taskIds?: string[];
  plan?: PlanItem[];
  planDelta?: PlanDelta;
  steps?: StepState[];
  files?: OutputFile[];
  verdict?: ReviewVerdict;
  attempt?: number;
  maxAttempts?: number;
  sha?: string;
  diff?: string;
  durationMs?: number;
  usage?: AgentUsage;
  pending?: boolean;
  cancelled?: boolean;
  timedOut?: boolean;
  tone?: 'ok' | 'fail' | 'info';
}

export interface RunResult {
  output: string;
  exitCode: number;
  /** Killed by CLI_TIMEOUT_MS rather than exiting on its own. */
  timedOut?: boolean;
  events?: AgentEvent[];
  usage?: AgentUsage;
}

export interface TestResult {
  passed: boolean;
  output: string;
  exitCode: number;
}

export interface WorkspaceHandle {
  dir: string;
  branch: string;
}

export interface CommitResult {
  sha: string;
  diff: string;
}

/** Person 3 implements. Person 1 calls. */
export interface CLIAdapter {
  provider: ProviderType;
  run(
    workspaceDir: string,
    prompt: string,
    onLog: (text: string) => void,
    signal: AbortSignal,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<RunResult>;
}

/**
 * Optional per-job isolation. Omit = Gate 2 homework fixture
 * (`parse.js` / `parse.test.js` / `node --test`).
 */
export interface WorkspaceContext {
  sourceDir?: string;
  oraclePaths?: readonly string[];
  testCommand?: readonly string[];
  /** Reuse this directory on follow-up. Do not recopy from sourceDir. */
  persistDir?: string;
  /** Empty tree instead of copying fixture/ or sourceDir. */
  empty?: boolean;
  /** tests = author test files (red is OK). code = implement against a frozen oracle. */
  mode?: JobKind;
}

export type ChatRole = 'user' | 'orchestrator';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  ts: number;
  /** Steering accepted mid-run; applies at the next loop boundary. */
  pending?: boolean;
  /** Set when a pending steering message was folded into a prompt. */
  appliedAt?: number;
  /** Set when the user cancelled a queued steering message. */
  cancelled?: boolean;
}

export type PlanItemStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface PlanItem {
  id: string;
  title: string;
  prompt: string;
  files: string[];
  doneWhen?: string;
  status: PlanItemStatus;
  taskId?: string;
  kind?: JobKind;
}

/** One immutable plan snapshot, posted into the thread as a card (§3). */
export interface PlanCard {
  id: string;
  ts: number;
  items: PlanItem[];
  delta?: PlanDelta;
  /** Short note describing why the plan changed. */
  note?: string;
}

export interface PlanDelta {
  added: string[];
  removed: string[];
  changed: string[];
}

export function diffPlans(
  before: readonly PlanItem[],
  after: readonly PlanItem[],
): PlanDelta {
  const beforeTitles = before.map((item) => item.title);
  const afterTitles = after.map((item) => item.title);
  const added = afterTitles.filter((title) => !beforeTitles.includes(title));
  const removed = beforeTitles.filter((title) => !afterTitles.includes(title));
  const changed: string[] = [];
  for (const item of after) {
    const match = before.find((prev) => prev.title === item.title);
    if (!match) {
      continue;
    }
    if (
      match.prompt !== item.prompt ||
      match.doneWhen !== item.doneWhen ||
      match.files.join(',') !== item.files.join(',')
    ) {
      changed.push(item.title);
    }
  }
  return { added, removed, changed };
}

export interface ProjectState {
  id: string;
  title: string;
  goal: string;
  sourceDir?: string;
  workspaceDir: string;
  testCommand: string[];
  oraclePaths: string[];
  plannerProvider?: ProviderType;
  writerProvider: ProviderType;
  reviewerProvider?: ProviderType;
  maxIterations: number;
  messages: ChatMessage[];
  plan: PlanItem[];
  activeTaskId?: string;
  shards?: { testsDir: string; codeDir: string };
  createdAt?: number;
  /** Live orchestrator run (planning or steering) with streamed output. */
  planner?: PlannerState;
  /** Steering the user sent mid-run, applied at the next loop boundary. */
  steering?: ChatMessage[];
  /** Set once the test oracle froze; drives the freeze beat in the thread. */
  frozenAt?: number;
  /** Latest plan change from a replan, for the delta card. */
  planDelta?: PlanDelta;
  /** Plan history — one card per (re)plan, newest last. */
  planCards?: PlanCard[];
  /** Set only after all work and any parallel merge have completed successfully. */
  readyAt?: number;
  /** Directory that receives files when the user explicitly clicks Apply. */
  applyTarget?: string;
  /** Audit trail for the last successful apply operation. */
  appliedAt?: number;
  appliedFiles?: string[];
}

export type PlannerPhase = 'idle' | 'planning' | 'steering' | 'done' | 'failed';

export interface PlannerState {
  phase: PlannerPhase;
  provider?: ProviderType;
  startedAt: number;
  endedAt?: number;
  events: AgentEvent[];
  text: string;
  error?: string;
}

export interface DashboardDefaults {
  sourceDir: string;
  title: string;
  goal: string;
  testCommand: string[];
  oraclePaths: string[];
}

export interface PlanObject {
  reply: string;
  items: Array<{
    title: string;
    files?: string[];
    doneWhen?: string;
    prompt?: string;
    kind?: JobKind;
  }>;
}

/** Person 2 implements. Person 1 calls. */
export interface GitRuntime {
  createWorkspace(
    taskId: string,
    ctx?: WorkspaceContext,
  ): Promise<WorkspaceHandle>;
  runTests(dir: string, ctx?: WorkspaceContext): Promise<TestResult>;
  getDiff(dir: string): Promise<string>;
  commitIfDirty(
    dir: string,
    message: string,
    ctx?: WorkspaceContext,
  ): Promise<CommitResult | null>;
  resetAll(): Promise<void>;
  /** True if oracle paths differ from the source baseline. */
  checkOracle(
    dir: string,
    ctx?: WorkspaceContext,
  ): Promise<{ dirty: boolean; oracleSha: string }>;
  /** Changed/new files vs the source. Locked tests are included. */
  listOutputs(dir: string, ctx?: WorkspaceContext): Promise<OutputFile[]>;
  listTestFiles(dir: string): Promise<string[]>;
  mergeShards(
    dest: string,
    testsDir: string,
    codeDir: string,
  ): Promise<void>;
}

export interface LaunchTaskBody {
  title: string;
  prompt: string;
  provider: ProviderType;
  maxIterations?: number;
  orchestratorProvider?: ProviderType;
  reviewerProvider?: ProviderType;
  projectId?: string;
  sourceDir?: string;
  oraclePaths?: string[];
  testCommand?: string[];
  persistDir?: string;
  jobKind?: JobKind;
  skipTests?: boolean;
  skipCommit?: boolean;
  empty?: boolean;
}

export interface CreateProjectBody {
  title: string;
  goal: string;
  sourceDir?: string;
  testCommand?: string[];
  oraclePaths?: string[];
  writerProvider: ProviderType;
  plannerProvider?: ProviderType;
  reviewerProvider?: ProviderType;
  maxIterations?: number;
}

export interface CreateProjectResponse {
  projectId: string;
  taskId: string;
}

export interface PostMessageBody {
  text: string;
}

export interface PostMessageResponse {
  ok: true;
  /** Empty when the message was queued instead of starting a run. */
  taskId: string;
  /** §3 — accepted mid-run; applies at the next loop boundary. */
  queued?: boolean;
  messageId?: string;
}

export interface LaunchTaskResponse {
  taskId: string;
}

export interface OkResponse {
  ok: true;
}

export const REPLAY_LOG = '.choreo/thread.jsonl';

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNKNOWN_PROVIDER'
  | 'SLOT_BUSY'
  | 'TASK_NOT_FOUND'
  | 'RESET_FAILED'
  | 'ORACLE_TAMPERED'
  | 'CAP_EXHAUSTED'
  | 'PROJECT_NOT_FOUND'
  | 'APPLY_NOT_READY'
  | 'APPLY_FAILED';

export interface ErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
  };
}

export const PORT = 4055;
export const POLL_MS = 300;
const configuredCliTimeout = Number.parseInt(
  process.env.CHOREO_CLI_TIMEOUT_MS ?? process.env.LOOPSYNC_CLI_TIMEOUT_MS ?? '',
  10,
);
export const CLI_TIMEOUT_MS =
  Number.isFinite(configuredCliTimeout) && configuredCliTimeout >= 60_000
    ? configuredCliTimeout
    : 30 * 60_000;
export const DEFAULT_MAX_ITERATIONS = 5;
export const WORKSPACE_ROOT = '/tmp/choreo-workspaces';

/**
 * Where isolated worktrees live. Overridable so two Choreo instances (or two
 * test files) never reset each other's trees out from under a running loop.
 */
export function workspaceRoot(): string {
  const override =
    process.env.CHOREO_WORKSPACE_ROOT ?? process.env.LOOPSYNC_WORKSPACE_ROOT;
  return override && override.trim() !== '' ? override.trim() : WORKSPACE_ROOT;
}
export const ORACLE_PATHS = ['parse.test.js'] as const;
export const SQRT_ORACLE_PATHS = ['sqrt.test.js'] as const;
export const DEFAULT_TEST_COMMAND = ['node', '--test'] as const;
export const DEFAULT_PYTHON_TEST_COMMAND = [
  'python3',
  '-m',
  'unittest',
  'discover',
] as const;

export function pythonTestCommand(testFiles: readonly string[] = []): string[] {
  return testFiles.length > 0
    ? ['python3', '-m', 'unittest', ...testFiles]
    : [...DEFAULT_PYTHON_TEST_COMMAND];
}
export const REVIEW_OK = 'REVIEW_OK';
export const REVIEW_REJECT = 'REVIEW_REJECT';

export const DEFAULT_LAUNCH: LaunchTaskBody = {
  title: 'Fix Off-By-One Index in Array Parser',
  prompt:
    'The test in parse.test.js fails. Make parseIndex return the correct value so the test passes. Do not change the test. Do not ask questions. Do not run git commit.',
  provider: 'codex',
  maxIterations: DEFAULT_MAX_ITERATIONS,
};

export const DEFAULT_SQRT: Pick<
  CreateProjectBody,
  'title' | 'goal' | 'testCommand' | 'oraclePaths'
> = {
  title: 'Integer square root',
  goal: 'Implement integerSqrt in sqrt.js so integerSqrt(9) === 3. Do not change sqrt.test.js. Do not ask questions. Do not run git commit.',
  testCommand: [...DEFAULT_TEST_COMMAND],
  oraclePaths: [...SQRT_ORACLE_PATHS],
};

export const HTTP = {
  getState: 'GET /api/state',
  events: 'GET /api/events',
  replay: 'GET /api/replay',
  launch: 'POST /api/tasks',
  cancel: 'POST /api/tasks/:id/cancel',
  reset: 'POST /api/reset',
  createProject: 'POST /api/projects',
  projectMessage: 'POST /api/projects/:id/messages',
  cancelSteering: 'POST /api/projects/:id/steering/:messageId/cancel',
  applyProject: 'POST /api/projects/:id/apply',
} as const;

/** Proven argv on the demo laptop. Person 3 must use these. */
export const PROVIDER_COMMANDS = {
  claude: {
    bin: 'claude',
    /** stream-json emits one JSON event per line; --verbose is required with -p. */
    stream: 'claude-jsonl' as const,
    args: (prompt: string) => [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ],
  },
  codex: {
    bin: 'codex',
    /** `codex exec --json` emits JSONL; shape varies by version, parser is tolerant. */
    stream: 'codex-jsonl' as const,
    args: (prompt: string) => [
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      prompt,
    ],
  },
} as const;

/** Set CHOREO_PLAIN_CLI=1 to fall back to the old text output format. */
export const PROVIDER_COMMANDS_PLAIN = {
  claude: {
    bin: 'claude',
    stream: 'text' as const,
    args: (prompt: string) => [
      '-p',
      prompt,
      '--output-format',
      'text',
      '--dangerously-skip-permissions',
    ],
  },
  codex: {
    bin: 'codex',
    stream: 'text' as const,
    args: (prompt: string) => [
      'exec',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      prompt,
    ],
  },
} as const;

export function retryPrompt(originalPrompt: string, testOutput: string): string {
  return `${originalPrompt}

The tests failed. Fix the code, not the test. Do not ask questions. Do not git commit.

TEST OUTPUT:
${testOutput}`;
}

export function planPrompt(title: string, userPrompt: string): string {
  return `You are the orchestration agent for Choreo. Do not edit files. Do not run git. Do not run tests. Do not ask questions.

Title: ${title}

User task:
${userPrompt}

Write a short plan for the writer: which file to change, the exact production behavior required, and what not to touch (the test file, git commit). End with a line that is exactly:
PLAN_DONE`;
}

export function writerPromptWithPlan(userPrompt: string, plan: string): string {
  return `${userPrompt}

ORCHESTRATOR PLAN:
${plan}

Follow the plan. Do not change the test. Do not ask questions. Do not run git commit.`;
}

export function reviewPrompt(
  diff: string,
  userTask: string,
  frozenTests: readonly string[] = [],
): string {
  const oracleContext = frozenTests.length
    ? `\n\nFROZEN TEST BASELINE:\n${frozenTests.join('\n')}\nThese tests were intentionally authored by a separate test lane and committed before implementation began. Do not reject the implementation merely because these files did not exist in the user's original project. Choreo independently verifies that the implementation did not modify them after they froze.`
    : '';
  return `You are an adversarial reviewer in a separate context from the writer. You did not write this code. Your only job is to find bugs and reasons the change does not work.

User task:
${userTask}

Inspect the workspace and this diff. Do not change any files. Do not run git commit. Do not change test files.${oracleContext}

DIFF:
${diff || '(no unstaged diff)'}

The automated tests already passed. You are a second gate and cannot override red tests.

If the changes correctly satisfy the user task without cheating the tests, emit a line that is exactly:
${REVIEW_OK}

Otherwise emit a line that is exactly:
${REVIEW_REJECT}
then a short list of defects.`;
}

export function reviewRetryPrompt(
  originalPrompt: string,
  reviewOutput: string,
): string {
  return `${originalPrompt}

An adversarial reviewer rejected the last patch. Fix the code, not the test. Do not ask questions. Do not git commit.

REVIEW OUTPUT:
${reviewOutput}`;
}

export function parseReviewVerdict(output: string): ReviewVerdict {
  const ok = output.lastIndexOf(REVIEW_OK);
  const reject = output.lastIndexOf(REVIEW_REJECT);
  if (ok === -1 && reject === -1) {
    return 'reject';
  }
  if (reject > ok) {
    return 'reject';
  }
  return 'ok';
}

export function planObjectPrompt(title: string, userPrompt: string): string {
  return `You are the orchestration agent for Choreo. Do not edit files. Do not run git. Do not run tests. Do not ask questions.

Title: ${title}

User task:
${userPrompt}

Split the work so tests and production code are separate items. Prefer that split even if one person could do both — different processes, different context. If the repo already has tests, skip the tests item.

Reply with a JSON object (optionally in a fenced json code block) then a line that is exactly:
PLAN_DONE

The JSON shape:
{"reply":"short message to the user","items":[{"kind":"tests","title":"Write tests","files":["foo.test.js"],"doneWhen":"tests describe the contract","prompt":"author assertions, no production code"},{"kind":"code","title":"Implement","files":["foo.js"],"doneWhen":"tests pass","prompt":"implement without changing tests"}]}`;
}

export function steerPrompt(
  goal: string,
  planJson: string,
  thread: string,
  userText: string,
): string {
  return `You are the orchestration agent for Choreo. Do not edit files. Do not run git. Do not run tests. Do not ask questions.

The user is steering an existing project. Patch the plan to follow their latest message. Keep locked tests locked.

PROJECT GOAL:
${goal}

CURRENT PLAN JSON:
${planJson}

THREAD:
${thread}

LATEST USER MESSAGE:
${userText}

Reply with a JSON object (optionally in a fenced json code block) then a line that is exactly:
PLAN_DONE

The JSON shape:
{"reply":"short message to the user","items":[{"kind":"tests|code","title":"one work item","files":["path"],"doneWhen":"how we know it worked","prompt":"instructions including the latest steering"}]}`;
}

export function steeringAddendum(messages: readonly string[]): string {
  if (messages.length === 0) {
    return '';
  }
  return `\n\nSTEERING FROM THE USER (arrived while you were working, apply it now):\n${messages
    .map((text) => `- ${text}`)
    .join('\n')}`;
}

export function projectWriterPrompt(opts: {
  goal: string;
  itemPrompt: string;
  oraclePaths: readonly string[];
  thread: string;
}): string {
  const tests = opts.oraclePaths.join(', ') || '(none named)';
  return `${opts.itemPrompt}

PROJECT GOAL:
${opts.goal}

LOCKED TESTS: ${tests}
Do not change those files. Do not ask questions. Do not run git commit.

THREAD:
${opts.thread || '(none yet)'}`;
}

export function formatPlanForWriter(plan: PlanObject): string {
  return plan.items
    .map((item, index) => {
      const files = (item.files ?? []).join(', ') || '(unspecified)';
      const done = item.doneWhen ? `; done when ${item.doneWhen}` : '';
      return `${index + 1}. ${item.title} [${files}]${done}`;
    })
    .join('\n');
}

export function parsePlanObject(output: string): PlanObject | null {
  const parsed = extractJsonObject(output);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const rawItems = Array.isArray(record.items) ? record.items : [];
  const items: PlanObject['items'] = [];
  for (const raw of rawItems) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      continue;
    }
    const item = raw as Record<string, unknown>;
    if (typeof item.title !== 'string' || item.title.trim() === '') {
      continue;
    }
    const files = Array.isArray(item.files)
      ? item.files.filter((file): file is string => typeof file === 'string')
      : [];
    items.push({
      title: item.title.trim(),
      files,
      doneWhen:
        typeof item.doneWhen === 'string' ? item.doneWhen : undefined,
      prompt: typeof item.prompt === 'string' ? item.prompt : undefined,
      kind: item.kind === 'tests' || item.kind === 'code' ? item.kind : undefined,
    });
  }
  if (items.length === 0) {
    return null;
  }
  const reply =
    typeof record.reply === 'string' && record.reply.trim() !== ''
      ? record.reply.trim()
      : items[0].title;
  return { reply, items };
}

function extractJsonObject(text: string): unknown | null {
  const candidates: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    candidates.push(match[1]);
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    candidates.push(text.slice(start, end + 1));
  }
  for (const raw of candidates) {
    try {
      return JSON.parse(raw);
    } catch {
      continue;
    }
  }
  return null;
}

export function isTestPath(rel: string): boolean {
  const base = rel.split(/[/\\]/).pop() ?? rel;
  return (
    /\.(test|spec)\.(js|mjs|cjs|ts)$/i.test(base) ||
    /(^test.*|_test|\.test)\.py$/i.test(base)
  );
}

export function inferJobKind(item: {
  kind?: JobKind;
  title?: string;
  files?: string[];
}): JobKind {
  if (item.kind === 'tests' || item.kind === 'code') {
    return item.kind;
  }
  if ((item.files ?? []).some((file) => isTestPath(file))) {
    return 'tests';
  }
  if (/test/i.test(item.title ?? '')) {
    return 'tests';
  }
  return 'code';
}

export function defaultBuildPlan(goal: string): PlanObject {
  return {
    reply:
      'I will write tests and implementation as separate steps. Tests freeze before a SHA is allowed.',
    items: [
      {
        kind: 'tests',
        title: 'Write tests',
        files: [],
        doneWhen: 'Automated tests exist that describe the goal',
        prompt: `Write automated tests only for this goal. Do not implement production code. Do not git commit.

GOAL:
${goal}`,
      },
      {
        kind: 'code',
        title: 'Implement',
        files: [],
        doneWhen: 'The tests pass',
        prompt: `Implement production code so the tests pass. Do not change test files. Do not git commit.

GOAL:
${goal}`,
      },
    ],
  };
}

export function ensureTestsItem(plan: PlanObject, goal: string): PlanObject {
  if (plan.items.some((item) => inferJobKind(item) === 'tests')) {
    return plan;
  }
  const tests = defaultBuildPlan(goal).items[0];
  return {
    reply: plan.reply,
    items: [tests, ...plan.items.map((item) => ({ ...item, kind: inferJobKind(item) }))],
  };
}
