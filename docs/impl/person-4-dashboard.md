# Person 4 — step-by-step implementation (agent playbook)

You are Person 4. You own the homework fixture and the dashboard.

**Read first:** `docs/person-4-dashboard.md`, `protocol/examples/http-post-tasks.request.json`, `protocol/examples/http-get-state-*.json`, `protocol/examples/task-*.json`.

**Do not:** spawn CLIs, call `git` from the browser, add Gemini, invent JSON keys, add Socket.IO, edit `protocol/index.ts`.

**Write:** `web/index.html`, `web/app.js`, `web/styles.css` (names may vary but keep under `web/`). Person 1 serves `web/` as static files on **:4055**. Prefer **no Vite** unless you already have it working in 15 minutes; vanilla JS is enough.

Fixture sources already exist in `fixture/`. You still git-init them (Step 1).

---

## Step 1 — Fixture as a git repo (failing HEAD)

Files already in repo (do not change the bug):

- `fixture/package.json` → `{ "type": "module" }`
- `fixture/parse.js` → `return text.length - 1`
- `fixture/parse.test.js` → `assert.equal(parseIndex('abcde'), 5)`

If `fixture/.git` is missing:

```bash
cd fixture
git init
git add parse.js parse.test.js package.json
git -c user.email=loopsync@local -c user.name=LoopSync commit -m "failing parseIndex"
cd ..
```

**Verify:**

```bash
cd fixture && node --test; echo exit=$?
# fail, 4 !== 5, exit=1
```

Do not commit a passing `parse.js`. Person 2 copies this tree.

---

## Step 2 — Static page shell (no API yet)

`web/index.html`: two columns.

**Left**

- Title input, default: `Fix Off-By-One Index in Array Parser`
- Prompt textarea, default: exact string from `http-post-tasks.request.json` `prompt`
- `<select id="provider">` options `codex`, `claude` only
- Buttons: Launch, Cancel, Reset

**Right**

- Badge `#status`
- `#attempt` text `Attempt x/y`
- `#logs` pre, auto-scroll
- `#lastError` pre
- `#diff` pre
- `#sha` code

Empty copy: “No jobs yet. Launch a fix.”

Until the server exists, load `protocol/examples/http-get-state-succeeded.json` via fetch from a static path **or** paste it as `MOCK` in `app.js` behind `const USE_MOCK = true`.

**Verify:** open the HTML, mock succeeded state shows badge Succeeded, a SHA, and a diff with `text.length`.

---

## Step 3 — Paint function (single renderer)

`function render(snapshot: ServerSnapshot)`

- `tasks[0]` is the selected/latest task (MVP: only one job; render `tasks.at(-1)` or the newest).
- Map `status` → badge label: queued / running / retrying / succeeded / failed.
- Show `Attempt ${currentIteration}/${maxIterations}`.
- `logs` joined with `\n`.
- If `lastError`, show it (retrying/failed).
- If `commitSha` and `status === 'succeeded'`, show SHA + `diff`. If `failed`, hide SHA.
- `slots`: disable provider option when `isBusy`.
- Fetch error: banner “Cannot reach orchestrator on :4055”.

Use only keys from `TaskState`. No extras.

**Verify:** swap mock to `task-retrying.json` inside a snapshot — lastError shows `4 !== 5`, no SHA. Swap to `task-failed.json` — Failed, no SHA. Swap empty snapshot — empty copy.

---

## Step 4 — Live HTTP (Person 1 on :4055)

`API = ''` (same origin) or `http://127.0.0.1:4055` if you open the file via another origin.

| UI | Request | Body | Success | Error |
|---|---|---|---|---|
| interval 300ms | `GET /api/state` | — | `render(json)` | show unreachable |
| Launch | `POST /api/tasks` | `{ title, prompt, provider, maxIterations: 2 }` **exact keys** from the form | ignore `taskId` except for Cancel | 400/409 show `error.message` |
| Cancel | `POST /api/tasks/${id}/cancel` | — | ok | 404 |
| Reset | `POST /api/reset` | — | ok, then next poll is empty | — |

Set `USE_MOCK = false` when GET `/api/state` returns 200.

Launch body must match `http-post-tasks.request.json` field names. `Content-Type: application/json`.

**Verify with Person 1 HTTP-only (loop not required):** Launch → poll shows `queued` or `running`. Reset → empty tasks.

**Verify with full loop:** Reset → Launch Codex → logs move → Succeeded + SHA **or** Failed + TAP. Repeat with Claude.

---

## Step 5 — Layout

Desktop: left ~360px, right flex. Mobile (`max-width: 700px`): stack. Buttons ≥ 44px hit area. Do not require a component library.

---

## Step 6 — Demo pass

1. Reset  
2. Launch default prompt, provider Codex  
3. Watch Attempt 1 (maybe already green — still real)  
4. If red: Retrying + `4 !== 5`  
5. Succeeded + colored/plain diff + SHA  

If Person 1 is down, demo the mock succeeded snapshot and say the API is next — last resort only.

## Done

- Fixture still fails on `node --test`
- UI sends only frozen JSON keys
- Poll 300ms
- Empty / error / succeeded / failed all handled
- No Gemini in the select
