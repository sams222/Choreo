/**
 * LOOPGRID FROZEN PROTOCOL
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
}

export interface LaunchTaskBody {
  title: string;
  prompt: string;
  provider: ProviderType;
  maxIterations?: number;
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
  | 'RESET_FAILED';

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
