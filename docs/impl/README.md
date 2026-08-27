# Agent playbooks

The **Builder** (one human) feeds **one** of these files to an agent, plus `protocol/index.ts` and `protocol/examples/`. Other humans debug or plan the talk — see [BUILD_PLAN.md](../BUILD_PLAN.md).

Do not edit `protocol/index.ts` unless the Builder agrees.

| Track | Playbook | Writes | When |
|---|---|---|---|
| A | [person-1-orchestrator.md](person-1-orchestrator.md) | `package.json`, `tsconfig.json`, `server/src/{index,http,loop,state}.ts` | Phase 0 steps 1–4; Phase 2 steps 5–7 |
| B | [person-2-git-runtime.md](person-2-git-runtime.md) | `server/src/git.ts` only | Phase 1, parallel with fixture |
| C | [person-3-cli-adapters.md](person-3-cli-adapters.md) | `server/src/adapters.ts` only | Phase 2, before `runLoop` |
| D | [person-4-dashboard.md](person-4-dashboard.md) | `web/*`, git-init `fixture/` | Fixture in Phase 1; UI only after Gate 2 |

Max two code agents at once (Phase 1). Never four humans each coding a playbook.
