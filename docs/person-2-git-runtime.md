# Person 2 — Git & tests

You own the homework copy, the answer key, and the receipt (commit SHA). You do not talk to Claude or Codex.

## You own

Implement `GitRuntime` from `protocol/index.ts`.

## You do not own

- HTTP
- CLI spawn
- Dashboard

## Isolation (keep it dumb)

Do **not** start with git worktrees. One job at a time.

**In:** fixture repo path (Person 4’s `fixture/`, a real git repo with the buggy code).

**createWorkspace(taskId)**

- Copy fixture to something like `/tmp/loopgrid-workspaces/<taskId>` (`fs.cp` recursive), **or** `git clone` the fixture into that dir
- `git checkout -b loopgrid/<taskId>` so commits are not on main
- **Out:** `{ dir, branch }`
- `dir` must contain `parse.js` and `parse.test.js` and be a git repo

## Functions

### `runTests(dir)`

- **In:** absolute workspace dir
- Run: `node --test` with `cwd: dir` (no shell)
- **Out:** `{ passed: true/false, output: string }`
- `passed === true` only if exit code 0
- `output` is stdout+stderr (this is what Person 1 stuffs into attempt 2)

### `getDiff(dir)`

- **Out:** `git diff` (and `git diff --cached` if needed) as a string Person 4 can show
- Empty string if nothing changed

### `commitIfDirty(dir, message)`

- Stage all (`git add -A`)
- If nothing to commit, return `null`
- Else commit with `message`, **Out:** `{ sha: full or short hash, diff: string }`
- Configure `user.email` / `user.name` locally in that repo if needed so commit does not hang on git identity

### `resetAll()`

- Kill leftover dirs under `/tmp/loopgrid-workspaces`
- Do not delete Person 4’s original `fixture/`

## Done when

```bash
# from a tiny test script you write
dir=$(node -e '...') # createWorkspace
node --test           # inside dir: FAIL on the stock fixture
# manually fix parse.js to return text.length
# runTests → passed true
# commitIfDirty → sha printed
# resetAll → dir gone
```

You can test all of this **without** Claude or Codex.

## Do not

- Change Person 4’s tests to make them pass
- `npm install` in the fixture (zero deps)
- Let the agent’s extra files break tests unless they are harmless; still commit only after tests pass
- Use worktrees unless the copy/clone path already works
