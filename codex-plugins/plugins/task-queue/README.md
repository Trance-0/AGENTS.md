# task-queue

Durable, importance-ordered task queue that resumes existing Codex sessions —
the Codex port of the dsh `task-runner` + `cliproxy-quota` auto-start loop.

## Pieces

- **MCP server** (`server.mjs`) — `task_*` tools + `quota`.
- **Watcher daemon** (`scripts/watcher.mjs`) — polls CPA quota; on the
  unavailable→available reset edge, resumes the top pending task headless.
- **Store** (`~/.codex/task-queue.json`).

## Usage

Enqueue from a session:

```
task_create(sessionId="<codex session id>", prompt="continue the migration", importance=4)
```

Run the watcher (keeps watching while the workstation idles):

```sh
node ~/.codex/plugins/task-queue/scripts/watcher.mjs 30
```

The watcher resumes with `codex exec resume <sessionId> -` (prompt via stdin),
optionally overriding the model route from the task's `model` / `reasoningEffort`.
Set `CODEX_CLI_PATH` to the `codex.exe` path (or let it fall back to the `codex`
shim) so it resolves correctly on Windows.
