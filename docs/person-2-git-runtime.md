# Track B — Git & tests

**One file for this track.** Builder feeds this to Agent B. JSON: `protocol/examples/git-*.json`.

**Writes:** `server/src/git.ts` only  
**Export:** `export function createGitRuntime(fixtureDir: string): GitRuntime`  
**Does not:** spawn CLIs, HTTP, `web/`, change `fixture/parse.test.js`, worktrees, `npm install`, edit `protocol/index.ts`

`fixtureDir` = absolute path to repo `fixture/`. Workspaces: `/tmp/loopsync-workspaces/<taskId>`.

---

## Contract — return JSON

`createWorkspace(taskId)` → `git-create-workspace.result.json`:

```json
{
  "dir": "/tmp/loopsync-workspaces/task_01hxyz",
  "branch": "loopsync/task_01hxyz"
}
```

`runTests(dir)` fail / pass → `git-run-tests-fail.result.json` / `git-run-tests-pass.result.json`:

```json
{ "passed": false, "exitCode": 1, "output": "...4 !== 5..." }
```

`passed === (exitCode === 0)`. Full TAP in `output` (Track A injects this on attempt 2).

`getDiff(dir)` → string (may be `""`).

`commitIfDirty(dir, message)` → `git-commit.result.json` or `null`:

```json
{ "sha": "2e38bf1086d1d962ddbb5fd06b3970769d32c637", "diff": "diff --git a/parse.js ..." }
```

`resetAll()` → void. Delete `/tmp/loopsync-workspaces` only, never `fixture/`.

Spawn **`shell: false`** always.

---

## Steps (Phase 1)

### Step 0 — Confirm fixture still fails

```bash
cd fixture && node --test; echo exit=$?
```

Must be `4 !== 5`, exit 1. If it passes, stop. Do not “fix” homework.

### Step 1 — Skeleton

```ts
export function createGitRuntime(fixtureDir: string): GitRuntime {
  return { createWorkspace, runTests, getDiff, commitIfDirty, resetAll };
}
```

### Step 2 — `createWorkspace`

1. mkdir `WORKSPACE_ROOT`  
2. `dir = join(root, taskId)`; rm if exists  
3. `fs.cpSync(fixtureDir, dir, { recursive: true })`  
4. `git init` if no `.git`  
5. `git checkout -b loopsync/${taskId}`  
6. `user.email=loopsync@local`, `user.name=LoopSync`, `commit.gpgsign false`  
7. Require `parse.js` + `parse.test.js`

### Step 3 — `runTests`

`spawn('node', ['--test'], { cwd: dir, shell: false })`. Do not parse TAP for pass/fail.

**Verify:** stock copy fails with `4 !== 5`; after `return text.length`, passes.

### Step 4 — `getDiff`

`git diff HEAD` plus `git diff --cached` if needed.

### Step 5 — `commitIfDirty`

`git add -A` → porcelain empty → `null` → `commit -m --no-verify` → `rev-parse HEAD` (40 chars) → `git diff HEAD~1 HEAD`. Never `--amend`, never commit in original `fixture/`.

### Step 6 — `resetAll`

`fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true })`.

**Verify:** workspace gone; `fixture/parse.js` still `length - 1`.

### Step 7 — Hand to Track A

```ts
const git = createGitRuntime(path.resolve('fixture'));
```

---

## Done

All five methods work with **no** Claude/Codex. **Gate 1.**
