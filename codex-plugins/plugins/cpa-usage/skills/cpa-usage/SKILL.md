---
name: cpa-usage
description: Check the remaining CPA (CliProxy) quota before or while running work that depends on capacity. Use get_quota to see whether the endpoint is available and how much quota remains, and list_models to see which models the endpoint advertises.
---

# CPA Usage

The CPA (CliProxy) endpoint at `https://cpa.trance-0.com/v1` fronts the models
Codex runs on. Its remaining quota is reported in response headers
(`x-quota-remaining`, `x-ratelimit-remaining-requests`, etc.), not in the
completion responses Codex sees, so the only way to read it is an out-of-band
probe.

## When to use

- Before starting a long or queued piece of work, call `get_quota` to confirm
  there is capacity; do not begin work when it reports `available: false`.
- When a task was skipped because quota was exhausted, re-check `get_quota`
  before retrying.
- Use `list_models` to confirm a model id the user asked for is actually
  advertised by the endpoint.

## How to read the result

- `available: true` — capacity is present, `remaining` is the count when a quota
  header was found.
- `available: false` — exhausted; `code` is `QUOTA`.
- `available: null` — the probe got no definitive provider response (network
  failure or a non-2xx that is not 429); the real availability is unknown.

The tools are provided by this plugin's MCP server (`cpa-usage`). They read the
endpoint and API key from `~/.codex/config.toml` (the `model_providers.custom`
block) and the `CPA_API_KEY` environment variable, overridable by
`~/.codex/cpa-usage.json`.
