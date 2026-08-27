import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CLI_TIMEOUT_MS,
  PROVIDER_COMMANDS,
  type CLIAdapter,
  type ProviderType,
  type RunResult,
} from '../../protocol/index.ts';

const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/g;
const SIGKILL_DELAY_MS = 2_000;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // already exited
  }
}

function spawnCli(
  bin: string,
  args: readonly string[],
  workspaceDir: string,
  onLog: (text: string) => void,
  signal: AbortSignal,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], {
      cwd: workspaceDir,
      shell: false,
      env: process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let settled = false;
    let killing = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = () => {
      abortChild();
    };

    const cleanup = () => {
      clearTimeout(timeoutId);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      signal.removeEventListener('abort', onAbort);
    };

    const finish = (exitCode: number) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve({ output, exitCode });
    };

    const abortChild = () => {
      if (killing) {
        return;
      }
      killing = true;
      if (child.pid === undefined) {
        return;
      }
      killProcessGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => {
        if (child.pid !== undefined) {
          killProcessGroup(child.pid, 'SIGKILL');
        }
      }, SIGKILL_DELAY_MS);
    };

    const timeoutId = setTimeout(() => {
      abortChild();
    }, CLI_TIMEOUT_MS);

    if (signal.aborted) {
      abortChild();
    } else {
      signal.addEventListener('abort', onAbort);
    }

    const onChunk = (chunk: Buffer | string) => {
      const text = stripAnsi(String(chunk));
      output += text;
      onLog(text);
    };

    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    child.on('error', (err) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(err);
    });

    child.on('close', (code) => {
      finish(code ?? 1);
    });
  });
}

function makeAdapter(provider: ProviderType): CLIAdapter {
  const command = PROVIDER_COMMANDS[provider];
  return {
    provider,
    run(workspaceDir, prompt, onLog, signal) {
      if (!fs.existsSync(path.join(workspaceDir, 'parse.js'))) {
        throw new Error(`parse.js missing in ${workspaceDir}`);
      }
      return spawnCli(
        command.bin,
        command.args(prompt),
        workspaceDir,
        onLog,
        signal,
      );
    },
  };
}

export function createAdapters(): Record<ProviderType, CLIAdapter> {
  return {
    claude: makeAdapter('claude'),
    codex: makeAdapter('codex'),
  };
}
