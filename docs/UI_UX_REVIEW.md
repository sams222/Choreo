# LoopSync — UI/UX review and demo plan

Reviewed at commit `630c37c` (main). Scope: the dashboard in [`web/`](../web/), the state it renders from [`server/src/`](../server/src/), and what it will take to wow judges. Kernel-level risks are already covered in [`KERNEL_RISKS.md`](KERNEL_RISKS.md); this doc stays on the product surface.

## TL;DR

The backend produces far more drama than the UI shows. You have separate processes per role, parallel worktrees, a tamper-proof oracle, adversarial cross-model review, and a Node-owned commit — and the UI renders most of it as one prose sentence in a header pill plus an 8-line log tail. The single highest-leverage change is **switching the CLI adapters to structured JSON event streams** (`claude -p --output-format stream-json`, `codex exec --json`) so the UI can say *"Claude is editing `sqrt.test.js`"* and *"Codex ran `node --test`"* instead of narrating "Awaiting the code writer". The second is **rendering the data you already collect and never show**: `task.steps`, `task.diff`, per-event timestamps, and the two-column parallel run. The third is committing fully to the single-thread Cursor-style session you already started — one composer, everything in the thread.

What's genuinely good already: the invariant-first copy ("tests freeze before a SHA", "coding agents never git commit") is a real differentiator and the UI keeps repeating it; the awaiting-states feed is the right skeleton; the oracle chip and locked file chips are the right instinct.

---

## 1. The core problem: the UI narrates instead of showing

Every live state is a hand-written sentence chosen by a big `if/else` (`web/app.js:167-240`). The sub-copy *tells* the judge that Codex is implementing against frozen tests; nothing on screen *shows* a model doing anything. The only evidence of life is:

- an 8-line stripped log tail (`usefulLogs`, `web/app.js:353-359`), and
- three rotating fake "waiting beats" ("Still waiting — the process is up, no tokens yet", `web/app.js:339-347`).

Rotating filler text is worse than a spinner: judges will read it twice, realize it's canned, and discount everything else on screen. Real activity — tool calls, file edits, test commands, token streams — is the thing that makes an orchestration demo feel alive, and the raw material for it is already flowing through `onLog` into `task.logs`; it's just unstructured text.

The invisible-work problem is worst in three places:

1. **Planning is completely dark.** During `POST /api/projects` the planner CLI runs for up to 120s with its output deliberately discarded (`server/src/http.ts:609-616` — `onLog` is a no-op) and the HTTP response doesn't return until it finishes. Same for steering (`server/src/http.ts:714-721`). The orchestrator — the star of an *orchestration* demo — is the one agent whose thinking is never shown.
2. **Parallelism is invisible.** The parallel tests/code run in separate worktrees is your best wow moment, and when it happens the header collapses both agents into one line ("Awaiting the unit test writer and the code writer", `web/app.js:260-266`) and the single-column feed interleaves two working bubbles. Judges cannot tell two models are racing.
3. **The payoff is invisible.** After a green run you show "Done — snapshot abc123def". `task.diff` is captured at commit (`server/src/loop.ts:504-506`) and never rendered anywhere. The diff *is* the product — the moment that proves the models did real work.

## 2. Data you already have but never render

This is the cheapest wow available — no backend changes, just rendering:

| Data | Where it's produced | Current UI |
| --- | --- | --- |
| `task.steps` (writer/tests/review/git with pending/running/ok/fail/skipped) | `server/src/loop.ts` `setStep` | Never referenced in `app.js`. This is a ready-made per-task step tracker. |
| `task.diff` | `server/src/loop.ts:504-506` | Never rendered. Show it on the commit bubble with a real diff view. |
| `task.currentIteration` / `maxIterations` / `capsRemaining` | loop | Never shown. "Attempt 2 of 2" is honest tension judges enjoy. |
| `task.lastReview` verdict | `server/src/loop.ts:432` | Only implied by a timeline bubble title. Deserves a green/red verdict badge. |
| `ChatMessage.ts` timestamps | `protocol/index.ts:145` | Not rendered; feed has no times, elapsed clock resets on page reload (`web/app.js:299-337` is client-clock only). |
| `PlanItem.doneWhen` | planner output | Dropped on the floor in `renderPlan`. "Done when: tests pass" is exactly the contract language you want judges to read. |
| Ledger (`data/loopsync-ledger.jsonl`) | `server/src/ledger.ts` | Unused by the UI. It's a free replay/timeline source (see §6). |

## 3. The single-thread session — commit to your own vision

The Cursor-style direction is right and half-built. What blocks it today:

- **Two composers.** The launch form and the follow-up form are separate `<form>`s swapped by `hidden` (`web/index.html:57-133`). Make it one composer that never moves: the first message creates the project, later messages steer. Folder/title/provider pickers become a collapsible "settings" row above the composer, not a separate mode.
- **You can't actually steer mid-run.** The vision is "planning, steering and what not all happens at once", but Send is disabled while anything is in flight (`web/app.js:132`) and the server rejects with `SLOT_BUSY` (`server/src/http.ts:663-671`). Minimum viable fix: accept the message, append it to the thread immediately, and apply it at the next loop boundary (before the next attempt/step) — a "queued, applies before the next step" chip on the message. Cancel-and-replan can stay a button on the queued message. Steering an agent *while it runs* is the single most impressive interaction you could show.
- **The plan lives outside the chat.** The pipeline strip (`web/index.html:35`, `renderPlan` at `web/app.js:365-398`) is disconnected from the thread. Render the plan as an **orchestrator chat card**: the orchestrator's reply bubble contains the plan items with live status dots, files, and `doneWhen`. When steering replaces the plan, post a new card showing what changed (item added/removed/edited) instead of silently swapping the strip. A compact mirrored stepper in the sticky header is fine to keep.
- **Feed assembly is a client-side guess.** `buildFeed` zippers messages and tasks with an index heuristic (`web/app.js:494-517` — `userIdx`/`extraUsers`/`take` math). It will mis-order the moment the flow gets any more complex. Fix it at the source: give every event a timestamp and let the server return one chronological `thread` array in the snapshot (additive field, protocol allows it). The client should render, not reconstruct history.

## 4. Make the models visible actors

For a "different models cooperating" pitch, the models need persistent visual identity:

- **Per-provider identity**: avatar + fixed color per provider (Claude and Codex), shown on every bubble, plan item, and live card — not buried mid-sentence in sub-copy (`prettyProvider` interpolation, `web/app.js:236-238`). Role is the label, provider is the identity: "**Claude** · test author", "**Codex** · implementer", "**Claude** · adversarial reviewer". The cross-model review ("Claude is reviewing Codex's diff — and did not write this code") should be impossible to miss.
- **Rename the vague roles.** "Saver" (`ROLE_WHO`, `web/app.js:12-19`) reads like a typo. "Git (Node-owned)" teaches the invariant. "Orchestrator / Test author / Implementer / Reviewer / Git" is a clean cast list.
- **Slot strip.** Two always-visible slot chips (Claude: busy on *tests* · Codex: idle) — you already track `slots`; today busyness only manifests as disabled `<option>`s, which nobody notices.
- **The oracle freeze deserves a moment.** The chip (`web/app.js:632-643`) is the right idea; when tests freeze, animate the transition (files slide into a lock, chip flips from "Tests not frozen yet" to "Locked · sqrt.test.js") and post a system bubble in the thread: "🔒 2 test files frozen. From here, `node --test` is the only SHA veto." The demo's whole thesis in one beat.

## 5. Technical work, ranked

### P0 — do these for the demo

**1. Structured event streams from both CLIs.** Replace `--output-format text` with `--output-format stream-json --verbose` for Claude (add `--include-partial-messages` if you want token-level streaming) and `--json` for Codex (`codex exec --json` emits JSONL events — verify the exact event names on the demo laptop, it's the less stable of the two). Parse JSONL in `adapters.ts` and emit typed events instead of raw text: `tool_use` (name + file path/command), `text` (assistant prose), `result` (Claude's result event even includes `duration_ms`, `num_turns`, and `total_cost_usd` — free metrics for the UI). Protocol change is additive: an `AgentEvent[]` on the task or a new `onEvent` callback beside `onLog`. Then the live card can render a real activity feed: *"✏️ editing `sqrt.js` · 🔧 ran `node --test` · 💬 'The failing case is negative inputs…'"*. This is the difference between claiming orchestration and showing it. (Bonus: parsing the `result` event kills the KERNEL_RISKS #1 problem of exit-code-0-means-done for the Claude side.)

**2. Push instead of poll.** Add an SSE endpoint (`GET /api/events`) that pushes snapshot revisions or individual events; keep 300ms polling as a fallback. Express needs ~15 lines. This makes streams feel live instead of chunked at 300ms, and stops shipping the full state (all tasks × 500 log lines) 3× per second (`web/app.js:2,849`).

**3. Render steps, diff, attempts, verdict** (§2). The step tracker on each work item, a real diff view on the commit bubble (vendor a tiny highlighter or hand-roll +/- coloring — it's your server, no CDN constraints), "attempt 2/2", and a review verdict badge.

**4. The parallel race view.** When `project.shards` exists, split the stage into two live columns — test author left, implementer right, each with its own identity header, step tracker, and activity stream — converging into a centered merge node when both finish. This is the screenshot judges remember. The merge state itself currently renders as one working bubble (`web/app.js:520-530`); give it its own visual (two branches joining) and then the freeze beat from §4.

**5. One composer, mid-run steering** (§3).

### P1 — strong upgrades if time remains

6. **Async planning with visible output.** Return from `POST /api/projects` immediately (project exists in the store before the planner runs, so polling already renders it), run the planner in the background, and stream its output into a live orchestrator bubble instead of discarding it. Same for steering. Also removes the 2-minute hanging fetch.
7. **Timestamps + durations everywhere.** Add `ts` to `TimelineEvent` (additive), render relative times on bubbles and per-step durations ("tests · 12s"). Server-authoritative elapsed instead of the client clock that resets on reload.
8. **Kill the fake waiting beats.** Elapsed time + last real event + a countdown to the 120s CLI timeout (`CLI_TIMEOUT_MS`, `protocol/index.ts:298`). If the timeout fires mid-demo you want the UI to have been showing "94s / 120s" rather than "no tokens yet" forever. Consider raising the timeout for demo goals — 120s is tight for a real feature.
9. **Plan-as-chat-card with diffed replans** (§3).
10. **Surface `exitCode`/timeout distinctly.** The adapter resolves on timeout like success (KERNEL_RISKS #1); until that's fixed at the loop level, at least badge the bubble "timed out after 120s" instead of "wrote code".

### P2 — polish

- **Ledger-powered replay mode.** `data/loopsync-ledger.jsonl` already records every run. A `?replay=<taskId>` mode that re-renders a past run at 10× speed is demo insurance against live CLI flakiness or hotel wifi — you can rehearse the exact 90-second arc.
- Remove the `scrubHomeworkAutofill` triple-`setTimeout` hack (`web/app.js:844-847`) — with the form fields renamed (`ls-folder` etc.) it should no longer be needed; if autofill still bites, `autocomplete="new-password"` on the inputs is the standard escape.
- `maxIterations` is hardcoded to 2 in the client (`web/app.js:770`) — a small stepper in settings, since "watch it retry" is a good demo beat.
- Font stack leads with "Segoe UI" (`web/styles.css:18`) — on the Linux demo laptop that falls through inconsistently; lead with `Inter` (vendored) or `system-ui`.
- Feed accessibility: add `aria-live="polite"` to the feed region; status is currently conveyed by color alone in several places (plan dots, badges) — add icons/text.

## 6. The 90-second demo arc this buys you

1. Type a goal in the one composer. Orchestrator bubble **streams its plan live** (P1.6), resolving into a plan card: two items, tests + implementation, with `doneWhen` contracts.
2. Stage splits into the **race view**: Claude authoring tests on the left, Codex implementing on the right, real tool actions ticking in each column ("editing `sqrt.test.js`", "ran `node --test`"). Slot chips both hot.
3. Both finish → **merge animation** → 🔒 **freeze beat**: test files lock, system bubble states the invariant.
4. `node --test` runs — the only SHA veto. Green.
5. **Claude reviews Codex's diff** — adversarial bubble with verdict badge. (Pick providers so reviewer ≠ writer; the UI should brag about it.)
6. Commit bubble: SHA, **rendered diff**, per-step durations, cost from the `result` events.
7. Type a steering message **while the next item runs** — it lands in the thread instantly with a "applies before next step" chip. Orchestrator posts the plan delta.

Every beat is something the current backend already does or nearly does; the work is making it visible.

## 7. Notes outside the UI (brief)

- `POST /api/projects` and `/messages` doing multi-minute CLI work before responding is the biggest architectural smell touching UX (P1.6). Everything else backend-side that worries me is already in [`KERNEL_RISKS.md`](KERNEL_RISKS.md) — of those, #1 (timeout resolves as success) is the one most likely to embarrass you *on stage*, because the UI will cheerfully say "Codex wrote code" over an empty diff.
- The `buildFeed` reconstruction heuristic (§3) is the most fragile code in `web/` — server-side thread assembly removes a whole bug class before you add more event types to the feed.
- `phase-d.test.ts` covers the loop well; there are no tests over `buildFeed`/render logic, which is where the demo-day bugs will live. Even one Node test over `buildFeed` with a synthetic snapshot would pay off.
