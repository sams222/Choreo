# Person 1 — step-by-step implementation (agent playbook)

You are Person 1. You own the retry loop, in-memory state, and HTTP on port **4055**.

**Read first:** `protocol/index.ts`, `protocol/examples/README.md`, `docs/person-1-orchestrator.md`.

**Do not:** spawn `claude`/`codex`, run `git commit`, edit `protocol/index.ts`, add Socket.IO, add Gemini, add a fake agent.

**You import:** `GitRuntime` from Person 2 (`server/src/git.ts`) and `CLIAdapter` map from Person 3 (`server/src/adapters.ts`). Until those files exist, keep **typed stubs** in `server/src/stubs.ts` so you can compile.

---

## Step 0 — Confirm repo layout

Expected already in the repo:

- `protocol/index.ts`
- `protocol/examples/*.json`
- `fixture/parse.js`, `fixture/parse.test.js`, `fixture/package.json`

Create if missing:

```
package.json
tsconfig.json
server/src/index.ts
server/src/state.ts
server/src/loop.ts
server/src/http.ts
server/src/stubs.ts
```

**Verify:** `ls protocol/index.ts fixture/parse.test.js`

---

## Step 1 — Root Node project (TypeScript, no monorepo)

`package.json`:

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

`tsconfig.json`: `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"strict": true`, `"rootDir": "."`, include `server/src` and `protocol`.

**Verify:** `npx tsc --noEmit` (may fail until files exist; after step 2 it should pass).

---

## Step 2 — `server/src/state.ts`

In-memory only. No database.

```ts
import type { ProviderType, ServerSnapshot, TaskState } from '../../protocol/index.ts';

export function emptySnapshot(): ServerSnapshot {
  return {
    tasks: [],
    slots: [
      { provider: 'claude', isBusy: false },
      { provider: 'codex', isBusy: false },
    ],
  };
}
```

Need:

- `createStore()` returning `{ getSnapshot, addTask, getTask, updateTask, setBusy, clear }`
- `addTask(body)` creates id `task_` + `crypto.randomUUID().slice(0, 8)` (remove hyphens or keep uuid — either is fine, must be unique)
- New task matches `protocol/examples/task-queued.json` keys: `status: "queued"`, `currentIteration: 0`, `workspaceDir: ""`, `logs: []`, `maxIterations: body.maxIterations ?? 2`
- `setBusy(provider, boolean)` updates `slots`
- Cap `logs` at 500 entries (shift oldest)
- `updateTask` may append log lines; split incoming chunks on `\n`

**Verify:** a tiny `node --import tsx -e` that `addTask` then `getSnapshot()` has `tasks.length === 1` and both slots `isBusy: false`.

---

## Step 3 — Stubs so you compile without Person 2/3

`server/src/stubs.ts`:

- `stubGit`: `createWorkspace` throws `Error('GitRuntime not wired')` **or** returns a fake dir only if `process.env.LOOPSYNC_STUB_GIT=1` — default **throw**. Better: `createWorkspace` copies nothing; throw with a clear message until `server/src/git.ts` exists.
- `stubAdapters`: `run` throws `Error('CLIAdapter not wired')`.

`server/src/index.ts` tries:

```ts
import { createGitRuntime } from './git.ts'; // Person 2
import { createAdapters } from './adapters.ts'; // Person 3
```

If the files are missing, import stubs. Prefer real files: Person 2/3 should add them in parallel with empty `export function createGitRuntime()` returning the interface.

**Verify:** `npx tsc --noEmit`

---

## Step 4 — HTTP only, no loop yet (`server/src/http.ts` + `index.ts`)

Listen **`0.0.0.0:4055`**. `express.json()`. `cors({ origin: true })`.

| Step | Route | Behavior |
|---|---|---|
| 4a | `GET /api/state` | `200` + `getSnapshot()` — empty file shape `protocol/examples/http-get-state-empty.json` |
| 4b | `POST /api/tasks` | Validate JSON. If `provider` not `claude`\|`codex` → **400** `UNKNOWN_PROVIDER` or `BAD_REQUEST` as in `http-error-bad-request.json`. If that provider `isBusy` → **409** `SLOT_BUSY`. Else add queued task, **201** `{ "taskId" }`. Do **not** start the loop yet. |
| 4c | `POST /api/tasks/:id/cancel` | Unknown id → **404** `TASK_NOT_FOUND`. Else `{ "ok": true }`. |
| 4d | `POST /api/reset` | `clear()` store, `{ "ok": true }`. |
| 4e | `express.static` from repo `web/` if the folder exists (Person 4). |

**Verify (must pass before loop):**

```bash
npx tsx server/src/index.ts   # leave running

curl -s http://127.0.0.1:4055/api/state
# {"tasks":[],"slots":[{"provider":"claude","isBusy":false},{"provider":"codex","isBusy":false}]}

curl -s -D- -X POST http://127.0.0.1:4055/api/tasks \
  -H 'content-type: application/json' \
  --data-binary @protocol/examples/http-post-tasks.request.json
# HTTP/1.1 201
# {"taskId":"task_..."}

curl -s -X POST http://127.0.0.1:4055/api/tasks \
  -H 'content-type: application/json' \
  -d '{"title":"x","prompt":"y","provider":"gemini"}'
# 400 error JSON

curl -s -X POST http://127.0.0.1:4055/api/reset
# {"ok":true}
```

---

## Step 5 — `runLoop` in `server/src/loop.ts`

Signature:

```ts
export async function runLoop(opts: {
  taskId: string;
  git: GitRuntime;
  adapters: Record<ProviderType, CLIAdapter>;
  store: Store;
  signal: AbortSignal;
}): Promise<void>
```

Algorithm (do not invent another):

1. `task = getTask(taskId)`. If missing, return.
2. `setBusy(task.provider, true)`.
3. `handle = await git.createWorkspace(taskId)` → set `task.workspaceDir = handle.dir`. Log `[loop] workspace ${dir} branch ${handle.branch}`.
4. For `attempt = 1` to `task.maxIterations`:
   - If `signal.aborted`, set `status: "failed"`, `lastError: "cancelled"`, `setBusy false`, return.
   - `task.currentIteration = attempt`
   - `task.status = attempt === 1 ? 'running' : 'retrying'`
   - `prompt = attempt === 1 ? task.prompt : retryPrompt(task.prompt, task.lastError ?? '')`  
     (`retryPrompt` is exported from `protocol/index.ts`. Attempt 2 text must match `protocol/examples/loop-attempt2-prompt.txt` shape.)
   - Log `[loop] attempt ${attempt}/${task.maxIterations} provider=${task.provider}`
   - `cli = adapters[task.provider]`
   - `result = await cli.run(task.workspaceDir, prompt, onLog, signal)`
   - Log `[cli] exit=${result.exitCode}`
   - `tests = await git.runTests(task.workspaceDir)`
   - If `tests.passed`:
     - `commit = await git.commitIfDirty(dir, \`loopsync: ${task.title}\`)`
     - `task.diff = commit?.diff ?? (await git.getDiff(dir))`
     - `task.commitSha = commit?.sha`
     - `task.status = 'succeeded'`
     - `setBusy false`, return
   - Else `task.lastError = tests.output`, log `[tests] fail exit=${tests.exitCode}`
5. `task.status = 'failed'`, `setBusy false`.

Wire `POST /api/tasks` after 201: `void runLoop(...).catch(err => { status failed; lastError = String(err); setBusy false })`.

Cancel: keep an `AbortController` per `taskId` in a `Map`. Cancel aborts it.

Reset: abort all controllers, `await git.resetAll()`, `store.clear()`.

**Verify without real CLIs:** temporarily stub `adapters.codex.run` to write `return text.length` into `parse.js` in `workspaceDir` using `fs`, then `runTests` should pass. Remove that stub before demo. Real verify is Step 6.

---

## Step 6 — Integration (Person 2 + 3 files exist)

1. Import `createGitRuntime()` and `createAdapters()`.
2. POST `http-post-tasks.request.json` with `"provider":"codex"` (or `claude` if Codex is busy).
3. Poll `GET /api/state` every 300ms until `status` is `succeeded` or `failed` (max ~3 minutes).

**Succeeded must include `commitSha` and `diff`.** Failed must include `lastError` (TAP with `4 !== 5` if they never fixed it).

```bash
curl -s -X POST http://127.0.0.1:4055/api/tasks \
  -H 'content-type: application/json' \
  --data-binary @protocol/examples/http-post-tasks.request.json
# poll
curl -s http://127.0.0.1:4055/api/state | python3 -m json.tool
```

---

## Step 7 — Hour-3 gate (stop UI polish if this fails)

From a terminal, no browser required: launch → real Codex or Claude → tests → SHA or failed with test output.

Rehearse `POST /api/reset` and launch a second time.

---

## Files you may not touch

- `protocol/index.ts` (import only)
- `server/src/git.ts` (Person 2)
- `server/src/adapters.ts` (Person 3)
- `web/*` except serving them (Person 4)
- `fixture/*` (Person 4)

## Done

- Empty GET state matches slot list
- Launch 201 + validation 400/409
- Loop uses `retryPrompt` + Person 2 tests as the only pass/fail judge
- Cancel and Reset work
- Static `web/` served if present
