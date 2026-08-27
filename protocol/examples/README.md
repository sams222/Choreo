# JSON contracts

These files are the payloads. TypeScript names live in `../index.ts`.

| File | Who | When |
|---|---|---|
| `http-get-state-empty.json` | P1 serves, P4 renders | After boot / after Reset |
| `http-post-tasks.request.json` | P4 sends, P1 reads | Launch |
| `http-post-tasks.response.json` | P1 sends, P4 reads | Launch 201 |
| `http-post-tasks.error-slot-busy.json` | P1 sends | Second launch while that provider is busy (409) |
| `http-post-cancel.response.json` | P1 | Cancel |
| `http-post-reset.response.json` | P1 | Reset |
| `http-error-bad-request.json` | P1 | 400 |
| `task-queued.json` | P1 snapshot slice | Immediately after launch |
| `task-running.json` | P1 snapshot slice | Attempt 1, CLI still going |
| `task-retrying.json` | P1 snapshot slice | Tests failed, about to run attempt 2 |
| `task-succeeded.json` | P1 snapshot slice | Tests passed, Person 2 committed |
| `task-failed.json` | P1 snapshot slice | Max iterations, tests still red |
| `git-create-workspace.result.json` | P2 → P1 | After copy |
| `git-run-tests-fail.result.json` | P2 → P1 | Stock fixture |
| `git-run-tests-pass.result.json` | P2 → P1 | After a real fix |
| `git-commit.result.json` | P2 → P1 | After `commitIfDirty` |
| `cli-run.result.json` | P3 → P1 | After Claude/Codex process exits |
| `loop-attempt2-prompt.txt` | P1 → P3 | Attempt 2 `run()` prompt |
| `http-post-tasks-reviewer.request.json` | Phase C Launch | Writer + adversarial reviewer |
| `review-ok.txt` / `review-reject.txt` | Reviewer CLI | Machine-readable verdict |
