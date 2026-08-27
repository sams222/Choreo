# Person 1 — Orchestrator & HTTP

You own the product brain. JSON you serve is under [`../protocol/examples/`](../protocol/examples/).

Bind **`0.0.0.0:4055`**. `Content-Type: application/json`. Person 4 polls `GET /api/state` every **300ms**. No Socket.IO.

## HTTP table

| Status | Method | Path | Request JSON | Response JSON |
|---|---|---|---|---|
| 200 | GET | `/api/state` | — | `http-get-state-empty.json` or snapshot with `tasks[]` |
| 201 | POST | `/api/tasks` | `http-post-tasks.request.json` | `http-post-tasks.response.json` `{ "taskId" }` |
| 400 | POST | `/api/tasks` | missing fields / `provider: "gemini"` | `http-error-bad-request.json` |
| 409 | POST | `/api/tasks` | same `provider` already `isBusy` | `http-post-tasks.error-slot-busy.json` |
| 200 | POST | `/api/tasks/:id/cancel` | — | `{ "ok": true }` |
| 404 | POST | `/api/tasks/:id/cancel` | unknown id | `{ "error": { "code": "TASK_NOT_FOUND", "message": "..." } }` |
| 200 | POST | `/api/reset` | — | `{ "ok": true }` |

CORS: `http://127.0.0.1:4055`, `http://localhost:4055`, and Vite origin if Person 4 uses one (`http://127.0.0.1:4173` is fine if you add it). Allow `GET, POST, OPTIONS`.

`maxIterations` defaults to **2** if omitted. Reject any `provider` other than `"claude"` | `"codex"`.

One job **per provider**. Two providers may run at once only if you have time; MVP is one task total.

## `TaskState` you mutate (exact keys)

Copy shapes from:

- queued → `task-queued.json` (`currentIteration: 0`, `workspaceDir: ""`, `logs: []`)
- running → `task-running.json`
- retrying → `task-retrying.json` (`lastError` = **Person 2 test output**, not CLI chat)
- succeeded → `task-succeeded.json` (`diff` + `commitSha` required)
- failed → `task-failed.json` (no `commitSha`)

`id` format: `task_` + lowercase unique suffix (cuid/ulid/random). Person 4 does not care as long as it is stable.

## `runLoop` implementation (do not invent a second one)

```
git.createWorkspace(taskId) → { dir, branch }
task.workspaceDir = dir
task.slots[provider].isBusy = true

for attempt from 1 to task.maxIterations:
  task.currentIteration = attempt
  task.status = attempt === 1 ? 'running' : 'retrying'
  prompt = attempt === 1 ? task.prompt : retryPrompt(task.prompt, task.lastError)
  log `[loop] attempt ${attempt}/${max} provider=${provider}`
  cli = adapters[task.provider]
  { output, exitCode } = await cli.run(dir, prompt, chunk => task.logs.push(chunk), signal)
  log `[cli] exit=${exitCode}`
  tests = await git.runTests(dir)
  if tests.passed:
    commit = await git.commitIfDirty(dir, `loopgrid: ${task.title}`)
    task.diff = commit?.diff ?? (await git.getDiff(dir))
    task.commitSha = commit?.sha
    task.status = 'succeeded'
    isBusy = false
    return
  task.lastError = tests.output
  log `[tests] fail exit=${tests.exitCode}`

task.status = 'failed'
isBusy = false
```

Attempt 2 prompt file (byte-for-byte contract): [`../protocol/examples/loop-attempt2-prompt.txt`](../protocol/examples/loop-attempt2-prompt.txt)

`retryPrompt()` is already in `protocol/index.ts`. Use it.

On **cancel**: abort the `AbortSignal`, set `status: "failed"`, `lastError: "cancelled"`, `isBusy: false`. Still call nothing that commits.

On **reset**: abort running work, `await git.resetAll()`, `tasks = []`, both slots `isBusy: false`. Return empty snapshot.

## Logs

Person 3 will `onLog` raw CLI text (Codex prints `OpenAI Codex v0.149.0`, `apply patch`, etc.). Prefix your own lines with `[loop]`, `[tests]`, `[git]`. Keep `logs` as an array of strings. If a chunk has newlines, split into multiple entries.

Cap logs at ~500 lines (shift oldest) so the JSON snapshot stays small.

## Done when

```bash
curl -s http://127.0.0.1:4055/api/state
# → http-get-state-empty.json shape

curl -s -D- -X POST http://127.0.0.1:4055/api/tasks \
  -H 'content-type: application/json' \
  --data-binary @protocol/examples/http-post-tasks.request.json
# → 201 { "taskId": "..." }

# poll until status is succeeded or failed
curl -s http://127.0.0.1:4055/api/state
```

Succeeded must include `commitSha`. Failed must include `lastError`. Never leave `running` after both the CLI and tests have returned.

## Do not

- Spawn `claude` / `codex`
- `git commit`
- Extra routes
- Gemini
- Socket.IO as a requirement
