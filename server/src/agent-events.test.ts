import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEventParser, relativise, toolTarget } from './agent-events.ts';

function claudeParser() {
  return createEventParser({
    provider: 'claude',
    role: 'writer',
    format: 'claude-jsonl',
    workspaceDir: '/tmp/ws',
  });
}

test('claude stream-json yields tool, text and result events', () => {
  const parser = claudeParser();
  const first = parser.push(
    `${JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-5' })}\n`,
  );
  assert.equal(first.events[0]?.kind, 'start');

  const second = parser.push(
    `${JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Adding the failing case.' },
          {
            type: 'tool_use',
            name: 'Edit',
            input: { file_path: '/tmp/ws/sqrt.test.js' },
          },
        ],
      },
    })}\n`,
  );
  assert.equal(second.events[0]?.kind, 'text');
  assert.match(second.output, /Adding the failing case/);
  const tool = second.events[1];
  assert.equal(tool?.kind, 'tool');
  assert.equal(tool?.tool, 'Edit');
  assert.equal(tool?.target, 'sqrt.test.js');

  const third = parser.push(
    `${JSON.stringify({
      type: 'result',
      subtype: 'success',
      duration_ms: 4200,
      num_turns: 3,
      total_cost_usd: 0.0123,
      result: 'PLAN_DONE',
    })}\n`,
  );
  const result = third.events.at(-1);
  assert.equal(result?.kind, 'result');
  assert.equal(result?.durationMs, 4200);
  assert.equal(parser.usage()?.costUsd, 0.0123);
  assert.match(third.output, /PLAN_DONE/);
});

test('claude result text is not duplicated into the output', () => {
  const parser = claudeParser();
  parser.push(
    `${JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'REVIEW_OK' }] },
    })}\n`,
  );
  const second = parser.push(
    `${JSON.stringify({ type: 'result', result: 'REVIEW_OK' })}\n`,
  );
  assert.equal(second.output.includes('REVIEW_OK'), false);
});

test('codex JSONL is understood in both the msg and item shapes', () => {
  const parser = createEventParser({
    provider: 'codex',
    role: 'writer',
    format: 'codex-jsonl',
    workspaceDir: '/tmp/ws',
  });
  const legacy = parser.push(
    `${JSON.stringify({
      id: '0',
      msg: { type: 'exec_command_begin', command: ['bash', '-lc', 'node --test'] },
    })}\n${JSON.stringify({
      id: '1',
      msg: { type: 'patch_apply_begin', changes: { '/tmp/ws/sqrt.js': { update: {} } } },
    })}\n${JSON.stringify({
      id: '2',
      msg: { type: 'agent_message', message: 'Implemented integerSqrt.' },
    })}\n`,
  );
  assert.deepEqual(
    legacy.events.map((event) => event.kind),
    ['tool', 'tool', 'text'],
  );
  assert.equal(legacy.events[0].target, 'node --test');
  assert.equal(legacy.events[1].target, 'sqrt.js');
  assert.match(legacy.output, /Implemented integerSqrt/);

  const modern = parser.push(
    `${JSON.stringify({
      type: 'item.started',
      item: { type: 'command_execution', command: 'node --test' },
    })}\n${JSON.stringify({
      type: 'item.completed',
      item: { type: 'assistant_message', text: 'done' },
    })}\n`,
  );
  assert.deepEqual(
    modern.events.map((event) => event.kind),
    ['tool', 'text'],
  );
});

test('unparseable output still reaches the feed and the output buffer', () => {
  const parser = createEventParser({
    provider: 'codex',
    role: 'writer',
    format: 'codex-jsonl',
  });
  const parsed = parser.push('plain banner line\n{not json}\n');
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.events[0].kind, 'text');
  assert.match(parsed.output, /plain banner line/);
});

test('a partial line is buffered until the newline arrives', () => {
  const parser = claudeParser();
  const head = parser.push('{"type":"assistant","message":{"content":[{"type":"te');
  assert.equal(head.events.length, 0);
  const tail = parser.push('xt","text":"split across chunks"}]}}\n');
  assert.equal(tail.events[0]?.kind, 'text');
  assert.match(tail.output, /split across chunks/);
});

test('flush emits whatever is left without a trailing newline', () => {
  const parser = claudeParser();
  parser.push('{"type":"assistant","message":{"content":[{"type":"text","text":"tail"}]}}');
  const flushed = parser.flush();
  assert.match(flushed.output, /tail/);
  assert.equal(parser.flush().events.length, 0);
});

test('toolTarget and relativise pick readable labels', () => {
  assert.equal(toolTarget('Bash', { command: 'node --test' }), 'node --test');
  assert.equal(toolTarget('Edit', { file_path: 'a.js', command: 'x' }), 'a.js');
  assert.equal(toolTarget('Unknown', {}), '');
  assert.equal(relativise('/tmp/ws/a/b.js', '/tmp/ws'), 'a/b.js');
  assert.equal(relativise('b.js', '/tmp/ws'), 'b.js');
});
