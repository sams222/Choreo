# Track E — Phase C orchestrator

**One file for this track.** Builder feeds this to the Phase C agent **after Gate 2**. Human plan and file-delta: [`PHASE_C.md`](PHASE_C.md). Kernel: [`person-1-orchestrator.md`](person-1-orchestrator.md) steps 5–7 already done.

**Writes:** `server/src/loop.ts`, `http.ts`, `state.ts`, `index.ts`; `server/src/git.ts` **only** for oracle-lock / refuse commit if tests dirty; `protocol/index.ts` and `protocol/examples/` **only to ADD fields and new JSON**; `web/` only for step badges if Gate 3 UI already exists.

**Does not write:** `fixture/parse.test.js`, Gemini, FakeAdapter, recursive subagent trees, jobs-file finder, LLM dispatcher, test-author LLM.

**Do not:** rename JSON keys; let review authorize commit on red tests; `shell: true`; commit in original `fixture/`; parallel writer+reviewer; spawn LoopSync from a CLI; start this playbook if Launch still queue-only.

---

## Precondition

Gate 2 must already be true. `POST /api/tasks` starts `runLoop`. `index.ts` uses real `createGitRuntime(path.resolve('fixture'))` and `createAdapters()`, not stubs.

**Verify (Layer 0) — stop the whole playbook if this fails:**

```bash
npx tsc --noEmit
# server running on :4055
curl -s -X POST http://127.0.0.1:4055/api/reset
curl -s -D- -X POST http://127.0.0.1:4055/api/tasks \
  -H 'content-type: application/json' \
  --data-binary @protocol/examples/http-post-tasks.request.json
# 201 {"taskId":"..."}
# poll GET /api/state until succeeded (commitSha + diff) or failed (lastError TAP, no sha)
```

If the task stays `queued`, finish Track A steps 5–7 and Track C first.

---

## Contract — independent steps

Node `runLoop` spawns every step. One Launch is still **one** `TaskState` id.

| Step | Who | Success |
|---|---|---|
| Writer | `adapters[task.provider].run` | Process exited (not “homework fixed”) |
| Oracle | Dirty `parse.test.js` (and listed oracle paths) vs baseline | If dirty → fail `ORACLE_TAMPERED`, no commit |
| Tests | `git.runTests` → `node --test` | `passed === (exitCode === 0)` — **only SHA veto** |
| Review | `adapters[reviewerProvider].run` after **green** tests, new process | Machine-readable ok/reject (document in `protocol/examples/`) |
| Git | `commitIfDirty` | Only if tests passed **and** (no reviewer or review ok) |

`provider` = writer. Optional `reviewerProvider`: `claude` \| `codex`. Omit = Gate 2 path (skip review).

Logs: `[loop]`, `[writer]`, `[tests]`, `[review]`, `[git]`. Snapshot cap 500. Sequential on one laptop: writer spawn must finish before reviewer.

Old body `protocol/examples/http-post-tasks.request.json` must still 201 and complete without a reviewer.

---

## Steps (layers 1–5)

### Layer 1 — Oracle lock

After every writer `run`: if oracle paths changed, fail; do not commit. `commitIfDirty` refuses if those paths are dirty. Optionally restore tests from the fixture copy before `runTests`.

**Verify:** a workspace that only edits `parse.test.js` must not reach `succeeded` + `commitSha`. Stock `fixture/parse.js` still fails `4 !== 5` until the writer fixes **code**.

### Layer 2 — Durable ledger

Persist attempts/events (SQLite or JSONL under a local data dir). `GET /api/state` stays the projection (additive fields ok). Reset aborts and `git.resetAll()` + clear **open** runs; **do not** delete the ledger.

**Verify:** restart the server; a finished run is still reconstructible from disk. If you skip this layer, say so in the handback and continue — prefer doing it.

### Layer 3 — Caps / goal

`maxIterations` is a cap (default 2 for old clients). Goal = tests pass and review policy. Check caps **before** each `adapter.run`. Keep `CLI_TIMEOUT_MS` 120s per spawn. AbortSignal + Cancel + Reset abort controllers.

**Verify:** Launch with `"maxIterations": 1` against still-failing `parse.js` → `failed`, one writer+tests, no SHA.

### Layer 4 — Reviewer

Parse `reviewerProvider` in HTTP. Loop:

```
writer.run → oracle check → runTests
if tests fail → TAP retry writer or fail (no reviewer)
if tests pass && reviewerProvider → reviewer.run(dir, reviewPrompt, onLog, signal)
if review reject → no commit; next writer prompt += review text
if tests pass && (no reviewer || review ok) → commitIfDirty → succeeded
```

Reviewer prompt: read the code/diff; do not change tests; do not git commit; emit **REVIEW_OK** or **REVIEW_REJECT** (or another documented convention in `protocol/examples/`).

**Verify:**

- A) No `reviewerProvider` → same as Gate 2.
- B) Tests fail → no SHA; reviewer need not run.
- C) Tests pass, reviewer rejects → no SHA; writer retries if caps remain.
- D) Tests pass, reviewer ok → `commitSha` + `diff`.

### Layer 5 — Step visibility

Snapshot/logs show the four steps. Add example JSON under `protocol/examples/`. If `web/` exists, badge writer / tests / review / git. Do not mock review.

**Verify:** `GET /api/state` after a run is not a single undifferentiated log blob.

### Stop

Do **not** implement: jobs-file finder, LLM dispatcher, recursive spawn, test-author agent, token telemetry unless `RunResult` already makes it trivial.

**Hand back:** files touched, curl for A–D, every new protocol field (name + meaning), ledger path if any.

---

## Done

Kernel Launch still works. Oracle cannot be rewritten for a fake SHA. Reviewer is a separate process. Tests remain the only veto. Caps fire before extra spawns. No recursive LoopSync spawn.
