# Person 3 — CLI runners (Claude + Codex)

You wrap two commands that **already worked** on the demo laptop. JSON you return: [`cli-run.result.json`](../protocol/examples/cli-run.result.json).

Gemini is dead (`IneligibleTierError` / Antigravity). Do not add it.

## Frozen argv (from `PROVIDER_COMMANDS`)

Claude (pong + file fix both succeeded with these flags):

```
claude -p "<prompt>" --output-format text --dangerously-skip-permissions
```

Codex (pong + file fix succeeded; **must** be `workspace-write`, not `read-only`):

```
codex exec --sandbox workspace-write --skip-git-repo-check "<prompt>"
```

`cwd` = `workspaceDir`. `shell: false`. Prompt is **one argv element**, never interpolated into bash.

## `run()` signature

```ts
run(workspaceDir: string, prompt: string, onLog: (text: string) => void, signal: AbortSignal)
  => Promise<{ output: string; exitCode: number }>
```

Return example:

```json
{
  "output": "Done — `parseIndex` now returns `text.length`.\n",
  "exitCode": 0
}
```

`exitCode === 0` means the **CLI process** exited. It does **not** mean tests passed. Codex/Claude may run `node --test` themselves (they did in the smoke tests). Person 1 still runs Person 2’s tests after you return. Do not call `node --test` or `git commit` in the adapter.

## Spawn details that bit us

| Fact | What you do |
|---|---|
| Codex `approval: on-request` still edited without a TTY prompt when we used `codex exec` + workspace-write | Keep `exec`. Do not use interactive `codex` TUI. |
| Codex read-only sandbox cannot write `parse.js` | Never pass `--sandbox read-only` in the loop. |
| Claude needed `--dangerously-skip-permissions` or it may pause | Always pass it. |
| Streaming | Pipe stdout **and** stderr. Each `onLog` chunk can be a line. Strip ANSI (`\x1B[...m`) if the dashboard shows garbage. |
| Timeout | 120s then `AbortSignal` / kill. |
| Kill | `spawn` with `detached: true` or process group; on abort `process.kill(-pid)` so children die. |
| `TERM=dumb` | Fine. Do not allocate a PTY. |
| Attempt 2 | New process. Person 1 passes the full string in `loop-attempt2-prompt.txt`. You do not call `codex exec resume`. |

## What the CLIs did on a good run (so you can recognize success in logs)

Codex: `apply patch` on `parse.js`, `text.length - 1` → `text.length`, then it ran tests itself.

Claude: printed `Done — parseIndex now returns text.length.` then Person 1’s `node --test` passed.

If `onLog` never fires and you only return at the end, Person 4’s log pane stays blank until exit — still acceptable, but line-by-line is better.

## Isolated done-when

Person 2 workspace with the known bug:

```ts
await adapters.codex.run(dir, 'In parse.js, make parseIndex return text.length so the test expects 5. Do not ask questions.', console.log, ac.signal)
await adapters.claude.run(dir, '…same…', console.log, ac.signal)
```

Then Person 2 `runTests(dir).passed === true`.

## Do not

- Gemini / FakeAdapter
- `shell: true`
- Session resume APIs
- Changing protocol field names
