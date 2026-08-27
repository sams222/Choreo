# Choreo

[github.com/sams222/LoopSync](https://github.com/sams222/LoopSync) — Choreo, local orchestration for coding CLIs.

State a **goal**. Choreo splits the work into **tests** and **implementation** (different processes, different context). When Plan and Write are different CLIs, those items run in parallel worktrees and merge. Tests freeze before a SHA is allowed. Coding agents never `git commit`.

Point at an existing folder if you already have a tree. Leave the folder blank to start empty. There is no canned homework test in the default UI.

Install the `choreo` command, then run it inside a project: the dashboard opens with that folder already selected, and the models work against a copy of that tree.

`POST /api/tasks` without a project still runs the Gate 2 parseIndex fixture.

Gemini CLI is out of scope. There is no fake adapter on the demo.

## Run locally

You need Node 22+, `git`, and either `claude` or `codex` on PATH.

### Install the `choreo` command

From this repo:

```bash
git clone https://github.com/sams222/LoopSync.git
cd LoopSync
npm install
npm link          # or: npm install -g .
```

Then, in any project folder:

```bash
cd ~/code/my-app
choreo
```

That starts the dashboard and points orchestration at the folder you launched from. Claude and Codex run against a copy of that tree. Leave Settings → Folder blank (or pass `--empty`) to start from an empty workspace instead.

After every plan item succeeds and any parallel worktrees have merged, click
**Apply changes** to write the completed files back to the launch directory.
Apply is additive: it writes new and changed files without deleting existing
files, and excludes `.git`, `.choreo`, dependencies, coverage, and build output.

```bash
choreo                  # this directory
choreo ../other-app     # another folder
choreo --empty          # blank project
choreo --no-open        # do not open the browser
choreo -p 4099          # bind a different port
```

`loopsync` is the same command.

To uninstall the linked binary: `npm unlink -g choreo`.

### Develop against this repo

```bash
npm start
```

`npm start` still serves the in-repo demo (folder left blank). The server binds `0.0.0.0:4055` and serves the dashboard from `web/`.

```bash
curl -s http://127.0.0.1:4055/api/state

# empty project — orchestrator writes tests + code
curl -s -X POST http://127.0.0.1:4055/api/reset
curl -s -D- -X POST http://127.0.0.1:4055/api/projects \
  -H 'content-type: application/json' \
  --data-binary @protocol/examples/http-post-projects.request.json

# follow-up without Reset
curl -s -D- -X POST http://127.0.0.1:4055/api/projects/<id>/messages \
  -H 'content-type: application/json' \
  --data-binary @protocol/examples/http-post-project-message.request.json

# Gate 2 homework (copies fixture/, locks parse.test.js)
curl -s -X POST http://127.0.0.1:4055/api/reset
curl -s -D- -X POST http://127.0.0.1:4055/api/tasks \
  -H 'content-type: application/json' \
  --data-binary @protocol/examples/http-post-tasks.request.json

# live push instead of polling
curl -sN http://127.0.0.1:4055/api/events
```

Sending a message while a run is in flight is accepted (`202`), shown in the
thread as queued, and folded into the prompt at the next loop boundary. Cancel
it before it lands with
`POST /api/projects/<id>/steering/<messageId>/cancel`.

### Replay a recorded run

Every thread item is appended to `data/loopsync-thread.jsonl`. Open
`http://127.0.0.1:4055/?replay=<projectId>` to re-render a past run at 10×
with no CLIs involved — useful when the live tools or the wifi are unreliable.
`GET /api/replay` lists the recorded ids.

### Environment

| Variable | Effect |
| --- | --- |
| `LOOPSYNC_PLAIN_CLI=1` | Fall back to the old `--output-format text` argv if a CLI's JSON stream misbehaves |
| `LOOPSYNC_WORKSPACE_ROOT` | Move the worktree root off `/tmp/loopsync-workspaces` |
| `LOOPSYNC_CLI_TIMEOUT_MS` | Override the 30-minute per-process runtime limit (minimum 60,000 ms) |

## Layout

- **[protocol/index.ts](protocol/index.ts)** — frozen types, PORT `4055`, CLI argv (additive fields only)
- **[server/src/](server/src/)** — Express orchestrator, git runtime, Claude/Codex adapters, `runLoop`
- **[web/](web/)** — live session over SSE (`/api/events`, 300ms polling fallback): one composer, server-ordered thread, race view, rendered diffs
- **[examples/sqrt/](examples/sqrt/)** — optional sample tree you can paste as a folder, not the default job
- **[fixture/](fixture/)** — Gate 2 homework (`4 !== 5`)
- **[docs/PLATFORM.md](docs/PLATFORM.md)** — project-scale orchestration
- **[docs/KERNEL_RISKS.md](docs/KERNEL_RISKS.md)** — spawn, review, oracle, cancel, slots, retry gaps

## CLI flags

Both CLIs are driven in JSONL event mode so the dashboard can show real tool
calls (`editing sqrt.js`, `ran node --test`) instead of narrating.

```bash
claude -p "<task>" --output-format stream-json --verbose --dangerously-skip-permissions
codex exec --json --sandbox workspace-write --skip-git-repo-check "<prompt>"
node --test
```

The parser is tolerant: any line it cannot read becomes a plain text event, and
`LOOPSYNC_PLAIN_CLI=1` restores the previous text-mode argv wholesale.
