---
name: task-queue
description: Queue work against existing Codex sessions and resume it later, ordered by importance, auto-started when CPA quota returns. Use task_create to enqueue a continuation prompt for a session, task_list to inspect the queue, task_run to resume the top task now, and task_set_status to mark completion.
---

# Task Queue

Queued work is a continuation of an existing Codex session: a prompt plus the
session to resume, ordered by importance (1–5). When the CPA quota monitor
reports that capacity returned, the watcher daemon resumes the top pending task
headless with `codex exec resume <sessionId> <prompt>`.

## Tools

- `task_create` — enqueue a task: `sessionId` (Codex session/thread id or name),
  `prompt`, optional `importance`, `model`, `reasoningEffort`.
- `task_list` — tasks ordered importance desc, then oldest update.
- `task_get` / `task_set_status` / `task_delete` — inspect and manage tasks.
- `task_run` — resume the top pending task now (manual; the daemon does this
  automatically on quota reset).
- `quota` — check current CPA quota availability.

## When to use

- The user wants to "queue this for later" or "run this when quota is back":
  find the target session id, call `task_create`, and confirm with `task_list`.
- "Run the queue now" → `task_run`. "Mark this done/failed" → `task_set_status`.

The store persists to `~/.codex/task-queue.json`. The auto-start daemon is
`node scripts/watcher.mjs [intervalSeconds]` and must be run separately.
