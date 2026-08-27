# LoopSync

[github.com/sams222/LoopSync](https://github.com/sams222/LoopSync) — local orchestration for coding CLIs.

State a **goal**. LoopSync splits the work into **tests** and **implementation** (different processes, different context). When Plan and Write are different CLIs, those items run in parallel worktrees and merge. Tests freeze before a SHA is allowed. Coding agents never `git commit`.

Point at an existing folder if you already have a tree. Leave the folder blank to start empty. There is no canned homework test in the default UI.

`POST /api/tasks` without a project still runs the Gate 2 parseIndex fixture.

Gemini CLI is out of scope. There is no fake adapter on the demo.

## Run locally

You need Node 22+, `git`, and either `claude` or `codex` on PATH.

```bash
git clone https://github.com/sams222/LoopSync.git
cd LoopSync
npm install
npm start
```

The server binds `0.0.0.0:4055` and serves the dashboard from `web/`.

```bash
curl -s http://127.0.0.1:4055/api/state

# empty project — orchestrator writes tests + code
curl -s -X POST http://127.0.0.1:4055/api/reset
curl -s -D- -X POST http://127.0.0.1:4055/api/projects \
  -H 'content-type: application/json' \
  --data-binary @protocol/examples/http-post-projects.request.json

# follow-up without Reset
curl -s -D- -X POST http://127.0.0.1:4055/api/projects/<id>/messages \
  -H 'content-type: application/json' \
  --data-binary @protocol/examples/http-post-project-message.request.json

# Gate 2 homework (copies fixture/, locks parse.test.js)
curl -s -X POST http://127.0.0.1:4055/api/reset
curl -s -D- -X POST http://127.0.0.1:4055/api/tasks \
  -H 'content-type: application/json' \
  --data-binary @protocol/examples/http-post-tasks.request.json
```

## Layout

- **[protocol/index.ts](protocol/index.ts)** — frozen types, PORT `4055`, CLI argv (additive fields only)
- **[server/src/](server/src/)** — Express orchestrator, git runtime, Claude/Codex adapters, `runLoop`
- **[web/](web/)** — dashboard (polls every 300ms)
- **[examples/sqrt/](examples/sqrt/)** — optional sample tree you can paste as a folder, not the default job
- **[fixture/](fixture/)** — Gate 2 homework (`4 !== 5`)
- **[docs/PLATFORM.md](docs/PLATFORM.md)** — project-scale orchestration
- **[docs/KERNEL_RISKS.md](docs/KERNEL_RISKS.md)** — spawn, review, oracle, cancel, slots, retry gaps

## Proven CLI flags (do not change)

```bash
claude -p "<task>" --output-format text --dangerously-skip-permissions
codex exec --sandbox workspace-write --skip-git-repo-check "<prompt>"
node --test
```
