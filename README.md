# LoopSync

[github.com/sams222/LoopSync](https://github.com/sams222/LoopSync) — local mission control for coding CLIs.

Launch Claude Code or Codex against an isolated copy of a tiny homework repo. LoopSync runs `node --test`, feeds failures back, and git-commits **only if tests pass**. The agent never commits.

Gemini CLI is out of scope (Google shut off individual Code Assist for that client). There is no fake adapter on the demo.

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
# empty snapshot — both slots idle
curl -s http://127.0.0.1:4055/api/state

# Gate 2: reset, launch, poll until succeeded + commitSha or failed + TAP
curl -s -X POST http://127.0.0.1:4055/api/reset
curl -s -D- -X POST http://127.0.0.1:4055/api/tasks \
  -H 'content-type: application/json' \
  --data-binary @protocol/examples/http-post-tasks.request.json
# then poll:
curl -s http://127.0.0.1:4055/api/state
```

Open [http://127.0.0.1:4055](http://127.0.0.1:4055) for Reset → Launch → badge + SHA.

`fixture/` must keep failing (`parseIndex` returns `text.length - 1`; the test expects `5`). LoopSync copies that tree into `/tmp/loopsync-workspaces/<taskId>` before a CLI runs.

## Layout

- **[protocol/index.ts](protocol/index.ts)** — frozen types, PORT `4055`, CLI argv
- **[protocol/examples/](protocol/examples/)** — HTTP and TaskState JSON
- **[server/src/](server/src/)** — Express orchestrator, git runtime, Claude/Codex adapters, `runLoop`
- **[web/](web/)** — vanilla dashboard (polls every 300ms)
- **[fixture/](fixture/)** — homework that `node --test` fails with `4 !== 5`
- **[docs/BUILD_PLAN.md](docs/BUILD_PLAN.md)** — phases and gates

## Team docs

- **[docs/TEAM_PLAN.md](docs/TEAM_PLAN.md)** — overview, demo script
- **[docs/person-1-orchestrator.md](docs/person-1-orchestrator.md)** — Track A (HTTP + loop)
- **[docs/person-2-git-runtime.md](docs/person-2-git-runtime.md)** — Track B (git + tests)
- **[docs/person-3-cli-adapters.md](docs/person-3-cli-adapters.md)** — Track C (Claude / Codex)
- **[docs/person-4-dashboard.md](docs/person-4-dashboard.md)** — Track D (UI + fixture)

## Proven CLI flags (do not change)

```bash
claude -p "<task>" --output-format text --dangerously-skip-permissions
codex exec --sandbox workspace-write --skip-git-repo-check "<task>"
node --test
```
