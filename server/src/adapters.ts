import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import {
  CLI_TIMEOUT_MS,
  PROVIDER_COMMANDS,
  PROVIDER_COMMANDS_PLAIN,
  type AgentEvent,
  type AgentRole,
  type CLIAdapter,
  type ProviderType,
  type RunResult,
} from '../../protocol/index.ts';
import { createEventParser } from './agent-events.ts';

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

function commandsFor(provider: ProviderType) {
  const plain = process.env.LOOPSYNC_PLAIN_CLI === '1';
  return plain ? PROVIDER_COMMANDS_PLAIN[provider] : PROVIDER_COMMANDS[provider];
}

function spawnCli(opts: {
  bin: string;
  args: readonly string[];
  workspaceDir: string;
  provider: ProviderType;
  role: AgentRole;
  format: 'claude-jsonl' | 'codex-jsonl' | 'text';
  onLog: (text: string) => void;
  onEvent?: (event: AgentEvent) => void;
  signal: AbortSignal;
}): Promise<RunResult> {
  const { bin, args, workspaceDir, provider, role, format, onLog, onEvent, signal } =
    opts;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], {
      cwd: workspaceDir,
      shell: false,
      env: process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const parser = createEventParser({ provider, role, format, workspaceDir });
    const events: AgentEvent[] = [];
    let output = '';
    let settled = false;
    let killing = false;
    let timedOut = false;
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

    const absorb = (parsed: ReturnType<typeof parser.push>) => {
      output += parsed.output;
      if (parsed.output) {
        onLog(parsed.output);
      }
      for (const event of parsed.events) {
        events.push(event);
        onEvent?.(event);
      }
    };

    const finish = (exitCode: number) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      absorb(parser.flush());
      resolve({
        output,
        exitCode,
        timedOut,
        events,
        usage: parser.usage(),
      });
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
      timedOut = true;
      abortChild();
    }, CLI_TIMEOUT_MS);

    if (signal.aborted) {
      abortChild();
    } else {
      signal.addEventListener('abort', onAbort);
    }

    const onChunk = (chunk: Buffer | string) => {
      absorb(parser.push(stripAnsi(String(chunk))));
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
  return {
    provider,
    run(workspaceDir, prompt, onLog, signal, onEvent) {
      if (!fs.existsSync(workspaceDir) || !fs.statSync(workspaceDir).isDirectory()) {
        throw new Error(`workspace missing: ${workspaceDir}`);
      }
      const command = commandsFor(provider);
      return spawnCli({
        bin: command.bin,
        args: command.args(prompt),
        workspaceDir,
        provider,
        // The caller re-stamps the role it asked for; 'writer' is the default.
        role: 'writer',
        format: command.stream,
        onLog,
        onEvent,
        signal,
      });
    },
  };
}

export function createAdapters(): Record<ProviderType, CLIAdapter> {
  return {
    claude: makeAdapter('claude'),
    codex: makeAdapter('codex'),
  };
}
