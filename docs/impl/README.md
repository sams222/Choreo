# Agent playbooks

Feed **one** of these files to an agent, plus `protocol/index.ts` and `protocol/examples/`.

Do not edit `protocol/index.ts` unless the whole team agrees.

| Agent | Playbook | Writes |
|---|---|---|
| Person 1 | [person-1-orchestrator.md](person-1-orchestrator.md) | `package.json`, `tsconfig.json`, `server/src/{index,http,loop,state}.ts` |
| Person 2 | [person-2-git-runtime.md](person-2-git-runtime.md) | `server/src/git.ts` only |
| Person 3 | [person-3-cli-adapters.md](person-3-cli-adapters.md) | `server/src/adapters.ts` only |
| Person 4 | [person-4-dashboard.md](person-4-dashboard.md) | `web/*`, git-init `fixture/` |

Person 1 must exist first as a compile skeleton, or Person 2/3 write files that Person 1 imports. Preferred: Person 1 step 1–3 (scaffold + stubs), then 2 and 3 in parallel, then Person 1 loop + HTTP, then Person 4 against live `/api`.
