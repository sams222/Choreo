# Choreo

[Choreo](https://github.com/sams222/Choreo) is a local orchestration layer for
the Claude and Codex CLIs. It uses the accounts already authenticated on your
machine and runs agents inside isolated copies of your project.

Give Choreo a goal and it separates test authoring from implementation. When
different CLIs are assigned, both lanes can run concurrently in independent
worktrees. Choreo merges them, runs the frozen test suite, optionally requests
an independent review, and creates a local snapshot only after the gates pass.
Nothing is written back to your project until you choose **Apply changes**.

## Requirements

- Node.js 22 or newer
- Git
- An authenticated `claude` or `codex` CLI on `PATH`

## Install

```bash
git clone https://github.com/sams222/Choreo.git
cd Choreo
npm install
npm link
```

Run Choreo from any project directory:

```bash
cd ~/code/my-app
choreo
```

The dashboard opens with the launch directory selected. Agents work against an
isolated copy, excluding Git metadata, Choreo state, dependencies, coverage,
and build output.

```bash
choreo                  # use the current directory
choreo ../other-app     # use another project
choreo --empty          # start from an empty workspace
choreo --no-open        # do not open the browser
choreo -p 4099          # use a different port
choreo --host 127.0.0.1 # bind locally only
```

To remove a linked installation:

```bash
npm unlink -g choreo
```

## Development

```bash
npm install
npm run typecheck
npm test
npm start
```

`npm start` serves the dashboard at `http://127.0.0.1:4055`. The HTTP API also
supports project creation, steering, cancellation, Apply, server-sent events,
and replay. Request examples live in [`protocol/examples`](protocol/examples).

## Safety model

- Claude and Codex run in copied workspaces, never directly in the source tree.
- Test files freeze before implementation can receive a final SHA.
- Coding agents do not own Git commits; the Node orchestrator does.
- Apply is explicit and additive: it writes new and changed files but does not
  delete existing source files.
- `.git`, `.choreo`, `node_modules`, `dist`, and `coverage` are excluded from
  Apply.

Choreo stores its local ledger and replay thread under `.choreo/` in the launch
directory. Replay a recorded project without invoking either CLI:

```text
http://127.0.0.1:4055/?replay=<projectId>
```

## Configuration

| Variable | Effect |
| --- | --- |
| `CHOREO_PLAIN_CLI=1` | Use plain-text CLI output instead of JSON event streams |
| `CHOREO_WORKSPACE_ROOT` | Override the default `/tmp/choreo-workspaces` root |
| `CHOREO_CLI_TIMEOUT_MS` | Override the 30-minute per-process limit; minimum 60 seconds |

The former `LOOPSYNC_*` environment variables remain accepted as compatibility
fallbacks but are no longer documented or preferred.

## Repository layout

- [`bin/choreo.js`](bin/choreo.js) — installable command entry point
- [`server/src`](server/src) — HTTP server, orchestration loop, CLI adapters,
  Git isolation, state, and tests
- [`protocol/index.ts`](protocol/index.ts) — shared API and runtime contracts
- [`web`](web) — dashboard and provider assets
- [`examples/sqrt`](examples/sqrt) — small example project
- [`fixture`](fixture) — compatibility fixture for the low-level task API
- [`docs/PLATFORM.md`](docs/PLATFORM.md) — architecture and scaling direction
