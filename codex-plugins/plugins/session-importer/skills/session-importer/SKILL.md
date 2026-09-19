---
name: session-importer
description: Import external coding sessions into Codex. Use import_status to see what is available in the Claude Code and dsh stores, and import_run (dry-run by default) to convert Claude Code sessions into Codex's session layout. Read the importer's limits before writing anything.
---

# Session Importer

Brings work done in other coding tools into Codex's session store. Claude Code
sessions (`~/.claude/projects/**/*.jsonl`) are plain JSONL and convert cleanly.
dsh sessions (`~/.dsh/sessions/**/session.*.jsonl.zstd`) are zstd-compressed and
are reported but not converted.

## Tools

- `import_status` — report the store roots, how many sessions are available in
  each, and what is already imported.
- `import_run` — run a pass. `write: false` (default) is a dry run that reports
  what would import without touching disk; `write: true` writes the rollout
  files and records them in the ledger.

## Limits (read before writing)

- Conversion is best-effort: it produces a Codex `session_meta` plus one
  `response_item` message per user/assistant turn. Imported sessions may need a
  Codex restart/reindex before they appear in `codex resume`.
- Only Claude Code is converted; dsh is reported only.
- An import never merges or updates: a changed external session imports as a
  separate Codex session, and earlier imports keep their history.

Prefer a `import_run` dry-run first, tell the user the counts, and only write
after they confirm.
