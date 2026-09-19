---
name: bark-notify
description: Configure and send Bark push notifications from a Codex session. Use bark_state to read the configuration, bark_preview to check a template without sending, bark_test to verify delivery, bark_set_mode to switch work/away focus, bark_set_type and bark_set_profile to edit message templates and push presentation, and bark_send to push a message. The notify hook also fires on Codex lifecycle events.
---

# Bark Notify

Bark notifications push to the user's phone over `https://api.day.app/<key>/<title>/<body>`.
This plugin exposes the configuration and a manual send path as MCP tools, and a
`notify` hook that fires automatically on lifecycle events.

## Model

- **Types** — `taskDone`, `question`, `approval`, `error`, `start`, `quit`. Each
  owns a toggle, a title/body template, and Bark presentation: `level`
  (`passive`, `active`, `timeSensitive`, `critical`), `sound`, `icon`, `group`.
  `start` and `quit` default to `passive` so they push silently.
- **Subscribers** — Bark device keys. Each has an independent profile per type
  that may override the toggle, templates, and presentation; omitted fields and
  empty template strings inherit the type defaults.
- **Templates** — `<session_title>`, `<complete_summary>`, `<request_error>`,
  `<task>`, `<event>`, `<turn_id>`, `<cwd>`, `<time>`. An empty known
  placeholder drops its line; an unknown one is left verbatim.

## Tools

- `bark_state` — read focus mode, types, subscribers with their profiles, and the away queue.
- `bark_preview` — render a type for one or all subscribers without sending.
- `bark_test` — render a type with sample data and push it.
- `bark_send` — push an arbitrary title/body now.
- `bark_set_mode` — `work` pushes immediately; `away` queues until back to work.
- `bark_set_type` — edit a type's toggle, templates, level, sound, icon, group.
- `bark_set_profile` / `bark_clear_profile` — per-subscriber override for one type.
- `bark_add_subscriber` / `bark_remove_subscriber` / `bark_set_subscriber` — manage subscribers.
- `bark_flush` — deliver the away queue now.

## When to use

- When the user asks to "notify me", "ping my phone", or "alert me when done",
  use `bark_test` first to confirm delivery, then rely on the notify hook (or
  call `bark_send` explicitly at the end of a long task).
- When the user wants to change what a notification says, edit the template with
  `bark_set_type`, and confirm with `bark_preview` before sending anything.
- When the user wants to pause notifications while away, call `bark_set_mode`
  with `away`; switch back to `work` when they return.

Configuration persists to `~/.codex/bark-notify.json`. Never expose device keys
in replies; `bark_state` already masks them.
