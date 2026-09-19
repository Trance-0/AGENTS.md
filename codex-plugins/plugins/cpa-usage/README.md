# cpa-usage

Reports remaining CPA (CliProxy) quota from the OpenAI-compatible endpoint by
probing it and reading the quota response headers — the Codex port of the dsh
`cliproxy-quota` monitor.

## Tools

- `get_quota` — probe the endpoint, return `available`, `remaining`, `status`, `code`.
- `list_models` — return the model ids the endpoint advertises.

## Configuration

Read from `~/.codex/config.toml` (`model_providers.custom.base_url` and
`experimental_bearer_token`) and the `CPA_API_KEY` environment variable, with an
optional override file `~/.codex/cpa-usage.json`:

```json
{
  "baseURL": "https://cpa.trance-0.com/v1",
  "apiKey": "sk-...",
  "probePath": "/models",
  "quotaHeaderNames": ["x-quota-remaining", "x-ratelimit-remaining-requests", "x-ratelimit-remaining", "x-remaining-credits"]
}
```

The API key is never written back to disk.

## Install

From a marketplace that points at the parent `codex-plugins` folder:

```sh
codex plugin add cpa-usage
```

Or copy this folder into `~/.codex/plugins/cpa-usage/` and enable it in
`~/.codex/config.toml`.
