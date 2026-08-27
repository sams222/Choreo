# Person 3 — step-by-step implementation (agent playbook)

You are Person 3. You spawn **Claude** and **Codex** only.

**Read first:** `protocol/index.ts` (`CLIAdapter`, `PROVIDER_COMMANDS`, `CLI_TIMEOUT_MS`), `docs/person-3-cli-adapters.md`, `protocol/examples/cli-run.result.json`.

**Proven on the demo laptop (do not change flags):**

```
claude -p "<prompt>" --output-format text --dangerously-skip-permissions
codex exec --sandbox workspace-write --skip-git-repo-check "<prompt>"
```

**Do not:** Gemini, FakeAdapter, `codex exec resume`, `shell: true`, `node --test`, `git commit`, `--sandbox read-only`, edit `protocol/index.ts`.

**Write only:** `server/src/adapters.ts`  
**Export:** `export function createAdapters(): Record<ProviderType, CLIAdapter>`

---

## Step 1 — Skeleton

```ts
import type { CLIAdapter, ProviderType, RunResult } from '../../protocol/index.ts';
import { PROVIDER_COMMANDS, CLI_TIMEOUT_MS } from '../../protocol/index.ts';

export function createAdapters(): Record<ProviderType, CLIAdapter> {
  return {
    claude: makeAdapter('claude'),
    codex: makeAdapter('codex'),
  };
}
```

One `makeAdapter(provider)` that reads `PROVIDER_COMMANDS[provider].bin` and `.args(prompt)`.

**Verify:** `createAdapters().claude.provider === 'claude'` and same for codex.

---

## Step 2 — Spawn helper

`run(workspaceDir, prompt, onLog, signal): Promise<RunResult>`

1. `cwd` **must** be `workspaceDir` (absolute). Throw if `parse.js` missing.
2. `spawn(bin, args, { cwd: workspaceDir, shell: false, env: process.env, detached: true })`  
   - `args = PROVIDER_COMMANDS[provider].args(prompt)` — prompt is **one argv entry**.
3. On stdout `data` and stderr `data`: `onLog(stripAnsi(chunk.toString()))`.
4. Concatenate all text into `output`.
5. Timeout: `setTimeout` `CLI_TIMEOUT_MS` (120000) → abort.
6. On `signal` abort or timeout: `process.kill(-child.pid, 'SIGTERM')` (process group). If still alive after 2s, `SIGKILL`.
7. Resolve `{ output, exitCode }` where `exitCode` is `child` exit code (`null` signal → use `1`).
8. `exitCode === 0` means the **CLI exited**, not that tests passed.

Return example: `protocol/examples/cli-run.result.json`.

**Verify locally without a model:** `bin: 'node'`, `args: ['-e', 'console.log("pong")']` in a unit helper if you must; then switch back to real bins. Do not leave the fake bin in `createAdapters()`.

---

## Step 3 — ANSI strip

Remove CSI sequences so Person 4’s log pane is readable (`\x1B\[[0-9;]*[A-Za-z]`). Keep newlines.

---

## Step 4 — Codex-specific (from smoke tests)

- Use `exec` subcommand, not interactive TUI.
- `--sandbox workspace-write` is required or `parse.js` will not change.
- `--skip-git-repo-check` because Person 2’s copy is a git repo anyway, but keep the flag.
- Ignore `approval: on-request` in Codex’s banner; do not add extra approval flags unless spawn hangs on a prompt (then tell the team).
- Codex may run `node --test` itself. **You still must not.** Person 1 runs Person 2 after you return.

---

## Step 5 — Claude-specific

- Always `--dangerously-skip-permissions` and `--output-format text`.
- `-p` is the prompt flag (print/headless).

---

## Step 6 — Isolated done-when (real CLIs, Person 2 workspace)

Requires Person 2 `createWorkspace` + the demo laptop logins.

```ts
const git = createGitRuntime(fixtureAbs);
const { dir } = await git.createWorkspace('task_cli_smoke');
const adapters = createAdapters();
const ac = new AbortController();
await adapters.codex.run(
  dir,
  'In parse.js, make parseIndex return text.length so the test expects 5. Do not ask questions. Do not git commit.',
  (t) => process.stdout.write(t),
  ac.signal,
);
const tests = await git.runTests(dir);
// tests.passed === true
```

Repeat with `adapters.claude.run` after resetting `parse.js` to `length - 1` (or new workspace).

If Claude/Codex are not on PATH in CI, skip this step and still ship the spawn wrapper; Person 1 will run it on the demo laptop.

---

## Step 7 — Hand to Person 1

```ts
import { createAdapters } from './adapters.ts';
const adapters = createAdapters();
```

They call `adapters[task.provider].run(dir, prompt, onLog, signal)` twice for retries. You do **not** implement resume.

## Done

- Both adapters share one spawn helper
- Flags match `PROVIDER_COMMANDS`
- Timeout 120s + AbortSignal kills the process group
- No tests, no git, no Gemini
