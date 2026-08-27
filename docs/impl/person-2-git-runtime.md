# Person 2 — step-by-step implementation (agent playbook)

You are Person 2. You own copy-isolate, `node --test`, diff, commit, reset.

**Read first:** `protocol/index.ts` (`GitRuntime`, `WORKSPACE_ROOT`), `docs/person-2-git-runtime.md`, JSON in `protocol/examples/git-*.json`.

**Do not:** spawn `claude`/`codex`, edit `protocol/index.ts`, use git worktrees, `npm install` in the fixture, change `fixture/parse.test.js`, HTTP, React.

**Write only:** `server/src/git.ts`  
**Export:** `export function createGitRuntime(fixtureDir: string): GitRuntime`

`fixtureDir` default: path to repo `fixture/` (absolute). Person 1 passes it.

---

## Step 0 — Confirm fixture

```bash
cd fixture && node --test; echo exit=$?
```

Must fail with `4 !== 5` and `exit=1`. If it passes, stop and tell Person 4. Do not “fix” the homework.

---

## Step 1 — File skeleton

```ts
import type { GitRuntime } from '../../protocol/index.ts';
import { WORKSPACE_ROOT } from '../../protocol/index.ts';

export function createGitRuntime(fixtureDir: string): GitRuntime {
  return {
    createWorkspace,
    runTests,
    getDiff,
    commitIfDirty,
    resetAll,
  };
}
```

Implement helpers with `node:child_process` `spawn` **`shell: false`**, or `execFile`. Collect stdout+stderr. Never `exec('git ...')` with a string shell.

**Verify:** `npx tsc --noEmit` once Person 1’s tsconfig exists. If `server/` is not there yet, still write `server/src/git.ts`; Person 1 will add tsconfig.

---

## Step 2 — `createWorkspace(taskId)`

Return shape (`protocol/examples/git-create-workspace.result.json`):

```json
{
  "dir": "/tmp/loopsync-workspaces/task_01hxyz",
  "branch": "loopsync/task_01hxyz"
}
```

Implementation order:

1. `mkdir` `WORKSPACE_ROOT` (`/tmp/loopsync-workspaces`) recursive.
2. `dir = join(WORKSPACE_ROOT, taskId)` — if it exists, `rmSync` recursive first.
3. Copy `fixtureDir` → `dir` with `fs.cpSync(src, dir, { recursive: true })`.
4. If `dir/.git` is missing, `git init` in `dir`.
5. `git -C dir checkout -b loopsync/${taskId}` (if branch exists, still ok to use it).
6. Identity (required or `git commit` will fail later):

```
git -C dir config user.email loopsync@local
git -C dir config user.name LoopSync
git -C dir config commit.gpgsign false
```

7. Confirm `parse.js` and `parse.test.js` exist in `dir` or throw.

**Verify script** (no Claude):

```ts
const git = createGitRuntime(absFixture);
const { dir, branch } = await git.createWorkspace('task_smoke');
// dir exists, branch starts with loopsync/, parse.test.js exists
```

---

## Step 3 — `runTests(dir)`

```
spawn('node', ['--test'], { cwd: dir, env: process.env, shell: false })
```

Return (`git-run-tests-fail.result.json` / `git-run-tests-pass.result.json`):

```json
{ "passed": false, "exitCode": 1, "output": "<full TAP>" }
```

`passed === (exitCode === 0)`. Do not parse TAP to decide pass/fail. Keep full `4 !== 5` text in `output` (Person 1 injects this on attempt 2).

**Verify:**

```
createWorkspace → runTests → passed === false, output includes "4 !== 5"
```

Manually edit that copy’s `parse.js` to `return text.length`, `runTests` → `passed === true`, `exitCode === 0`.

---

## Step 4 — `getDiff(dir)`

```
spawn('git', ['diff', 'HEAD'], { cwd: dir, shell: false })
```

If porcelain shows staged-only, also `git diff --cached`. Concatenate. Return `''` if both empty.

**Verify:** after the manual one-line fix, diff contains `text.length - 1` on a `-` line and `text.length` on a `+` line (same as `protocol/examples/git-commit.result.json`).

---

## Step 5 — `commitIfDirty(dir, message)`

1. `git add -A`
2. `git status --porcelain` empty → return `null`
3. `git commit -m message --no-verify` (no editor: identity already set; also `GIT_EDITOR=true` in env if needed)
4. `sha = git rev-parse HEAD` (full 40-char hash)
5. `diff = git diff HEAD~1 HEAD` (or `git show --pretty=format: HEAD`)
6. Return `{ sha, diff }` matching `git-commit.result.json`

Never `--amend`. Never commit inside original `fixture/`. Never `git push`.

**Verify:** `commitIfDirty(dir, 'loopsync: test')` returns sha length 40; second call on clean tree returns `null`.

---

## Step 6 — `resetAll()`

`fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true })`.

Do not delete repo `fixture/`.

**Verify:** after `createWorkspace`, `resetAll()`, `dir` is gone; `fixture/parse.js` still has `length - 1`.

---

## Step 7 — Hand to Person 1

They import:

```ts
import { createGitRuntime } from './git.ts';
const git = createGitRuntime(path.resolve('fixture'));
```

If Person 1’s loop is not ready, your isolated script is enough.

## Done

All five methods work on the stock fixture with **no** coding CLI involved.
