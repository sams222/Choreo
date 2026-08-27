/**
 * P0.1 — turn the CLIs' JSON event streams into typed AgentEvents.
 *
 * `claude -p --output-format stream-json --verbose` and `codex exec --json`
 * both emit JSONL. The shapes differ and codex's has moved between releases,
 * so this parser is deliberately tolerant: anything it cannot recognise falls
 * back to a plain `text` event, which is exactly what the old text mode gave us.
 */
import type {
  AgentEvent,
  AgentEventKind,
  AgentRole,
  AgentUsage,
  ProviderType,
} from '../../protocol/index.ts';

export interface ParsedChunk {
  events: AgentEvent[];
  /** Text to accumulate into RunResult.output for the existing parsers. */
  output: string;
  usage?: AgentUsage;
}

export interface EventParser {
  push(chunk: string): ParsedChunk;
  flush(): ParsedChunk;
  usage(): AgentUsage | undefined;
}

const EMPTY: ParsedChunk = { events: [], output: '' };

let seq = 0;

function nextId(): string {
  seq += 1;
  return `ev_${Date.now().toString(36)}_${seq.toString(36)}`;
}

function shorten(value: string, limit = 160): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/** Trim an absolute workspace path down to what a judge can read. */
export function relativise(target: string, workspaceDir?: string): string {
  if (!target) {
    return '';
  }
  let out = target;
  if (workspaceDir && out.startsWith(workspaceDir)) {
    out = out.slice(workspaceDir.length).replace(/^[/\\]+/, '');
  }
  return out || target;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Pull the most demo-legible argument out of a tool_use input block. */
export function toolTarget(
  tool: string,
  input: Record<string, unknown> | null,
): string {
  if (!input) {
    return '';
  }
  for (const key of [
    'file_path',
    'filePath',
    'path',
    'notebook_path',
    'command',
    'cmd',
    'pattern',
    'query',
    'url',
    'description',
  ]) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
    if (Array.isArray(value)) {
      const joined = value.filter((item) => typeof item === 'string').join(' ');
      if (joined.trim() !== '') {
        return joined.trim();
      }
    }
  }
  return '';
}

export function createEventParser(opts: {
  provider: ProviderType;
  role: AgentRole;
  format: 'claude-jsonl' | 'codex-jsonl' | 'text';
  workspaceDir?: string;
}): EventParser {
  const { provider, role, format, workspaceDir } = opts;
  let buffer = '';
  let usage: AgentUsage | undefined;
  /** Everything already folded into `output`, so we never duplicate a JSON blob. */
  let accumulated = '';

  const make = (
    kind: AgentEventKind,
    text: string,
    extra?: Partial<AgentEvent>,
  ): AgentEvent => ({
    id: nextId(),
    ts: Date.now(),
    provider,
    role,
    kind,
    text,
    ...extra,
  });

  function claudeLine(record: Record<string, unknown>): ParsedChunk {
    const type = str(record.type);
    const events: AgentEvent[] = [];
    let output = '';

    if (type === 'system') {
      const model = str(record.model);
      events.push(
        make('start', model ? `session started · ${model}` : 'session started'),
      );
      return { events, output };
    }

    if (type === 'assistant' || type === 'user') {
      const message = asRecord(record.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const raw of content) {
        const block = asRecord(raw);
        if (!block) continue;
        const blockType = str(block.type);
        if (blockType === 'text') {
          const text = str(block.text);
          if (text.trim() !== '') {
            events.push(make('text', shorten(text, 400)));
            output += `${text}\n`;
          }
        } else if (blockType === 'thinking') {
          const text = str(block.thinking);
          if (text.trim() !== '') {
            events.push(make('reasoning', shorten(text, 240)));
          }
        } else if (blockType === 'tool_use') {
          const tool = str(block.name) || 'tool';
          const target = relativise(
            toolTarget(tool, asRecord(block.input)),
            workspaceDir,
          );
          events.push(
            make('tool', target ? `${tool} ${shorten(target, 90)}` : tool, {
              tool,
              target: shorten(target, 120),
            }),
          );
        } else if (blockType === 'tool_result') {
          const isError = block.is_error === true;
          if (isError) {
            events.push(
              make('error', shorten(stringifyContent(block.content), 200), {
                isError: true,
              }),
            );
          }
        }
      }
      return { events, output };
    }

    if (type === 'result') {
      const durationMs = num(record.duration_ms);
      const costUsd = num(record.total_cost_usd);
      const numTurns = num(record.num_turns);
      usage = { durationMs, costUsd, numTurns };
      const final = str(record.result);
      if (final.trim() !== '' && !accumulated.includes(final.trim())) {
        output += `${final}\n`;
      }
      const isError = record.is_error === true;
      events.push(
        make('result', isError ? 'run reported an error' : 'run finished', {
          durationMs,
          costUsd,
          numTurns,
          isError,
        }),
      );
      return { events, output, usage };
    }

    return EMPTY;
  }

  function stringifyContent(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      return value
        .map((item) => {
          const block = asRecord(item);
          return block ? str(block.text) : '';
        })
        .filter(Boolean)
        .join('\n');
    }
    return '';
  }

  function codexLine(record: Record<string, unknown>): ParsedChunk {
    // Newer codex: {"type":"item.completed","item":{...}}
    const outer = str(record.type);
    if (outer.startsWith('item.') || outer.startsWith('turn.')) {
      return codexItem(outer, record);
    }
    // Older codex: {"id":"0","msg":{"type":"agent_message",...}}
    const msg = asRecord(record.msg) ?? record;
    return codexMsg(msg);
  }

  function codexItem(
    outer: string,
    record: Record<string, unknown>,
  ): ParsedChunk {
    const events: AgentEvent[] = [];
    let output = '';
    if (outer === 'turn.completed') {
      const u = asRecord(record.usage);
      usage = {
        numTurns: num(u?.num_turns),
        costUsd: num(u?.total_cost_usd),
      };
      events.push(make('result', 'turn finished', { numTurns: usage.numTurns }));
      return { events, output, usage };
    }
    if (outer === 'turn.failed' || outer === 'error') {
      events.push(
        make('error', shorten(str(record.message) || 'turn failed', 200), {
          isError: true,
        }),
      );
      return { events, output };
    }
    const item = asRecord(record.item);
    if (!item) {
      return EMPTY;
    }
    const kind = str(item.type);
    if (kind === 'assistant_message' || kind === 'agent_message') {
      const text = str(item.text) || str(item.message);
      if (text.trim() !== '' && outer === 'item.completed') {
        events.push(make('text', shorten(text, 400)));
        output += `${text}\n`;
      }
      return { events, output };
    }
    if (kind === 'reasoning') {
      const text = str(item.text) || str(item.summary);
      if (text.trim() !== '' && outer === 'item.completed') {
        events.push(make('reasoning', shorten(text, 240)));
      }
      return { events, output };
    }
    if (kind === 'command_execution') {
      if (outer !== 'item.started') {
        return EMPTY;
      }
      const command = str(item.command) || str(item.cmd);
      events.push(
        make('tool', `ran ${shorten(command, 90)}`, {
          tool: 'shell',
          target: shorten(command, 120),
        }),
      );
      return { events, output };
    }
    if (kind === 'file_change' || kind === 'patch') {
      if (outer !== 'item.completed') {
        return EMPTY;
      }
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes
        .map((change) => relativise(str(asRecord(change)?.path), workspaceDir))
        .filter(Boolean);
      const label = paths.join(', ') || 'files';
      events.push(
        make('tool', `edited ${shorten(label, 90)}`, {
          tool: 'apply_patch',
          target: shorten(label, 120),
        }),
      );
      return { events, output };
    }
    return EMPTY;
  }

  function codexMsg(msg: Record<string, unknown>): ParsedChunk {
    const type = str(msg.type);
    const events: AgentEvent[] = [];
    let output = '';

    switch (type) {
      case 'task_started':
      case 'session_configured': {
        events.push(make('start', 'session started'));
        break;
      }
      case 'agent_message': {
        const text = str(msg.message) || str(msg.text);
        if (text.trim() !== '') {
          events.push(make('text', shorten(text, 400)));
          output += `${text}\n`;
        }
        break;
      }
      case 'agent_reasoning': {
        const text = str(msg.text) || str(msg.reasoning);
        if (text.trim() !== '') {
          events.push(make('reasoning', shorten(text, 240)));
        }
        break;
      }
      case 'exec_command_begin': {
        const command = Array.isArray(msg.command)
          ? msg.command.filter((part) => typeof part === 'string').join(' ')
          : str(msg.command);
        events.push(
          make('tool', `ran ${shorten(stripShellWrapper(command), 90)}`, {
            tool: 'shell',
            target: shorten(stripShellWrapper(command), 120),
          }),
        );
        break;
      }
      case 'exec_command_end': {
        const exitCode = num(msg.exit_code);
        if (exitCode !== undefined && exitCode !== 0) {
          events.push(
            make('error', `command exited ${exitCode}`, { isError: true }),
          );
        }
        break;
      }
      case 'patch_apply_begin': {
        const changes = asRecord(msg.changes);
        const paths = changes
          ? Object.keys(changes).map((key) => relativise(key, workspaceDir))
          : [];
        const label = paths.join(', ') || 'files';
        events.push(
          make('tool', `edited ${shorten(label, 90)}`, {
            tool: 'apply_patch',
            target: shorten(label, 120),
          }),
        );
        break;
      }
      case 'mcp_tool_call_begin': {
        const invocation = asRecord(msg.invocation);
        const tool = str(invocation?.tool) || 'mcp';
        events.push(make('tool', tool, { tool }));
        break;
      }
      case 'token_count': {
        // Token accounting is noise in the feed; kept out of the event stream.
        return EMPTY;
      }
      case 'task_complete': {
        const final = str(msg.last_agent_message);
        if (final.trim() !== '' && !accumulated.includes(final.trim())) {
          output += `${final}\n`;
        }
        events.push(make('result', 'run finished'));
        break;
      }
      case 'error':
      case 'stream_error': {
        events.push(
          make('error', shorten(str(msg.message) || 'error', 200), {
            isError: true,
          }),
        );
        break;
      }
      default:
        return EMPTY;
    }
    return { events, output, usage };
  }

  function line(raw: string): ParsedChunk {
    const trimmed = raw.trim();
    if (trimmed === '') {
      return EMPTY;
    }
    if (format !== 'text' && trimmed.startsWith('{')) {
      let record: Record<string, unknown> | null = null;
      try {
        record = asRecord(JSON.parse(trimmed));
      } catch {
        record = null;
      }
      if (record) {
        return format === 'claude-jsonl' ? claudeLine(record) : codexLine(record);
      }
    }
    // Not JSON (text mode, a banner line, or a partial write): keep it visible.
    return {
      events: [make('text', shorten(trimmed, 300))],
      output: `${raw}\n`,
    };
  }

  function drain(chunk: string): ParsedChunk {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    const events: AgentEvent[] = [];
    let output = '';
    for (const part of parts) {
      const result = line(part);
      events.push(...result.events);
      output += result.output;
    }
    accumulated += output;
    return { events, output, usage };
  }

  return {
    push(chunk) {
      return drain(chunk);
    },
    flush() {
      if (buffer.trim() === '') {
        buffer = '';
        return { events: [], output: '', usage };
      }
      const rest = buffer;
      buffer = '';
      const result = line(rest);
      accumulated += result.output;
      return { ...result, usage };
    },
    usage() {
      return usage;
    },
  };
}

function stripShellWrapper(command: string): string {
  return command
    .replace(/^(?:\/usr\/bin\/)?(?:ba|z|)sh\s+-l?c\s+/, '')
    .replace(/^["']|["']$/g, '');
}

/** Short human label for a single event, used by the live activity feed. */
export function describeEvent(event: AgentEvent): string {
  if (event.kind === 'tool') {
    return event.target ? `${event.tool ?? 'tool'} · ${event.target}` : event.text;
  }
  return event.text;
}
