# Track A — Orchestrator

**One file for this track.** Builder feeds this to Agent A. JSON examples: `protocol/examples/`.

**Writes:** `package.json`, `tsconfig.json`, `server/src/{index,http,loop,state,stubs}.ts`  
**Does not write:** `server/src/git.ts` (Track B), `server/src/adapters.ts` (Track C), `web/*`, `fixture/*`, `protocol/index.ts`

**Do not:** spawn `claude`/`codex`, `git commit`, Socket.IO, Gemini, FakeAdapter.

Bind **`0.0.0.0:4055`**. Poll is Person/Track D’s job (300ms). `Content-Type: application/json`.

---

## Contract — HTTP

| Status | Method | Path | Request | Response |
|---|---|---|---|---|
| 200 | GET | `/api/state` | — | `http-get-state-empty.json` or snapshot with `tasks[]` |
| 201 | POST | `/api/tasks` | `http-post-tasks.request.json` | `{ "taskId" }` |
| 400 | POST | `/api/tasks` | bad / `gemini` | `http-error-bad-request.json` |
| 409 | POST | `/api/tasks` | provider `isBusy` | `http-post-tasks.error-slot-busy.json` |
| 200 | POST | `/api/tasks/:id/cancel` | — | `{ "ok": true }` |
| 404 | POST | `/api/tasks/:id/cancel` | unknown id | `TASK_NOT_FOUND` |
| 200 | POST | `/api/reset` | — | `{ "ok": true }` |

CORS: allow localhost origins. `maxIterations` default **2**. Providers: `claude` \| `codex` only. MVP: one task at a time.

`TaskState` shapes: `task-queued.json` → `task-running.json` → `task-retrying.json` → `task-succeeded.json` (must have `diff` + `commitSha`) or `task-failed.json` (no SHA). `id` = `task_` + unique suffix. `lastError` = **Track B test TAP**, not CLI chat.

Logs: array of strings, cap 500, split on `\n`. Prefix orchestrator lines `[loop]`, `[tests]`, `[git]`.

---

## Steps (Phase 0 = 1–4, Phase 2 = 5–7)

### Step 0 — Layout

Already in repo: `protocol/`, `fixture/`. Create `package.json`, `tsconfig.json`, `server/src/{index,state,loop,http,stubs}.ts`.

**Verify:** `ls protocol/index.ts fixture/parse.test.js`

### Step 1 — Node + TypeScript

```json
{
  "name": "loopsync",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch server/src/index.ts",
    "start": "tsx server/src/index.ts"
  }
}
```

Install: `express`, `cors`, `tsx`, `typescript`, `@types/express`, `@types/cors`, `@types/node`.  
`tsconfig`: NodeNext, strict, include `server/src` and `protocol`.

### Step 2 — `server/src/state.ts`

In-memory `createStore()`: `getSnapshot`, `addTask`, `getTask`, `updateTask`, `setBusy`, `clear`. Empty snapshot = both slots idle (`http-get-state-empty.json`). New task matches `task-queued.json`.

**Verify:** addTask then snapshot `tasks.length === 1`.

### Step 3 — Stubs until B and C land

`stubs.ts`: git/adapters throw `not wired` until `git.ts` / `adapters.ts` exist. Prefer importing real files as soon as they appear.

**Verify:** `npx tsc --noEmit`

### Step 4 — HTTP, **no loop yet**

Listen 4055. `GET /api/state`, `POST /api/tasks` (validate, **do not** `runLoop` yet), cancel, reset, `express.static('web')` if present.

**Verify:**

```bash
npx tsx server/src/index.ts
curl -s http://127.0.0.1:4055/api/state
curl -s -D- -X POST http://127.0.0.1:4055/api/tasks \
  -H 'content-type: application/json' \
  --data-binary @protocol/examples/http-post-tasks.request.json
# 201 {"taskId":"..."}
curl -s -X POST http://127.0.0.1:4055/api/tasks \
  -H 'content-type: application/json' \
  -d '{"title":"x","prompt":"y","provider":"gemini"}'
# 400
```

**Gate 0 is here.** Stop if this fails.

### Step 5 — `runLoop` (`server/src/loop.ts`)

Use `retryPrompt()` from `protocol/index.ts`. Attempt 2 shape: `protocol/examples/loop-attempt2-prompt.txt`.

```
createWorkspace → busy=true
for attempt 1..max:
  abort? → failed/cancelled
  status running | retrying
  adapters[provider].run(dir, prompt, onLog, signal)
  tests = git.runTests(dir)
  if passed: commitIfDirty → succeeded + sha + diff; busy=false; return
  lastError = tests.output
failed; busy=false
```

After POST 201, start `runLoop` (don’t block the HTTP response). `AbortController` per taskId. Reset: abort all, `git.resetAll()`, `clear()`.

### Step 6 — Wire Track B + C

Import `createGitRuntime(path.resolve('fixture'))` and `createAdapters()`. Poll GET until succeeded/failed (~3 min).

### Step 7 — Gate 2

Terminal only: reset → launch real Codex or Claude → SHA or TAP. Then UI (Track D) is allowed.

---

## Done

Empty GET matches slots. 201/400/409. Loop uses tests as the only pass/fail judge. Cancel + Reset work.
