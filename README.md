# LoopGrid

Local mission-control for coding CLIs: launch Claude or Codex at an isolated copy of a tiny homework repo, run `node --test`, send failures back, commit only when tests pass.

Gemini CLI is not in scope (Google shut off individual Code Assist for that client). No fake agent on the demo.

## Team docs (read these before coding tomorrow)

- **[docs/TEAM_PLAN.md](docs/TEAM_PLAN.md)** — shared plan, loop, demo script
- **[docs/person-1-orchestrator.md](docs/person-1-orchestrator.md)** — HTTP + retry loop
- **[docs/person-2-git-runtime.md](docs/person-2-git-runtime.md)** — copy, tests, commit, reset
- **[docs/person-3-cli-adapters.md](docs/person-3-cli-adapters.md)** — spawn Claude / Codex
- **[docs/person-4-dashboard.md](docs/person-4-dashboard.md)** — UI + fixture homework

**Frozen types:** [protocol/index.ts](protocol/index.ts)  
**UI mock snapshot:** [protocol/sample-snapshot.json](protocol/sample-snapshot.json)

## Already proven on the demo laptop

```bash
claude -p "<task>" --output-format text --dangerously-skip-permissions
codex exec --sandbox workspace-write --skip-git-repo-check "<task>"
node --test
```

## Run (after tomorrow’s build)

Server on port **4055**. Exact start command lands when Person 1 scaffolds `server/`.
