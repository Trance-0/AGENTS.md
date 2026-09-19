# session-importer

Imports Claude Code sessions into Codex, and reports on the dsh session store —
the inverted port of the dsh `session-sync` package.

## Tools

- `import_status` — store roots, available counts, and the import ledger.
- `import_run({ write })` — one pass over the Claude Code store. Dry-run by
  default; `write: true` writes Codex rollout JSONL and records the ledger.

## What it does

Scans `~/.claude/projects/**/*.jsonl`, converts each unseen file into a Codex
`rollout-<timestamp>-<sessionId>.jsonl` under `~/.codex/sessions/`, and keys a
ledger (`~/.codex/session-importer.json`) on `source:sessionId:size:mtime` so a
repeat pass is cheap.

## Limits

- **Best effort.** The produced rollout shape is `session_meta` + one
  `response_item` per turn; Codex may need to reindex before these appear in
  `codex resume`.
- **Claude Code only.** dsh sessions are zstd-compressed and are reported but not
  converted (no zstd codec in this plugin's dependency-free Node runtime).
- **No merge.** A changed external session imports again as a separate session.
