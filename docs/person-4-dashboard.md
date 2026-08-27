# Person 4 — Dashboard & fixture homework

You own the buggy homework and the screen. You only speak HTTP JSON from [`../protocol/examples/`](../protocol/examples/).

Base URL: `http://127.0.0.1:4055`. Poll **300ms**.

## Fixture files (commit the failing version only)

`fixture/package.json`

```json
{ "type": "module" }
```

`fixture/parse.js`

```js
export function parseIndex(text) {
  return text.length - 1;
}
```

`fixture/parse.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIndex } from './parse.js';

test('length', () => {
  assert.equal(parseIndex('abcde'), 5);
});
```

`git init` inside `fixture/`, one commit of **this failing tree**. Zero npm deps. `node --test` must print `4 !== 5` and exit 1.

Default Launch JSON (wire these as form defaults): [`http-post-tasks.request.json`](../protocol/examples/http-post-tasks.request.json)

```json
{
  "title": "Fix Off-By-One Index in Array Parser",
  "prompt": "The test in parse.test.js fails. Make parseIndex return the correct value so the test passes. Do not change the test. Do not ask questions. Do not run git commit.",
  "provider": "codex",
  "maxIterations": 2
}
```

Provider `<select>` values: `codex` | `claude` only. No Gemini.

## HTTP you call

| Button | Request | Success body | Error body |
|---|---|---|---|
| (interval) | `GET /api/state` | `{ "tasks": TaskState[], "slots": [...] }` | show “Cannot reach orchestrator on :4055” |
| Launch | `POST /api/tasks` + request JSON above | `{ "taskId": "task_01hxyz" }` | 400 `http-error-bad-request.json` or 409 `http-post-tasks.error-slot-busy.json` |
| Cancel | `POST /api/tasks/${taskId}/cancel` | `{ "ok": true }` | 404 TASK_NOT_FOUND |
| Reset | `POST /api/reset` | `{ "ok": true }` | 500 RESET_FAILED |

Until Person 1 is up, render [`http-get-state-succeeded.json`](../protocol/examples/http-get-state-succeeded.json) or [`sample-snapshot.json`](../sample-snapshot.json) from disk. That is layout data, not a fake agent.

## How to paint `TaskState`

| `status` | Badge | Extra |
|---|---|---|
| `queued` | Queued | Attempt 0/N |
| `running` | Running | `Attempt {currentIteration}/{maxIterations}` |
| `retrying` | Retrying | show `lastError` (the `4 !== 5` TAP) |
| `succeeded` | Succeeded | **must** show `commitSha` + `<pre>` `diff` |
| `failed` | Failed | show `lastError`, hide SHA |

`slots[].isBusy` can disable that provider in the dropdown.

Log pane: join `task.logs` with newlines, auto-scroll. Newest at bottom.

Empty `tasks[]`: “No jobs yet. Launch a fix.”

## Layout

Left: title, prompt textarea, provider, Launch, Reset, Cancel.  
Right: badge, logs, lastError, diff, SHA.  
Narrow viewport: stack.

## Done when

1. `cd fixture && node --test` fails with `4 !== 5`
2. UI Launch sends **exactly** the request JSON keys (`title`, `prompt`, `provider`, `maxIterations`)
3. Live: Reset → Launch → logs move → Succeeded+SHA or Failed+error

## Do not

- Fetch git or spawn CLIs from the browser
- Extra JSON fields
- Gemini option
