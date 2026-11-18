# Project documentation

This branch (`main`) carries only the plain-text agent handoff contract. The
code — the `opencode/` plugins, the `codex-plugins/` reference, the `dashboard/`
service, and the platform design docs — lives on the `ai-infra-v0` branch,
which also carries the code-specific documentation under `docs/development/`
and `docs/deployment/`.

## What is here

- [`AGENTS.md`](../AGENTS.md) — the canonical contract coding agents follow.
- [`LLM_CHECK.md`](LLM_CHECK.md) — the end-of-round checklist template.
- [`TODO.md`](TODO.md) — owner-visible task tracker.
- This file — how the template is laid out.

## Branch structure

- `main` (this branch) — plain-text prompts and rules only.
- `ai-infra-v0` — plugins, dashboard, and their documentation; the Jenkins
  `agent-dashboard` job deploys pushes to this branch.

Rule changes land on `main` and are merged into `ai-infra-v0`; code changes land
directly on `ai-infra-v0`.
