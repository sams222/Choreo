# Person 1 — Orchestrator & HTTP

You own the product brain. If your loop is wrong, the demo is wrong even if git and CLIs work.

## You own

- In-memory list of `TaskState`
- Function `runLoop(taskId)` that calls GitRuntime + CLIAdapter
- HTTP server on **:4055**
- Status transitions: queued → running → retrying → succeeded | failed
- Appending logs when Person 3 calls `onLog`

## You do not own

- `git` commands, `node --test` implementation
- Claude/Codex argv
- React / CSS

## You import

From `protocol/index.ts`: `TaskState`, `ServerSnapshot`, `LaunchTaskBody`, `CLIAdapter`, `GitRuntime`, `HTTP`.

You receive **instances**:

```ts
function createLoop(deps: {
  git: GitRuntime;
  adapters: Record<ProviderType, CLIAdapter>;
}): { launch: ...; getSnapshot: ...; cancel: ...; reset: ... }
```

Person 2 gives you `git`. Person 3 gives you `adapters.claude` and `adapters.codex`.

## HTTP you must serve (Person 4’s contract)

| Method | Path | Body in | Body out |
|---|---|---|---|
| GET | `/api/state` | — | `ServerSnapshot` |
| POST | `/api/tasks` | `LaunchTaskBody` | `{ "taskId": string }` |
| POST | `/api/tasks/:id/cancel` | — | `{ "ok": true }` |
| POST | `/api/reset` | — | `{ "ok": true }` |

CORS: allow `http://127.0.0.1:4055` and `http://localhost:4055` (and Vite if Person 4 uses it).

Polling is enough. Person 4 hits GET `/api/state` every 300ms. Optional: append-only log via that same snapshot (`task.logs`). Do not block on Socket.IO.

## `runLoop` contract

**In**

- `taskId`
- existing `TaskState` (prompt, provider, maxIterations)
- `AbortSignal` for Cancel

**Out (by mutating TaskState + snapshot)**

- `logs[]` grow as `onLog` fires
- `currentIteration` increments
- `lastError` set from **test output**, not from CLI chatter
- `diff` and `commitSha` set only after tests pass and Person 2 commits
- `status` as above

**Prompt for attempt 1:** `task.prompt`

**Prompt for attempt 2+:**

```
${task.prompt}

The tests failed. Fix the code, not the test. Do not ask questions. Do not git commit.

TEST OUTPUT:
${task.lastError}
```

## Done when

From curl or a tiny script, with Person 2 + 3 plugged in:

```bash
curl -s -X POST http://127.0.0.1:4055/api/tasks \
  -H 'content-type: application/json' \
  -d '{"title":"Fix off-by-one","prompt":"Make parseIndex pass parse.test.js. Do not change the test. Do not git commit.","provider":"codex","maxIterations":2}'
curl -s http://127.0.0.1:4055/api/state
```

A task reaches `succeeded` with a `commitSha`, **or** `failed` with `lastError` after max iterations. Never stuck in `running` after the CLI exits.

## Do not

- Call `claude` / `codex` yourself
- Call `git commit` yourself
- Invent extra REST paths Person 4 is not using
- Change protocol field names
