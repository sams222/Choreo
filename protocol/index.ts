/**
 * LOOPSYNC FROZEN PROTOCOL
 * Do not change field names without a team shout in the group chat.
 * JSON examples live in protocol/examples/. Person 1–4 all code against this file.
 */

export type ProviderType = 'claude' | 'codex';

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'retrying'
  | 'succeeded'
  | 'failed';

export type StepId = 'writer' | 'tests' | 'review' | 'git';
export type StepStatus = 'pending' | 'running' | 'ok' | 'fail' | 'skipped';

export interface StepState {
  id: StepId;
  status: StepStatus;
}

export type ReviewVerdict = 'ok' | 'reject';

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
}

export interface ProviderSlot {
  provider: ProviderType;
  isBusy: boolean;
}

export interface ServerSnapshot {
  tasks: TaskState[];
  slots: ProviderSlot[];
}

export interface RunResult {
  output: string;
  exitCode: number;
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
  ): Promise<RunResult>;
}

/** Person 2 implements. Person 1 calls. */
export interface GitRuntime {
  createWorkspace(taskId: string): Promise<WorkspaceHandle>;
  runTests(dir: string): Promise<TestResult>;
  getDiff(dir: string): Promise<string>;
  commitIfDirty(dir: string, message: string): Promise<CommitResult | null>;
  resetAll(): Promise<void>;
  /** True if oracle paths (parse.test.js) differ from the fixture baseline. */
  checkOracle(dir: string): Promise<{ dirty: boolean; oracleSha: string }>;
}

export interface LaunchTaskBody {
  title: string;
  prompt: string;
  provider: ProviderType;
  maxIterations?: number;
  orchestratorProvider?: ProviderType;
  reviewerProvider?: ProviderType;
}

export interface LaunchTaskResponse {
  taskId: string;
}

export interface OkResponse {
  ok: true;
}

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNKNOWN_PROVIDER'
  | 'SLOT_BUSY'
  | 'TASK_NOT_FOUND'
  | 'RESET_FAILED'
  | 'ORACLE_TAMPERED'
  | 'CAP_EXHAUSTED';

export interface ErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
  };
}

export const PORT = 4055;
export const POLL_MS = 300;
export const CLI_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_ITERATIONS = 2;
export const WORKSPACE_ROOT = '/tmp/loopsync-workspaces';
export const ORACLE_PATHS = ['parse.test.js'] as const;
export const REVIEW_OK = 'REVIEW_OK';
export const REVIEW_REJECT = 'REVIEW_REJECT';

export const DEFAULT_LAUNCH: LaunchTaskBody = {
  title: 'Fix Off-By-One Index in Array Parser',
  prompt:
    'The test in parse.test.js fails. Make parseIndex return the correct value so the test passes. Do not change the test. Do not ask questions. Do not run git commit.',
  provider: 'codex',
  maxIterations: 2,
};

export const HTTP = {
  getState: 'GET /api/state',
  launch: 'POST /api/tasks',
  cancel: 'POST /api/tasks/:id/cancel',
  reset: 'POST /api/reset',
} as const;

/** Proven argv on the demo laptop. Person 3 must use these. */
export const PROVIDER_COMMANDS = {
  claude: {
    bin: 'claude',
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
  return `You are the orchestration agent for LoopSync. Do not edit files. Do not run git. Do not run tests. Do not ask questions.

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

export function reviewPrompt(diff: string): string {
  return `You are an adversarial reviewer in a separate context from the writer. You did not write this code. Your only job is to find bugs and reasons the change does not work.

Read parse.js, parse.test.js, and this diff. Do not change any files. Do not run git commit. Do not change the test.

DIFF:
${diff || '(no unstaged diff)'}

The tests already passed. You are a second gate. You cannot override red tests (you are not invoked when tests fail).

If production code correctly makes parseIndex('abcde') === 5 without changing the test, emit a line that is exactly:
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
