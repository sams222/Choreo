# LoopSync — team plan for tomorrow

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

Both have already edited `/tmp/loopsync-smoke/parse.js` and made the test pass.

## How we work now

**One Builder** drives Cursor agents and pushes `main`. Everyone else **debugs** (curl, CLIs, UI) or **plans the presentation**. The four “people” in the contracts are **agent tracks**, not four coders.

Phased plan, gates, and parallel graphs: **[BUILD_PLAN.md](BUILD_PLAN.md)**.

## Who owns what (agent tracks)

| Track | Playbook | Writes | Human at the merge |
|---|---|---|---|
| **A — Orchestrator** | [person-1-orchestrator.md](person-1-orchestrator.md) | HTTP + `runLoop` + state | Builder |
| **B — Git & tests** | [person-2-git-runtime.md](person-2-git-runtime.md) | `server/src/git.ts` | Builder |
| **C — CLI runners** | [person-3-cli-adapters.md](person-3-cli-adapters.md) | `server/src/adapters.ts` | Builder |
| **D — Dashboard & fixture** | [person-4-dashboard.md](person-4-dashboard.md) | `web/`, fixture git | Builder |

Each file is **contract + steps**. Do not keep a second copy. Launch agents from these four files, not from four laptops.

## Frozen contract

- Types: [`../protocol/index.ts`](../protocol/index.ts)
- Every HTTP / task / git / CLI payload: [`../protocol/examples/`](../protocol/examples/)

Do not rename JSON keys. If you need a field, shout in the group chat first.

Track D may mock the UI against `protocol/examples/http-get-state-succeeded.json`. That is a **picture of state**, not a fake agent.

Constants already in protocol: port **4055**, poll **300ms**, CLI timeout **120s**, workspaces `/tmp/loopsync-workspaces`, default `maxIterations` **2**.

## Suggested folders

```
protocol/          frozen types (already in this repo)
server/src/loop.ts, http.ts, state.ts   Track A
server/src/git.ts                       Track B
server/src/adapters.ts                  Track C
web/                                    Track D
fixture/                                Track D (tiny Node homework, zero npm deps)
```

One Node app. Track A’s server serves Track D’s `web/` as static files on **:4055**.

Use port **4055** for the server (not 3000/5173/8080).

## The loop (Track A — everyone else plugs into this)

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

## Day shape

Follow **[BUILD_PLAN.md](BUILD_PLAN.md)** phases 0–4. Short version:

- **Phase 0:** Agent A HTTP skeleton. Gate = empty `GET /api/state`.
- **Phase 1:** Agent B git + Agent D fixture **in parallel**. Gate = `node --test` fails on a copy; commit SHA without a coding CLI.
- **Phase 2:** Agent C adapters, then Agent A `runLoop`. Gate = curl launch → real Codex/Claude → SHA or TAP. **No UI until this passes.**
- **Phase 3:** Agent D dashboard. Gate = Reset → Launch → badge + SHA.
- **Phase 4:** humans harden + three rehearsals. Presenters own the talk; Builder only crash-fixes.

Presenters work from Phase 0. Debuggers own every gate.

## Demo script (what judges see)

1. Click **Reset**
2. Launch “Fix Off-By-One Index in Array Parser” on Codex or Claude
3. Attempt 1 may fail (Expected 5, got 4) or already pass — both are real
4. If fail: Retrying, then attempt 2
5. **Succeeded**, colored diff, commit SHA

## Group rules

1. Track A owns integration. Merge into `server/` through `runLoop`, not a second orchestrator.
2. Coding agents must **not** `git commit`. Track B is the only committer. Prompt: “Do not run git commit. Do not change the test file.”
3. One job at a time. No worktrees unless the loop already works.
4. No Gemini. No fake adapter on stage.
5. If a CLI hangs: Track C `AbortSignal` + 120s. Track D has Cancel.

Agent tracks:

- [Track A — Orchestrator](person-1-orchestrator.md)
- [Track B — Git & tests](person-2-git-runtime.md)
- [Track C — CLI runners](person-3-cli-adapters.md)
- [Track D — Dashboard & fixture](person-4-dashboard.md)
