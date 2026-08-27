# Person 4 — Dashboard & fixture homework

You own what judges look at, and the buggy homework the robots fix. You do not spawn CLIs.

## You own

1. Fixture git repo (`fixture/`)
2. One dashboard page

## Fixture contract (the homework)

**Files (only these needed):**

- `parse.js` — buggy: `parseIndex` returns `text.length - 1`
- `parse.test.js` — `assert.equal(parseIndex('abcde'), 5)` using `node:test`
- `package.json` with `{ "type": "module" }` so ESM imports work
- git initialized, one initial commit of the **buggy** state

**Zero npm dependencies.** Person 2 runs `node --test` only.

**Prompt text** Person 4 (or launcher defaults) should use:

```
The test in parse.test.js fails. Make parseIndex return the correct value so the test passes.
Do not change the test. Do not ask questions. Do not run git commit.
```

**Done when (fixture):** in `fixture/`, `node --test` **fails** with `4 !== 5`. After a one-line fix to `return text.length`, it **passes**. Commit only the failing version.

## Dashboard contract

**Talk only to Person 1:**

- `GET /api/state` → render `ServerSnapshot` (poll every 300ms)
- `POST /api/tasks` with `LaunchTaskBody`
- `POST /api/tasks/:id/cancel`
- `POST /api/reset`

Until Person 1’s server exists, render [`../protocol/sample-snapshot.json`](../protocol/sample-snapshot.json) from a file so layout is not blocked. Swap to fetch when `/api/state` returns.

### Screen

**Left**

- Title (prefilled: Fix Off-By-One Index in Array Parser)
- Prompt (prefilled as above)
- Provider: `claude` | `codex` (no Gemini)
- Launch
- Reset
- Cancel (active task)

**Right**

- Status badge from `task.status` plus `Attempt {currentIteration}/{maxIterations}`
- Log pane: `task.logs` (newest at bottom, auto-scroll)
- `lastError` if present
- Diff (`task.diff`) in a `<pre>`
- Commit SHA when `task.commitSha` exists

### Empty / error

- No tasks: “No jobs yet. Launch a fix.”
- `failed`: show lastError, do not show a success SHA
- Fetch error: “Cannot reach orchestrator on :4055”

Desktop and a narrow mobile column (stack left/right).

## Done when

1. Fixture fails then passes as specified
2. UI can launch a task (or show snapshot mock)
3. After Person 1 is up: Reset → Launch → see logs move → see Succeeded + SHA **or** Failed + error

## Do not

- Call `claude` / `codex` / `git` from the browser
- Invent JSON fields not in `TaskState`
- Build a fake agent to drive the UI; use the sample snapshot for layout only
