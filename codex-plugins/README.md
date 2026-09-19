# codex-plugins

The personal DeepSeek Harness (dsh) plugins, rewritten as self-contained Codex
CLI plugins. Each is a folder under `plugins/` with a `.codex-plugin/` manifest
and a dependency-free Node (>= 18) MCP server.

**Kept for reference.** These are superseded by the native opencode plugins in
[`../opencode`](../opencode). They carry their own `.codex-plugin` versions and
are deliberately outside the opencode version manifest and its release
workflow, so nothing here is ever published.

| Plugin | Ports | Notes |
| --- | --- | --- |
| `bark-notify` | dsh `dsh-bark-notify` | Bark push on Codex lifecycle events; MCP tools for devices/focus-mode/types; a `notify` hook |
| `cpa-usage` | dsh `cliproxy-quota` | `get_quota` / `list_models` probe the CPA endpoint's quota headers |
| `task-queue` | dsh `task-runner` + `cliproxy-quota` | durable importance-ordered queue; watcher daemon auto-resumes on quota reset |
| `session-importer` | dsh `session-sync` | imports Claude Code sessions into Codex (best effort); reports dsh store |

## Install

Add this folder as a local marketplace, then install:

```sh
codex plugin marketplace add "D:/Documents/Github/deepseek-harness/codex-plugins"
codex plugin add bark-notify
codex plugin add cpa-usage
codex plugin add task-queue
codex plugin add session-importer
```

Or copy each `plugins/<name>` folder into `~/.codex/plugins/<name>/` and enable
it in `~/.codex/config.toml`.

## Extra wiring (not automatic)

- **bark-notify lifecycle hook** — add a `notify` entry to `~/.codex/config.toml`:

  ```toml
  notify = [ "C:/Users/<you>/.codex/plugins/bark-notify/scripts/notify.mjs", "turn-ended" ]
  ```

- **task-queue auto-start daemon** — run detached:

  ```sh
  node ~/.codex/plugins/task-queue/scripts/watcher.mjs 30
  ```

## Configuration

All state lives under `~/.codex/`:
`bark-notify.json` (migrated from `~/.dsh/bark-notify.json`),
`cpa-usage.json` (optional override), `task-queue.json`,
`session-importer.json` (ledger). API keys are read from `~/.codex/config.toml`
(`model_providers.custom.experimental_bearer_token`) or the `CPA_API_KEY`
environment variable, and are never written back by these plugins.
