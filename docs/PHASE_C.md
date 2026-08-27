# LoopSync — Phase C (2026 loop engineering)

Sequel to [`BUILD_PLAN.md`](BUILD_PLAN.md) phases 0–4. **Do not start this until Gate 2 is true.** The kernel from Tracks A–C stays; this wraps it with independent **steps**, a locked oracle, caps, an optional reviewer agent, and (later) a queue.

Agent playbook: [`person-5-phase-c.md`](person-5-phase-c.md). Kernel workflow: [`WORKFLOW.md`](WORKFLOW.md).

---

## Problem

Phases 0–4 ship a demo kernel: one user Launch, one writer CLI, `node --test` as judge, at most `maxIterations` retries, commit only if tests pass. That is the right inner mechanism. It is not 2026 loop engineering: unattended work, independent checker vs maker, tamper-proof tests, caps/audit, a separate audit agent.

Phase C keeps `runLoop` as the only executor. Node still spawns every step. Recursive spawn (a CLI starts a subagent that starts another LoopSync loop) is **stretch**, not this phase.

---

## Prerequisite: what must already exist (Gate 2)

Phase C **compensates** for the kernel; it does not rebuild HTTP, git copy, or CLI argv. Before attaching person-5, this inventory must be true.

### Expected tree (after `BUILD_PLAN` Gate 2)

| Path | Role at Gate 2 |
|---|---|
| `protocol/index.ts` | Frozen keys: `LaunchTaskBody.provider` = writer, `TaskState`, `GitRuntime`, `CLIAdapter`, `retryPrompt`, port 4055 |
| `protocol/examples/` | Launch / snapshot / TAP / commit shapes. Old curl bodies must keep working |
| `server/src/index.ts` | `createStore` + **`createGitRuntime(path.resolve('fixture'))`** + **`createAdapters()`** — not stubs |
| `server/src/http.ts` | Four routes. `POST /api/tasks` **201 then `void runLoop(...)`** (not queue-only) |
| `server/src/state.ts` | `addTask` / `updateTask` / `setBusy` / `clear`. Cancel + Reset wired to abort + `git.resetAll()` |
| `server/src/loop.ts` | Writer → `runTests` → `commitIfDirty` or `retryPrompt`. Tests only pass/fail judge |
| `server/src/git.ts` | `createWorkspace`, `runTests`, `getDiff`, `commitIfDirty`, `resetAll`. `shell: false` |
| `server/src/adapters.ts` | `claude` / `codex` from `PROVIDER_COMMANDS`. No Gemini, no FakeAdapter |
| `fixture/` | Failing `parse.js` + `parse.test.js` (`4 !== 5`). Prefer `fixture/.git` so `HEAD~1` exists after commit |
| `web/` | Optional until Gate 3. Phase C step badges only if UI already exists |

**Gate 2 command:** Reset-equivalent `POST /api/reset` → Launch `protocol/examples/http-post-tasks.request.json` → poll `GET /api/state` until `succeeded` + `commitSha` **or** `failed` + TAP. If Launch stays `queued` forever, **stop** — finish [`person-1-orchestrator.md`](person-1-orchestrator.md) steps 5–7 and [`person-3-cli-adapters.md`](person-3-cli-adapters.md).

### What `main` may look like *before* Gate 2

If you are reading this early, the kernel is incomplete. Typical gaps:

- `http.ts` still queues only (`Do not setBusy and do not start runLoop`)
- `index.ts` still uses `createStubGit` / `createStubAdapters`
- `loop.ts` and `adapters.ts` missing
- `git.ts` present but unwired
- `fixture/.git` missing (`commitIfDirty`’s `git diff HEAD~1 HEAD` can fail on first commit)

**Do not implement Phase C on that tree.** Finish BUILD_PLAN through Gate 2 first.

---

## What we keep (do not redesign)

- `POST /api/tasks` → `addTask` → 201 `{ taskId }`. Finder later calls the same enqueue.
- `createWorkspace` / `runTests` / `commitIfDirty` as the only git + test + commit path.
- `CLIAdapter.run(dir, prompt, onLog, signal)` for **every LLM step** (writer and reviewer).
- `retryPrompt(original, TAP)` for writer retries.
- Coding CLIs must not `git commit`.
- `provider` remains the **writer**. Old Launch JSON stays valid.
- Dashboard poll of `GET /api/state` (300ms). Snapshot stays a **view**; ledger may sit behind it.

---

## Independent steps (the C mechanism)

Each step is its own spawn, own logs, own ledger line. Node starts all of them.

| Step | Spawn | LLM? | Commit vote |
|---|---|---|---|
| 1. Code generation | `adapters[writer].run` | Yes | No |
| 2. Oracle / tests | `git.runTests` (`node --test`) | **No** | **Only SHA veto** — red tests never commit |
| 3. Audit / review | `adapters[reviewer].run` (new process, after green tests) | Yes | Second gate; cannot override red tests |
| 4. Git | `commitIfDirty` | No | Runs only if tests passed and review policy passed |

Retry = Node runs **step 1 again** (new writer process), not a nested loop owned by the writer.

`node --test` is a first-class **step** in the UI and logs (`[tests]`) even though it is not a model. Collapsing it into the writer CLI undoes maker ≠ checker.

```text
enqueue (HTTP or later finder)
createWorkspace
while goal unmet && caps ok && not aborted:
  writer.run
  if oracle files dirty → fail ORACLE_TAMPERED (no commit)
  tests = runTests
  if !tests.passed → lastError = TAP; retry writer or fail (skip reviewer)
  if tests.passed && reviewerProvider → reviewer.run
  if review not ok → no commit; retry writer with review text
  if tests.passed && (no reviewer || review ok) → commitIfDirty → succeeded
fail if caps exhausted
```

---

## How existing files change

Do **not** rename JSON keys. **Add** fields. `protocol/` is read-only in phases 0–4; Phase C may add types and examples only.

### `protocol/index.ts` and `protocol/examples/`

| Keep | Add |
|---|---|
| `provider` on launch = writer | Optional `reviewerProvider?: ProviderType` |
| `TaskStatus` queued/running/retrying/succeeded/failed | Optional step/event fields, `oracleSha`, cap remaining |
| `ErrorCode` existing values | `ORACLE_TAMPERED`, `CAP_EXHAUSTED` (and similar) if you need distinct codes |
| `http-post-tasks.request.json` unchanged | New examples for writer+reviewer success/reject; do not break old curl |
| `retryPrompt` | Writer retry may append review text; keep TAP injection |

`maxIterations` stays a **cap** (default 2 for old clients). Goal = tests pass **and** (no reviewer or review ok), or caps fire.

### `server/src/loop.ts` (Track A)

**At Gate 2:** one `for` over writer → tests → commit or TAP retry.

**Change:** same function, more steps and exits. After writer: oracle check. After green tests: optional reviewer spawn (sequential). Commit only on tests pass + review ok (or no `reviewerProvider`). Check caps **before** each `adapter.run`. Prefix logs `[loop] [writer] [tests] [review] [git]`. Do not call git/adapters from the CLI.

### `server/src/http.ts`

**At Gate 2:** validate launch, 409 if writer slot busy, 201, start `runLoop`. Cancel aborts controller. Reset aborts, `git.resetAll()`, `store.clear()`.

**Change:** parse optional `reviewerProvider` (same `claude` \| `codex` rule). Missing field = writer-only (Gate 2 behavior). Reset still wipes workspaces and **open** runs; if a ledger exists, **do not** delete it. `git` / `adapters` deps stay; they are used from `runLoop`, not from the route body.

### `server/src/state.ts`

**At Gate 2:** in-memory `tasks[]` + slots. `setBusy` on the **writer** provider.

**Change:** snapshot remains `GET /api/state`. Additive task fields (reviewer, last step, oracle error). Optional: persist attempts to SQLite/JSONL; RAM becomes a projection. `clear()` on Reset must not wipe audit tables.

### `server/src/index.ts`

**At Gate 2:** real git + real adapters, listen `:4055`.

**Change:** same composition root. If you add a ledger path or jobs file, construct it here and pass into `createHttpApp` / `runLoop`. Do not revert to stubs.

### `server/src/git.ts` (Track B)

**At Gate 2:** copy fixture, `node --test`, commit any dirty tree (except original `fixture/`).

**Change (mandatory for C honesty):**

- After writer (called from loop): oracle paths (`parse.test.js`, later a list) must match workspace baseline; else fail — loop maps this to `ORACLE_TAMPERED`.
- `commitIfDirty` **refuses** if oracle paths are dirty (even if `parse.js` is green).
- Optional: restore oracle files from the fixture copy before `runTests`.

Do not change `parse.test.js` in `fixture/`. Do not parse TAP for pass/fail.

### `server/src/adapters.ts` (Track C)

**At Gate 2:** `createAdapters()` writer spawn.

**Change:** reviewer is a **second** `run()` on `claude` or `codex` with a **review prompt**, new process, same `shell: false` and 120s. Do not add Gemini, FakeAdapter, or `resume`. Do not implement LoopSync spawn-from-CLI tools. Usage tokens on `RunResult` only if trivial; otherwise wall clock in the ledger.

### `server/src/stubs.ts`

Unused at Gate 2. Leave it. Do not route production through stubs.

### `web/` (Track D)

**At Gate 3:** Launch / Cancel / Reset, paint latest task.

**Change:** four step badges (writer, tests, review, git). Disable busy **writer** slots as today. Optional reviewer select. Do not mock a reviewer. If `web/` is missing, skip UI until Gate 3; curl verifies C.

### `fixture/`

Unchanged homework. Oracle lock **depends** on this file staying the answer key. Track D `git init` in fixture remains load-bearing for `HEAD~1`.

---

## Team-rule amendments (demo vs C)

[`TEAM_PLAN.md`](TEAM_PLAN.md) rules for the **demo kernel** still apply through Gate 4. Phase C **amends**:

| Demo rule | Phase C |
|---|---|
| Merge only through `runLoop`, no second orchestrator | Scheduler/finder may **enqueue** and **start** `runLoop`. They must not duplicate git/tests/commit |
| One job at a time | Sequential writer then reviewer on one laptop. Queue of work items comes **after** person-5 layers 1–5 |
| Tests are the only judge | Tests remain the **only SHA veto**. Review is an extra gate on **green** tests |
| Protocol read-only | **Additive** fields + examples only. No key renames |

Still true: no Gemini, no FakeAdapter, CLIs do not `git commit`, 120s per spawn, Cancel/AbortSignal.

---

## Layers (person-5 stops at 5)

Do these **in order**. Person-5 **stops after step visibility**. Finder, jobs file, LLM dispatcher, recursive spawn, test-author LLM, and perfect token telemetry are **later**.

| Layer | What | Verify |
|---|---|---|
| 0 | Confirm Gate 2 kernel | `tsc`; Launch → SHA or TAP |
| 1 | Oracle lock in `git.ts` + loop | Editing `parse.test.js` cannot yield `commitSha` |
| 2 | Durable ledger (SQLite or JSONL) | Restart does not invent success; Reset does not wipe ledger |
| 3 | Caps / goal | `maxIterations: 1` + still-failing code → failed, no SHA |
| 4 | Reviewer step | See playbook A–D (no reviewer / red tests / reject / ok) |
| 5 | Step visibility in snapshot/logs (and UI if present) | Distinct `[writer]` `[tests]` `[review]` `[git]` |
| Later | Jobs-file finder, queue, event API, nested usage | Not in the first C agent turn |

**Reviewer policy (frozen here):** both gates to allow SHA — tests must pass **and** review ok. Tests still veto. Same binary allowed for writer and reviewer (two processes). Default the other provider if that slot is idle, when easy.

**Finder (later, not person-5):** jobs file first, not GitHub, not an LLM dispatcher.

---

## Stretch (not this phase)

- Recursive spawn: first-layer agent starts a subagent that owns another `runLoop`
- LLM that **writes** `parse.test.js` as the commit oracle
- Parallel writer + reviewer on the demo laptop
- LLM work-finder

Inner tool-use **inside** one `claude -p` / `codex exec` may already happen; meter it later. Do not expose it as LoopSync child tasks.

---

## Builder launch

1. Gate 2 green.  
2. Attach [`person-5-phase-c.md`](person-5-phase-c.md) + `protocol/index.ts` + `protocol/examples/`.  
3. Prompt: follow in order; stop at Verify; add protocol fields, never rename; no recursive spawn; no FakeAdapter; no Gemini.  
4. One C agent at a time. Debugger runs the playbook curl matrix, then `git push`.

Phases 3–4 (dashboard + rehearsal) can proceed **in parallel** with C layers 1–3 if Gate 2 is already true. Do not block the demo on reviewer. Do not demo C until Layer 1 exists (otherwise a CLI can cheat the test file).
