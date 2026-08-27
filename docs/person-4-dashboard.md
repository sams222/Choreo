# Track D — Dashboard & fixture

**One file for this track.** Builder feeds this to Agent D. Fixture work = Phase 1 (parallel with Track B). UI = Phase 3 (**after Gate 2**).

**Writes:** `web/index.html`, `web/app.js`, `web/styles.css`; `git init` on existing `fixture/`  
**Does not:** spawn CLIs, git from the browser, Gemini, extra JSON keys, Socket.IO, Vite unless it works in 15 minutes, edit `protocol/index.ts`

Base URL: `http://127.0.0.1:4055`. Poll **300ms**.

---

## Contract — fixture (already in repo; keep it failing)

```js
// parse.js
export function parseIndex(text) { return text.length - 1; }
```

```js
// parse.test.js — node:test, assert.equal(parseIndex('abcde'), 5)
```

```json
{ "type": "module" }
```

`node --test` must print `4 !== 5` and exit 1.

Launch defaults (`http-post-tasks.request.json`):

```json
{
  "title": "Fix Off-By-One Index in Array Parser",
  "prompt": "The test in parse.test.js fails. Make parseIndex return the correct value so the test passes. Do not change the test. Do not ask questions. Do not run git commit.",
  "provider": "codex",
  "maxIterations": 2
}
```

Provider select: `codex` | `claude` only.

| UI | Request | Success | Error |
|---|---|---|---|
| poll | `GET /api/state` | `ServerSnapshot` | “Cannot reach orchestrator on :4055” |
| Launch | `POST /api/tasks` | `{ "taskId" }` | 400 / 409 |
| Cancel | `POST /api/tasks/:id/cancel` | `{ "ok": true }` | 404 |
| Reset | `POST /api/reset` | `{ "ok": true }` | |

Paint: queued / running / retrying (`lastError`) / succeeded (`commitSha` + `diff`) / failed (`lastError`, hide SHA). Empty: “No jobs yet. Launch a fix.”

---

## Steps

### Step 1 — Phase 1: fixture git (parallel with Track B)

If `fixture/.git` missing:

```bash
cd fixture
git init
git add parse.js parse.test.js package.json
git -c user.email=choreo@local -c user.name=Choreo commit -m "failing parseIndex"
```

**Verify:** `cd fixture && node --test` fails `4 !== 5`. Do not commit a passing `parse.js`.

### Step 2 — Page shell (may mock until Gate 2)

Two columns. Left: title, prompt, provider, Launch, Cancel, Reset. Right: `#status` `#attempt` `#logs` `#lastError` `#diff` `#sha`. Mock: `protocol/examples/http-get-state-succeeded.json` behind `USE_MOCK`.

### Step 3 — `render(snapshot)`

Latest task `tasks.at(-1)`. Only `TaskState` keys. Disable busy providers.

**Verify:** mock retrying → `4 !== 5`, no SHA; failed → no SHA; empty → empty copy.

### Step 4 — Live HTTP (after Gate 2 / Track A is up)

`USE_MOCK = false`. Same-origin or `http://127.0.0.1:4055`. Launch body exact keys from the contract.

**Verify:** Reset → Launch Codex → logs → Succeeded+SHA or Failed+TAP. Repeat Claude.

### Step 5 — Layout

Desktop left ~360px; `max-width: 700px` stack. Hit targets ≥ 44px. No component library required.

### Step 6 — Demo pass

Reset → Launch → Attempt 1 (fail or pass, both real) → maybe Retrying → Succeeded + SHA.

---

## Done

Fixture still fails. Frozen JSON keys only. Poll 300ms. Empty / error / success / fail handled. No Gemini.
