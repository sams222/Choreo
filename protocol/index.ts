/**
 * LOOPGRID FROZEN PROTOCOL
 * Do not change field names without a team shout in the group chat.
 * Everyone copies or imports this file. Person 1, 2, 3, 4 all code against it.
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

export interface ServerSnapshot {
  tasks: TaskState[];
  slots: { provider: ProviderType; isBusy: boolean }[];
}

export interface RunResult {
  output: string;
  exitCode: number;
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
  createWorkspace(taskId: string): Promise<{ dir: string; branch: string }>;
  runTests(dir: string): Promise<{ passed: boolean; output: string }>;
  getDiff(dir: string): Promise<string>;
  commitIfDirty(
    dir: string,
    message: string,
  ): Promise<{ sha: string; diff: string } | null>;
  resetAll(): Promise<void>;
}

/**
 * HTTP contract (Person 1 serves, Person 4 consumes).
 * Poll GET /api/state every 300ms. Do not require Socket.IO.
 */
export interface LaunchTaskBody {
  title: string;
  prompt: string;
  provider: ProviderType;
  maxIterations?: number;
}

export interface LaunchTaskResponse {
  taskId: string;
}

export const HTTP = {
  getState: 'GET /api/state',
  launch: 'POST /api/tasks',
  cancel: 'POST /api/tasks/:id/cancel',
  reset: 'POST /api/reset',
} as const;

/** Proven argv. Person 3 must use these unless the group agrees otherwise. */
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
