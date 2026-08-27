# LoopSync

[github.com/sams222/LoopSync](https://github.com/sams222/LoopSync) — a platform for orchestrating CLI AI agents.

Local mission-control: launch Claude or Codex at an isolated copy of a tiny homework repo, run `node --test`, send failures back, commit only when tests pass.

Gemini CLI is not in scope (Google shut off individual Code Assist for that client). No fake agent on the demo.

## Team docs (read these before coding tomorrow)

- **[docs/TEAM_PLAN.md](docs/TEAM_PLAN.md)** — overview, demo script
- **[docs/BUILD_PLAN.md](docs/BUILD_PLAN.md)** — phases, gates, parallel-agent graph
- **[docs/WORKFLOW.md](docs/WORKFLOW.md)** — user → HTTP → loop
- **[docs/PHASE_C.md](docs/PHASE_C.md)** — after Gate 2: independent steps, oracle lock, reviewer (playbook [person-5](docs/person-5-phase-c.md))
- **[docs/person-1-orchestrator.md](docs/person-1-orchestrator.md)** — Track A (HTTP + loop)
- **[docs/person-2-git-runtime.md](docs/person-2-git-runtime.md)** — Track B (git + tests)
- **[docs/person-3-cli-adapters.md](docs/person-3-cli-adapters.md)** — Track C (Claude / Codex)
- **[docs/person-4-dashboard.md](docs/person-4-dashboard.md)** — Track D (UI + fixture)

**Frozen types:** [protocol/index.ts](protocol/index.ts)  
**JSON payloads:** [protocol/examples/](protocol/examples/)  
**UI mock snapshot:** [protocol/sample-snapshot.json](protocol/sample-snapshot.json)  
**Homework:** [fixture/](fixture/) (`node --test` must fail with `4 !== 5`)

## Already proven on the demo laptop

```bash
claude -p "<task>" --output-format text --dangerously-skip-permissions
codex exec --sandbox workspace-write --skip-git-repo-check "<task>"
node --test
```

## Clone

```bash
git clone https://github.com/sams222/LoopSync.git
cd LoopSync
```

The `server/` and `web/` apps are not in this commit yet. Start from [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md).
