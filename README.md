# LoopSync

[github.com/sams222/LoopSync](https://github.com/sams222/LoopSync) — local mission control for coding CLIs.

Point LoopSync at a folder, describe a goal, and pick who **plans**, **writes**, and **reviews**. LoopSync copies that tree into an isolated workspace, runs the writer CLI, judges with a **locked oracle** (the only SHA veto), optionally runs a **separate reviewer** process on green tests, and git-commits only if both gates pass. Coding agents never commit.

The dashboard is a thread, not a one-shot Launch. Follow-ups go to the orchestrator, patch the plan, and re-enqueue `runLoop` on the **same** project workspace. They do not skip the oracle.

`fixture/` (the parseIndex homework) is still a Gate 2 demo via `POST /api/tasks`. It is no longer the only project. The default UI job is `examples/sqrt`.

Gemini CLI is out of scope. There is no fake adapter on the demo.

## Run locally

You need Node 22+, `git`, and either `claude` or `codex` on PATH (the demo laptop already has both).

```bash
git clone https://github.com/sams222/LoopSync.git
cd LoopSync
npm install
npm start
```

The server binds `0.0.0.0:4055` and serves the dashboard from `web/`.

```bash
# empty snapshot — both slots idle, defaults point at examples/sqrt
curl -s http://127.0.0.1:4055/api/state

# Phase D: integerSqrt project (not parseIndex)
curl -s -X POST http://127.0.0.1:4055/api/reset
curl -s -D- -X POST http://127.0.0.1:4055/api/projects \
  -H 'content-type: application/json' \
  --data-binary @protocol/examples/http-post-projects.request.json

# follow-up without Reset (Phase E thread)
curl -s -D- -X POST http://127.0.0.1:4055/api/projects/<id>/messages \
  -H 'content-type: application/json' \
  --data-binary @protocol/examples/http-post-project-message.request.json

# Gate 2 homework still works (copies fixture/, locks parse.test.js)
curl -s -X POST http://127.0.0.1:4055/api/reset
curl -s -D- -X POST http://127.0.0.1:4055/api/tasks \
  -H 'content-type: application/json' \
  --data-binary @protocol/examples/http-post-tasks.request.json
```

Open [http://127.0.0.1:4055](http://127.0.0.1:4055). Paste a folder, set the goal, Run. After the first pass, steer with a follow-up such as “switch the algorithm to binary search.”

## Layout

- **[protocol/index.ts](protocol/index.ts)** — frozen types, PORT `4055`, CLI argv (additive fields only)
- **[protocol/examples/](protocol/examples/)** — HTTP and TaskState JSON
- **[server/src/](server/src/)** — Express orchestrator, git runtime, Claude/Codex adapters, `runLoop`
- **[web/](web/)** — vanilla dashboard (polls every 300ms)
- **[examples/sqrt/](examples/sqrt/)** — Phase D demo: `integerSqrt` / locked `sqrt.test.js`
- **[fixture/](fixture/)** — homework that `node --test` fails with `4 !== 5`
- **[docs/PLATFORM.md](docs/PLATFORM.md)** — project-scale orchestration (goal → plan → judged steps)
- **[docs/KERNEL_RISKS.md](docs/KERNEL_RISKS.md)** — spawn, review, oracle, cancel, slots, retry gaps

## Proven CLI flags (do not change)

```bash
claude -p "<task>" --output-format text --dangerously-skip-permissions
codex exec --sandbox workspace-write --skip-git-repo-check "<prompt>"
node --test
```
