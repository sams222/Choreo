# Track C — CLI runners (Claude + Codex)

**One file for this track.** Builder feeds this to Agent C. Return JSON: `protocol/examples/cli-run.result.json`.

**Writes:** `server/src/adapters.ts` only  
**Export:** `export function createAdapters(): Record<ProviderType, CLIAdapter>`  
**Does not:** Gemini, FakeAdapter, `codex exec resume`, `shell: true`, `node --test`, `git commit`, `--sandbox read-only`, edit `protocol/index.ts`

Use `PROVIDER_COMMANDS` and `CLI_TIMEOUT_MS` (120000) from `protocol/index.ts`.

---

## Contract — argv (proven on the demo laptop)

```
claude -p "<prompt>" --output-format text --dangerously-skip-permissions
codex exec --sandbox workspace-write --skip-git-repo-check "<prompt>"
```

`cwd` = `workspaceDir`. Prompt is **one argv element**.

```ts
run(workspaceDir, prompt, onLog, signal): Promise<{ output: string; exitCode: number }>
```

```json
{ "output": "Done — `parseIndex` now returns `text.length`.\n", "exitCode": 0 }
```

`exitCode === 0` means the **process** exited, not that tests passed. Track A still runs Track B tests. Codex/Claude may run tests themselves; you must not.

| Fact | What you do |
|---|---|
| Codex `approval: on-request` still edited via `exec` + workspace-write | Keep `exec`. No TUI. |
| `read-only` cannot write `parse.js` | Never `read-only` in the loop. |
| Claude pauses without skip-permissions | Always pass the flag. |
| Streaming | stdout + stderr → `onLog`, strip ANSI |
| Hang | 120s then kill process group (`detached: true`, `kill(-pid)`) |
| Attempt 2 | New process. Track A passes `loop-attempt2-prompt.txt`. No `resume`. |

---

## Steps (Phase 2, before Track A `runLoop`)

### Step 1 — Skeleton

```ts
export function createAdapters(): Record<ProviderType, CLIAdapter> {
  return { claude: makeAdapter('claude'), codex: makeAdapter('codex') };
}
```

`makeAdapter` uses `PROVIDER_COMMANDS[provider].bin` and `.args(prompt)`.

### Step 2 — Spawn

Throw if `parse.js` missing in `workspaceDir`. Pipe both stdio. Concatenate `output`. Abort/timeout → SIGTERM then SIGKILL.

### Step 3 — Strip ANSI (`\x1B\[[0-9;]*[A-Za-z]`).

### Step 4–5 — Codex / Claude flags as in the contract. Codex may `node --test`; you still must not.

### Step 6 — Isolated check (demo laptop + Track B workspace)

```ts
await adapters.codex.run(dir, 'In parse.js, make parseIndex return text.length so the test expects 5. Do not ask questions. Do not git commit.', onLog, signal)
// git.runTests(dir).passed === true
```

Repeat Claude on a fresh copy. If CLIs missing in CI, still ship the wrapper.

### Step 7 — Hand to Track A

```ts
const adapters = createAdapters();
adapters[task.provider].run(dir, prompt, onLog, signal)
```

---

## Done

Shared spawn helper, frozen flags, 120s kill, no Gemini. Then Track A may wire `runLoop`.
