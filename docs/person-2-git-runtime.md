# Person 2 — Git & tests

You own the homework copy, `node --test`, and the commit SHA. JSON you return is under [`../protocol/examples/`](../protocol/examples/).

Fixture path in: **`fixture/`** (Person 4). Workspaces out: **`/tmp/loopgrid-workspaces/<taskId>`**. No git worktrees.

Export one object that matches `GitRuntime`.

## `createWorkspace(taskId)` → `git-create-workspace.result.json`

```json
{
  "dir": "/tmp/loopgrid-workspaces/task_01hxyz",
  "branch": "loopgrid/task_01hxyz"
}
```

Implementation details:

- `fs.mkdir` `WORKSPACE_ROOT` (`/tmp/loopgrid-workspaces`)
- Copy Person 4’s `fixture/` recursively into `dir` (`fs.cpSync(src, dir, { recursive: true })`). Skip copying `fixture/.git` if clone is easier: `git clone --local <abs-fixture> <dir>` is also fine.
- `dir` must be a git repo when you return. If you copied without `.git`, `git init` then you lose history — prefer clone or copy including `.git`.
- `git -C dir checkout -b loopgrid/<taskId>`
- Set identity so commit cannot open an editor:

```bash
git -C "$dir" config user.email loopgrid@local
git -C "$dir" config user.name LoopGrid
git -C "$dir" config commit.gpgsign false
```

Must contain `parse.js` and `parse.test.js`.

## `runTests(dir)` 

Fail shape (stock fixture, already observed): [`git-run-tests-fail.result.json`](../protocol/examples/git-run-tests-fail.result.json)

```json
{
  "passed": false,
  "exitCode": 1,
  "output": "...4 !== 5..."
}
```

Pass shape: [`git-run-tests-pass.result.json`](../protocol/examples/git-run-tests-pass.result.json)

```json
{
  "passed": true,
  "exitCode": 0,
  "output": "...# pass 1..."
}
```

Spawn **no shell**:

```ts
spawn('node', ['--test'], { cwd: dir, shell: false })
```

`passed === (exitCode === 0)`. `output` = stdout + stderr, full text. Person 1 puts this string into attempt 2. Do not truncate the assertion; keep `4 !== 5`.

## `getDiff(dir)` → string

```ts
spawn('git', ['diff', 'HEAD'], { cwd: dir, shell: false })
```

If staged-only changes exist, include `git diff --cached`. Empty string if clean. The succeeded example diff is:

```diff
diff --git a/parse.js b/parse.js
--- a/parse.js
+++ b/parse.js
@@ -1 +1 @@
-export function parseIndex(text) { return text.length - 1; }
+export function parseIndex(text) { return text.length; }
```

## `commitIfDirty(dir, message)` → `git-commit.result.json` or `null`

```json
{
  "sha": "2e38bf1086d1d962ddbb5fd06b3970769d32c637",
  "diff": "diff --git a/parse.js b/parse.js\n..."
}
```

Steps: `git add -A` → if `git status --porcelain` empty, return `null` → `git commit -m message --no-verify` → `git rev-parse HEAD` for `sha` → `getDiff` against the parent (`git show --pretty=format: HEAD` or `git diff HEAD~1`). Never `--amend`. Never commit on Person 4’s original `fixture/` — only `dir`.

## `resetAll()` → void (Person 1 does not need a JSON body)

Delete `/tmp/loopgrid-workspaces` recursively (`fs.rmSync(root, { recursive: true, force: true })`). Do not touch `fixture/`.

## Isolated done-when (no Claude/Codex)

```bash
# createWorkspace → runTests.passed === false (4 !== 5)
# rewrite parse.js to `return text.length`
# runTests.passed === true
# commitIfDirty → sha length >= 7
# resetAll → dir gone
```

## Do not

- Spawn CLIs
- Change the test file
- `npm install`
- Worktrees
