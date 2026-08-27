# Person 3 — CLI runners (Claude + Codex)

You own “run this robot in this folder.” You do not run tests and you do not commit.

Gemini is **not** your job. Google killed individual Gemini CLI.

## You own

Implement `CLIAdapter` twice: `claudeAdapter`, `codexAdapter`.

Use **execa or Node `spawn` with `shell: false`**. Never `shell: true`.

## Frozen commands (already proven on the demo laptop)

Claude:

```
claude -p "<prompt>" --output-format text --dangerously-skip-permissions
```

Codex:

```
codex exec --sandbox workspace-write --skip-git-repo-check "<prompt>"
```

`cwd` **must** be `workspaceDir`. If you spawn in the wrong folder they will edit the wrong tree.

## Function contract

```ts
run(workspaceDir, prompt, onLog, signal): Promise<{ output: string; exitCode: number }>
```

| Arg | Meaning |
|---|---|
| `workspaceDir` | Person 2’s copy of the homework |
| `prompt` | Full string Person 1 built (attempt 1 or attempt 2 with test output) |
| `onLog(text)` | Call often with new stdout/stderr chunks (Person 1 appends to `task.logs`) |
| `signal` | If aborted, kill the **process group** so Claude/Codex die |

**Out**

- `output`: full captured text
- `exitCode`: process exit code (0 is “CLI exited ok”, **not** “tests passed”)

## Required behavior

- Timeout **120 seconds**, then abort
- Strip ANSI junk if logs look like garbage
- Pass `prompt` as an argv element, not by interpolating into a shell string
- Do not implement CLI session resume. Person 1 calls `run()` again with a new prompt

## Done when

```bash
# Person 2 workspace with the known bug
# Your runner:
#   adapters.codex.run(dir, "In parse.js, make parseIndex return text.length. Do not ask questions.", console.log, ac.signal)
# Then Person 2’s runTests(dir) passes.
# Repeat with claude.
```

You already proved this by hand. Your job is to wrap those exact commands behind `CLIAdapter`.

## Do not

- Add Gemini
- Add a FakeAdapter for the demo
- Run `node --test` inside the adapter
- Run `git commit`
- Change protocol types
