# AGENTS.md

This repository holds the canonical agent-handoff contract used across the
owner's projects.

## What lives on this branch

The `main` branch carries **only the plain-text agent prompts and rules**:

- [`AGENTS.md`](AGENTS.md) — the canonical contract that coding agents (Claude
  Code, Codex, Cursor, Copilot) follow. Other entry files (`CLAUDE.md`,
  `CODEX.md`) are thin includes of it rather than forks, so there is one source
  of truth.
- [`CLAUDE.md`](CLAUDE.md) — a single-line `@AGENTS.md` include.
- [`docs/LLM_CHECK.md`](docs/LLM_CHECK.md) — the canonical end-of-round checklist
  every agent-managed project ships.
- [`docs/readme.md`](docs/readme.md) — how the template is laid out and used.

## Branch structure

The repository is split across two branches:

- **`main`** (this branch) — plain-text agent prompts and rules only. No plugin
  or dashboard code.
- **`ai-infra-v0`** — everything else: the `opencode/` plugins, the
  `codex-plugins/` reference, the `dashboard/` service, and the platform design
  docs. The Jenkins `agent-dashboard` job deploys pushes to this branch.

Code changes land on `ai-infra-v0`; plain-text rule changes land on `main` and
are merged into `ai-infra-v0`.

## Using the template

Copy `AGENTS.md` into a target repo's root and `docs/LLM_CHECK.md` into its
`docs/` directory (see `AGENTS.md` §8 for the full checklist). Adapt the
project-specific sections rather than forking the rules per tool.
