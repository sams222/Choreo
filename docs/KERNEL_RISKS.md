# Choreo — kernel risks (where the loop can lie)

Status as of commit `40918b5` (`main`). These are gaps in the **running kernel**, not in [`PLATFORM.md`](PLATFORM.md) plans. `node --test` as pass/fail is the stable core. Spawn, review, cancel, commit, and slots are where a live run goes wrong.

The advertised invariants:

- Tests are the only SHA veto.
- Coding agents must not `git commit`.
- Oracle (`parse.test.js`) is tamper-proof.
- Writer, tests, and reviewer are independent steps; Node starts every spawn.

Several of those are **prompt- or order-level**, not enforced after the reviewer runs.

**Architectural constraint:** keep git and spawn behind `GitRuntime` / `CLIAdapter`. Do not scatter `git.ts` logic into adapters, or spawn/kill logic into HTTP.

```
1 spawn/timeout     adapters.ts spawnCli          → loop.ts (honor result) → protocol RunResult
2 no re-test        loop.ts after review          → git.ts runTests/checkOracle → adapters argv by role
3 verdict parse     protocol parseReviewVerdict   → loop.ts (what string you pass)
4 oracle scope      protocol ORACLE_PATHS         → git.ts isOracleDirty/runTests → loop.ts when to check
5 cancel/reset      http.ts reset/cancel          → adapters wait-for-death → git.ts resetAll
7 slots             http.ts + state.ts slots      → loop.ts catch → web/index.html defaults + app.js
8 retry vs filter   loop.ts prompt choice         → protocol retry* → cli-log.ts UI only
```

Issue **6** (git `HEAD~1` / empty commit after green tests) is omitted here; it lives in `server/src/git.ts` `commitIfDirty` and the “nothing to commit” branch in `loop.ts`.

---

## 1. CLI spawn, timeout, and kill

### What goes wrong

Every LLM step is one `spawn`. A 0 exit code means “the process closed,” not “the homework is fixed.” The adapter treats timeout and crash-exit the same as a normal finish: it **resolves**. The loop then marks the writer `ok`.

Auth prompts cannot work: stdin is `'ignore'`. Cancel can return `{ ok: true }` while Codex is still writing files. Timeout looks like a successful writer, then tests fail or retry.

### Where it lives

| File | What |
|---|---|
| [`server/src/adapters.ts`](../server/src/adapters.ts) | `spawnCli`: `detached: true`, stdin `'ignore'`, timeout kills then `finish()` **resolves** |
| [`protocol/index.ts`](../protocol/index.ts) | `CLI_TIMEOUT_MS = 120_000`, `CLIAdapter.run` → `Promise<RunResult>` with `exitCode` |
| [`server/src/loop.ts`](../server/src/loop.ts) | Plan, writer, reviewer: `await adapters[…].run(...)` then treat as success unless it **throws** |
| [`server/src/http.ts`](../server/src/http.ts) | Cancel only `controller.abort()`; does not wait for `close` |

`spawnCli` always `resolve`s on `close`:

```ts
const finish = (exitCode: number) => {
  settled = true;
  cleanup();
  resolve({ output, exitCode });
};

const timeoutId = setTimeout(() => {
  abortChild();
}, CLI_TIMEOUT_MS);
```

After `adapter.run`, the loop never reads `writerResult.exitCode` (same for plan and review). `child.on('error')` is the only reject path (binary missing).

`makeAdapter` also requires `parse.js` in the workspace. After Reset deletes `/tmp`, a still-running `run()` throws `parse.js missing` instead of a clean “cancelled.”

### Where to fix

1. **`server/src/adapters.ts` `spawnCli`** — primary. Distinguish `timedOut`, `aborted`, `exitCode`. Do not `resolve` until the process **group** is dead (wait after SIGKILL). Optionally reject on timeout so the loop’s existing `catch` fires.
2. **`protocol/index.ts` `RunResult`** — add `timedOut?: boolean` / `aborted?: boolean` if you do not want to throw. Keep `exitCode`.
3. **`server/src/loop.ts`** — after every `adapter.run` (plan, writer, review): if aborted → cancelled; if timed out or unexpected non-zero → fail that step with a clear `lastError`. Tests remain the homework judge; a dead CLI should not look like “Write: ok.”
4. **`server/src/http.ts` cancel** — wait on a per-task “process exited” promise from the adapter, or document that 200 means “abort requested.”

Do not put kill logic in `loop.ts`. Node spawn ownership is Track C (`adapters.ts`).

---

## 2. Reviewer after green tests, no re-test

### What goes wrong

The SHA veto is implemented as “tests passed once,” then a second CLI is allowed to touch the same tree, then git commits whatever is dirty. The reviewer is only *told* not to edit files.

Order today:

```
writer → checkOracle → runTests → reviewer.run → commitIfDirty
```

There is no second `runTests` after review. If the reviewer (or a hung writer from issue 1) changes `parse.js` or adds files, `commitIfDirty` will commit that tree. Tests already passed on the **writer’s** tree.

### Where it lives

| File | Role |
|---|---|
| [`server/src/loop.ts`](../server/src/loop.ts) | After `REVIEW_OK`, immediately `commitIfDirty` |
| [`protocol/index.ts`](../protocol/index.ts) `reviewPrompt` | “Do not change any files” — prompt only |
| [`server/src/adapters.ts`](../server/src/adapters.ts) | Reviewer uses the **same** argv as the writer (`workspace-write` / `--dangerously-skip-permissions`) |
| [`server/src/git.ts`](../server/src/git.ts) `commitIfDirty` | Commits any non-oracle dirty files; does not run tests |
| [`protocol/index.ts`](../protocol/index.ts) `PROVIDER_COMMANDS` | One argv map for all roles |

`checkOracle` after the writer does **not** run again after review. `commitIfDirty` will refuse a dirty `parse.test.js`, but a reviewer rewrite of `parse.js` (or a new file) is eligible for the SHA.

### Where to fix

1. **`server/src/loop.ts` after a `REVIEW_OK` (before `commitIfDirty`)** — the real invariant. Repeat `checkOracle` + `runTests`. If tests are now red or oracle dirty → do not commit; treat as reject/retry or fail.
2. **`protocol/index.ts`** — optional reviewer argv with a read-only sandbox. Defense in depth, not a substitute for re-test.
3. **`server/src/adapters.ts` `run(...)`** — optional role argument (`'writer' | 'review' | 'plan'`) so planner/reviewer can use different argv without a second orchestrator.
4. **`server/src/git.ts`** — optional snapshot of production files before review; restore on “reviewer dirtied the tree.” Only if you want to *discard* reviewer edits rather than re-judge them.

The loop is the right place. Do not have the reviewer CLI call `node --test` and trust that.

---

## 3. Review verdict is a substring search on raw stdout

### What goes wrong

Approval is `lastIndexOf('REVIEW_OK')` vs `lastIndexOf('REVIEW_REJECT')` on the **full** CLI dump. The instruction text **contains both strings**, reject after ok. Echoed prompts, quoted tokens, and “I would emit REVIEW_REJECT if…” all move the last index.

- Echo + no verdict → last token in the prompt is `REVIEW_REJECT` → fail closed (safe).
- Echo + real `REVIEW_OK` at the end → ok.
- Model quotes `REVIEW_REJECT` after an approval, or prints both in a sentence → last substring wins.

A false **ok** is the dangerous case: green tests + misparsed approval → commit (compounded by issue 2).

### Where it lives

| File | Role |
|---|---|
| [`protocol/index.ts`](../protocol/index.ts) | `REVIEW_OK` / `REVIEW_REJECT`, `reviewPrompt`, `parseReviewVerdict` |
| [`server/src/loop.ts`](../server/src/loop.ts) | `reviewOutput = result.output` (raw), then `parseReviewVerdict(reviewOutput)` |
| [`server/src/cli-log.ts`](../server/src/cli-log.ts) | `extractUsefulCliText` is used for **timeline/retry text**, not for the verdict |
| [`protocol/examples/review-ok.txt`](../protocol/examples/review-ok.txt), [`review-reject.txt`](../protocol/examples/review-reject.txt) | Contract samples; parser does not require that shape |

Display filter can drop the verdict line as “noise” while the parser still sees it in raw output — UI and machine disagree.

### Where to fix

1. **`protocol/index.ts` `parseReviewVerdict`** — primary. Match **whole lines** only (`^REVIEW_OK$` / `^REVIEW_REJECT$`). Ignore occurrences inside the prompt. If both appear as real lines, last **line** wins. Missing both stays reject.
2. **`server/src/loop.ts`** — parse a stripped transcript (or last N lines of model output), not the entire echoed prompt. Do **not** reuse `isCliNoise` for this; that filter is for humans.
3. **`protocol/index.ts` `reviewPrompt`** — say “your last line must be exactly …” and avoid putting the tokens in the instruction, or use a delimiter the model is told not to repeat.
4. Keep [`protocol/examples/review-ok.txt`](../protocol/examples/review-ok.txt) in sync so the parser is testable without spawning Claude.

This is protocol + one call site in `loop.ts`. Do not “fix” it only in `cli-log.ts`.

---

## 4. Oracle lock is a single hardcoded file

### What goes wrong

Tamper detection is a byte compare of `fixture/parse.test.js` vs the copy. Anything else can change. `node --test` will also run **new** test files the writer adds, so a model can pass a different suite without touching the locked file.

[`PLATFORM.md`](PLATFORM.md) Phase D names this as the next gap (“oracle is always `parse.test.js`”). That is **docs only**.

### Where it lives

| File | Role |
|---|---|
| [`protocol/index.ts`](../protocol/index.ts) | `ORACLE_PATHS = ['parse.test.js']` |
| [`server/src/git.ts`](../server/src/git.ts) `isOracleDirty` / `checkOracle` / `oracleSha` | Compare those paths to `fixtureDir` |
| [`server/src/git.ts`](../server/src/git.ts) `runTests` | Always `node --test` with no file list |
| [`server/src/git.ts`](../server/src/git.ts) `commitIfDirty` | Skips `ORACLE_PATHS` + `README.md`; second oracle check |
| [`server/src/loop.ts`](../server/src/loop.ts) | Oracle check **once**, after writer, before tests |
| [`fixture/parse.test.js`](../fixture/parse.test.js) | The actual answer key |

Missing oracle file or byte mismatch → dirty → `ORACLE_TAMPERED`, no commit. That path works for the one named file.

### Where to fix

1. **`server/src/git.ts`** — keep comparison/commit refuse here (Track B). Parameterize paths instead of importing only a global constant.
2. **`protocol/index.ts`** — `oraclePaths` on launch/project; keep `ORACLE_PATHS` as the demo default.
3. **`server/src/loop.ts`** — call `checkOracle` after writer **and** after reviewer (ties to issue 2).
4. **`server/src/git.ts` `runTests`** — pass explicit test files (`node --test parse.test.js`) so extra files are not a second oracle.
5. **[`PLATFORM.md`](PLATFORM.md) Phase D** — when you implement projects, reuse `GitRuntime.checkOracle(dir, paths)`. Do not fork a second git module.

Narrow lock is correct for the homework demo; it is a product bug the moment the tree is not `parse.test.js`.

---

## 5. Cancel / Reset vs a still-running loop

### What goes wrong

HTTP returns before processes and disk agree. Reset deletes the workspace **under** a live CLI, then wipes RAM.

Cancel: abort controller, **200 immediately**, no wait for spawn to die.

Reset:

1. Abort every controller.
2. `git.resetAll()` deletes `/tmp/loopsync-workspaces` immediately.
3. `store.clear()` so `getTask` is gone.

The in-flight `runLoop` may still be in `adapter.run` or `runTests`. Next disk op fails on a missing cwd. After `store.clear()`, `markFailed` is a no-op. Usually `finally` still clears slots.

If `rmSync` throws (EBUSY because a CLI has files open), UI gets **500 `RESET_FAILED`** and the store is **not** cleared — UI and `/tmp` disagree.

### Where it lives

| File | Role |
|---|---|
| [`server/src/http.ts`](../server/src/http.ts) | `controllers` map, cancel 200, reset abort+delete+clear |
| [`server/src/git.ts`](../server/src/git.ts) `resetAll` | `fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true })` |
| [`server/src/loop.ts`](../server/src/loop.ts) `isGone` / `markFailed` | Abort checked **between** steps; during `adapter.run` cancel depends on the adapter |
| [`server/src/adapters.ts`](../server/src/adapters.ts) | Abort kills the group but `finish()` still resolves |
| [`server/src/state.ts`](../server/src/state.ts) `clear` | Drops tasks; in-flight `markFailed` becomes a no-op |

`makeAdapter` requiring `parse.js` (issue 1) is the failure mode after a successful Reset: the still-running spawn throws `parse.js missing`.

### Where to fix

1. **`server/src/http.ts` `POST /api/reset`** — primary. Abort, **await** in-flight `runLoop` promises (keep a `Map<taskId, Promise<void>>` next to `controllers`), *then* `resetAll`, *then* `clear`. Decide whether `RESET_FAILED` still clears RAM (today: no).
2. **`server/src/adapters.ts`** — abort should reject or return `aborted: true`, and the promise should settle only after the group is gone so Reset can wait.
3. **`server/src/git.ts` `resetAll`** — retry `rmSync` on EBUSY/ENOTEMPTY; do not throw on “already gone.”
4. **`server/src/loop.ts`** — wrap `executeLoop` so any throw (including ledger) hits `markFailed`; after `run()`, always `if (isGone) return` before tests (already present; keep it).

Cancel can stay 200-immediate if the UI only needs “Stop requested.” Reset must be a barrier.

---

## 7. Provider slots: both CLIs busy, Launch 409, stuck `running`

### What goes wrong

There are two booleans (`claude` / `codex`). A Launch occupies **every** role’s provider. Default UI is Codex writer + Claude reviewer → **both** slots busy. A second Launch of either brand 409s.

A Claude auth/spawn failure on review fails the **whole** task after tests may already have passed.

If `executeLoop` throws outside its inner try (e.g. ledger `appendFileSync`), `finally` still frees slots, but the task can sit in `running` forever. Polling UI looks hung; Launch may work again.

### Where it lives

| File | Role |
|---|---|
| [`server/src/http.ts`](../server/src/http.ts) | Builds `involved`, 409 if any busy, `setBusy(true)` **before** 201 |
| [`server/src/loop.ts`](../server/src/loop.ts) | Sets busy again; `finally` sets false; **no** `catch` around `executeLoop` |
| [`server/src/state.ts`](../server/src/state.ts) | Two slots; `setBusy` is a boolean, not a refcount |
| [`web/index.html`](../web/index.html) | Write Codex, **Review Claude selected** |
| [`web/app.js`](../web/app.js) `applySlotBusy` / `updateActions` | Disables busy options; **Launch disabled only if the writer select is busy**, not reviewer/planner |
| [`server/src/ledger.ts`](../server/src/ledger.ts) `append` | `appendFileSync` can throw; `loop.ts` `record()` has no try/catch |

If writer and reviewer are both Codex, one slot is enough (they run sequentially). Mixed roles lock the laptop for a second job of either brand.

`updateActions` disables Run only from `els.provider`. User can pick a busy Claude as reviewer and still click Run → 409 in `formError`. Confusing, not a kernel bug.

### Where to fix

1. **`web/index.html`** — cheapest demo fix: default Review to “Tests only” (`value=""`), matching curl examples. Does not change HTTP.
2. **`web/app.js` `updateActions`** — disable Run if **any** selected role’s slot is busy; surface why.
3. **`server/src/loop.ts` `runLoop`** — `catch` around `executeLoop`: `markFailed` + ledger `loop_crashed`. Stops stuck `running`.
4. **`server/src/ledger.ts`** — wrap `append` so disk errors cannot abort the loop (or try/catch `record()` in `loop.ts`).
5. **`server/src/state.ts`** — only if you need overlapping jobs: refcount or “busy until this taskId.” Sequential same-provider writer+reviewer is already one boolean; do not “fix” that by allowing two Codex writers.

Do not invent a third slot in HTTP without changing `ProviderSlot` in `protocol/index.ts`. Dual occupancy is the contract; the UI default is what makes it hurt.

---

## 8. Retry prompts vs log filtering

### What goes wrong

Two systems share “CLI text”: (a) the **next writer prompt**, (b) what humans see. They use different filters. Retry picks **either** TAP **or** review, not a structured pair.

Aggressive noise filters can strip the line you need in the timeline while the next prompt still gets a truncated dump. Verdict parsing (issue 3) uses **unfiltered** output, so filter and judge remain out of sync.

Retry selection:

- Attempt 1 + plan → `writerPromptWithPlan`
- Attempt > 1 + `lastReviewOutput` → `reviewRetryPrompt` (TAP dropped)
- Else attempt > 1 → `retryPrompt` with TAP

A test fail clears `lastReviewOutput`, so TAP wins after a red test. After `REVIEW_REJECT`, retry is review-only.

### Where it lives

| File | Role |
|---|---|
| [`protocol/index.ts`](../protocol/index.ts) | `retryPrompt`, `reviewRetryPrompt`, `writerPromptWithPlan` — unbounded string concat |
| [`server/src/loop.ts`](../server/src/loop.ts) | Chooses which prompt; `lastTestOutput` / `lastReviewOutput`; `appendChunk` filters logs |
| [`server/src/cli-log.ts`](../server/src/cli-log.ts) | `NOISE` regexes; `extractUsefulCliText` for timeline + review retry body |
| [`server/src/state.ts`](../server/src/state.ts) | `MAX_LOGS = 500` — raw log ring, not the retry prompt |
| [`web/app.js`](../web/app.js) | Timeline from `task.timeline`; full logs under “Technical details” |

`extractUsefulCliText` de-dupes `REVIEW_OK` / `REVIEW_REJECT` if they appear twice — fine for cards, bad if you ever parse the **filtered** string for a verdict (you currently do not).

### Where to fix

1. **`server/src/loop.ts` retry construction** — keep a small struct `{ tap?, review?, plan? }` and pass the latest of each into protocol helpers. Do not let `lastReviewOutput` hide TAP.
2. **`protocol/index.ts` `retryPrompt` / `reviewRetryPrompt`** — cap injected blobs (e.g. last 4k of TAP) so CLI context does not blow up.
3. **`server/src/cli-log.ts`** — keep as **UI-only**. Never feed `isCliNoise` into `parseReviewVerdict`. Whitelist exact `REVIEW_OK` / `REVIEW_REJECT` / `PLAN_DONE` lines in the timeline if they are currently stripped with surrounding chrome.
4. **`web/app.js`** — no kernel fix required. `lastError` is already shown; raw logs stay under Technical details.

---

## What is comparatively solid

- **`node --test` as pass/fail** (`passed === exitCode === 0`). Least magical judge.
- **HTTP 201 then background loop.** Errors show up in snapshot `status` / `lastError`.
- **Fixture isolation.** Original `fixture/` is not the workspace. Reset is not supposed to touch it.
- **No WebSocket.** Polling `GET /api/state` cannot desync a push channel.

The kernel you can trust is: **copy fixture → spawn writer → `node --test`**. Every layer around that (reviewer, planner, cancel, commit, slots) is where Choreo is most susceptible to error.
