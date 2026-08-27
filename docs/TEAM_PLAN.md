# LoopGrid — team plan for tomorrow

## What we are building

A local dashboard that sends a **real** coding CLI (Claude or Codex) at a buggy homework folder, runs **our** tests, sends the failure back if needed, and only git-commits when tests pass.

Gemini is **out**. Google shut off individual Gemini CLI. Do not spend time on it. Do not ship a fake robot. Two real providers are enough.

## Proven on the demo laptop (do not rediscover)

```bash
# Claude
claude -p "<task>" --output-format text --dangerously-skip-permissions

# Codex
codex exec --sandbox workspace-write --skip-git-repo-check "<task>"

# Answer key
node --test
```

Both have already edited `/tmp/loopgrid-smoke/parse.js` and made the test pass.

## Who owns what

| Person | Owns | Does not own |
|---|---|---|
| **1 — Orchestrator** | The retry loop, in-memory state, HTTP API | Git internals, CLI flags, React |
| **2 — Git & tests** | Copy/branch homework, `node --test`, diff, commit, reset | Calling Claude/Codex, UI |
| **3 — CLI runners** | Spawn Claude/Codex in a folder, stream logs, timeout, kill | Tests, commit, UI |
| **4 — Dashboard & fixture** | One web page, fixture homework that starts failing | The loop, git, CLI flags |

**Person 1 is the only one who calls Person 2 and Person 3.** Person 4 only talks to Person 1 over HTTP.

## Frozen contract

- Types: [`../protocol/index.ts`](../protocol/index.ts)
- Every HTTP / task / git / CLI payload: [`../protocol/examples/`](../protocol/examples/)

Do not rename JSON keys. If you need a field, shout in the group chat first.

Person 4 may build the UI against `protocol/examples/http-get-state-succeeded.json`. That is a **picture of state**, not a fake agent.

Constants already in protocol: port **4055**, poll **300ms**, CLI timeout **120s**, workspaces `/tmp/loopgrid-workspaces`, default `maxIterations` **2**.

## Suggested folders

```
protocol/          frozen types (already in this repo)
server/
  loop.ts          Person 1
  http.ts          Person 1
  git.ts           Person 2
  adapters.ts      Person 3
web/               Person 4
fixture/           Person 4 (tiny Node homework, zero npm deps)
```

One Node app. Person 1’s server serves Person 4’s page **or** Person 4 runs Vite on another port and proxies `/api` to Person 1. Agree at hour 0: **simplest is Express serving `web/dist` plus `/api`.** If Vite is faster for Person 4, proxy `/api` → `http://127.0.0.1:4055`.

Use port **4055** for the server (not 3000/5173/8080).

## The loop (Person 1 only — everyone else plugs into this)

```
createWorkspace
for attempt 1..maxIterations:
  status = running (or retrying if attempt > 1)
  adapter.run(dir, prompt or prompt+lastError, onLog, signal)
  tests = runTests(dir)
  if tests.passed:
    commitIfDirty
    status = succeeded
    stop
  else:
    lastError = tests.output
    status = retrying
status = failed
```

There is **no** special CLI “resume.” Attempt 2 is a **new process** whose prompt is: original task + test output.

## Day shape (not four independent products)

- **Hour 0:** Scaffold folders. Nobody edits `protocol/index.ts` without the group. Person 4 commits the fixture. Person 1 writes `loop.ts` calling **empty** GitRuntime + CLIAdapter stubs that match the types.
- **Hours 1–3:** Parallel fill-in. Person 1’s loop must run against Person 2 + 3 as soon as those functions exist.
- **Hour 3 checkpoint:** From a terminal (no UI yet): launch Claude or Codex through `loop.ts`, see fail or pass, see a SHA if pass. If this is not true, **stop adding UI features.**
- **Hours 3–5:** Person 4 wires Launch / logs / badge / diff / SHA / Reset to `/api`.
- **Hour 5–6:** Timeouts, Cancel, rehearsal of the demo script three times.

## Demo script (what judges see)

1. Click **Reset**
2. Launch “Fix Off-By-One Index in Array Parser” on Codex or Claude
3. Attempt 1 may fail (Expected 5, got 4) or already pass — both are real
4. If fail: Retrying, then attempt 2
5. **Succeeded**, colored diff, commit SHA

## Group rules

1. Person 1 owns integration. Merge into `server/` through Person 1’s loop, not by inventing a second orchestrator.
2. Agents must **not** git-commit. Person 2 is the only committer. Prompt them: “Do not run git commit. Do not change the test file.”
3. One job at a time is enough. Do not build parallel worktrees unless the loop already works.
4. No Gemini. No fake adapter on stage.
5. If a CLI hangs: Person 3’s `AbortSignal` + timeout (120s). Person 4 has Cancel.

Per-person briefs:

- [Person 1 — Orchestrator](person-1-orchestrator.md)
- [Person 2 — Git & tests](person-2-git-runtime.md)
- [Person 3 — CLI runners](person-3-cli-adapters.md)
- [Person 4 — Dashboard & fixture](person-4-dashboard.md)
