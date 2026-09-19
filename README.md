# AGENTS.md

Two things live here:

- **[`AGENTS.md`](AGENTS.md)** — the canonical agent-handoff contract. It is the
  reference template for how coding agents (Claude Code, Codex, Cursor,
  Copilot) collaborate on this owner's projects. Other entry files
  (`CLAUDE.md`, `CODEX.md`) are thin includes of it rather than forks, so there
  is one source of truth.
- **[`opencode/`](opencode/README.md)** — a set of personal
  [opencode](https://opencode.ai) plugins, versioned and released from this
  repository.

`codex-plugins/` holds the earlier Codex MCP versions of the same tools, kept
for reference; the opencode ports supersede them.

## The plugins

| Plugin | What it does |
| --- | --- |
| `plugin-manager` | Settings dashboard on localhost, soft enable/disable, config editor, marketplace update checks |
| `bark-notify` | Bark push notifications for opencode lifecycle events, with per-type templates |
| `cpa-usage` | CliProxy quota and model-catalog probing |
| `task-queue` | Durable task queue with concurrency, restart resume, and automatic transport/quota retry |
| `session-manager` | Indexes and imports Claude Code, Codex and dsh transcripts into opencode |
| `session-rename` | Retitles sessions from their transcript using a model you pick |

opencode has no plugin settings UI, so `plugin-manager` supplies one: run the
`plugins_dashboard` tool for a `http://127.0.0.1:141xx` URL. Full behaviour,
install steps and design notes are in [`opencode/README.md`](opencode/README.md).

## Install

opencode auto-discovers any `*.ts` in `~/.config/opencode/plugin/`. Link this
checkout in rather than copying, so edits are live:

```powershell
cmd /c mklink /J "$env:USERPROFILE\.config\opencode\plugin" "<checkout>\opencode\plugin"
cmd /c mklink /J "$env:USERPROFILE\.config\opencode\lib"    "<checkout>\opencode\lib"
cmd /c mklink /J "<checkout>\opencode\node_modules" "$env:USERPROFILE\.config\opencode\node_modules"
```

The third link lets the plugins resolve `@opencode-ai/plugin`, which opencode
installs into its own config directory. Junctions are used instead of symlinks
because they need no administrator rights.

## Versioning and releases

Every plugin declares a managed version in
[`opencode/versions.json`](opencode/versions.json). Versions are `a.b.c`:

- `c == 0` marks a **stable release** — pushing it publishes a GitHub release.
- any `c > 0` is a **local beta** and is never published.
- Promoting a verified beta bumps `b` and resets `c` to `0`.

A push to `main` that touches `opencode/**` runs
[`opencode-plugins-release.yml`](.github/workflows/opencode-plugins-release.yml),
which releases every stable version that has no
`opencode-<plugin>-v<version>` tag yet. Betas and already-released versions are
skipped, so pushing one publishes nothing.

Each release ships a zip of that plugin plus the shared `lib/`, because the
plugins import `lib/` directly and a single-file asset would not install.

To preview what a push would publish, without writing anything:

```sh
cd opencode
EXISTING_TAGS="$(git tag --list 'opencode-*')" node scripts/plan-release.mjs plan
```

The planner also validates the manifest: a plugin missing from
`versions.json`, a declared plugin with no file, or a malformed version fails
there rather than halfway through publishing.
