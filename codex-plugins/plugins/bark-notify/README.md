# bark-notify

Bark push notifications for Codex. Push to your phone when Codex finishes a
turn, needs a response, errors, or starts/stops — with per-type message
templates, per-type push presentation, work/away focus mode, and a subscriber
list where every device can override any notification type.

## Pieces

- **MCP server** (`server.mjs`) — `bark_*` tools to configure subscribers,
  templates, focus mode, and to preview or send pushes.
- **`notify` hook** (`scripts/notify.mjs`) — fires on Codex lifecycle events.
- **Settings panel** — the Persistent Plugin Manager dashboard renders the
  template and subscriber editors at `/` → Bark Notify.

## Install

1. Add the plugin from the marketplace (`codex plugin add bark-notify@personal`).
2. Wire the lifecycle hook by adding a `notify` entry to `~/.codex/config.toml`:

```toml
notify = [ "node", "C:/Users/<you>/.codex/plugins/cache/personal/bark-notify/1.2.0/scripts/notify.mjs" ]
```

Codex appends its JSON payload as the last argument. A plain event name
(`turn-ended`) is still accepted for a hand-wired setup.

## Templates

Titles and bodies are templates. A `<placeholder>` is substituted from the
event; a known placeholder with no value renders empty and its line is dropped,
while an unknown one is left verbatim so a typo stays visible.

| Placeholder | Value |
| --- | --- |
| `<session_title>` | Thread title, falling back to the user prompt |
| `<complete_summary>` | Summary of the final assistant message |
| `<request_error>` | Error text when the turn failed |
| `<task>` | Summary of the user prompt for the turn |
| `<event>` | Raw Codex payload type |
| `<turn_id>` | Turn id |
| `<cwd>` | Working directory |
| `<time>` | Local time the notification was built |

## Notification types

Each type carries its own toggle, templates, and Bark presentation (`level`,
`sound`, `icon`, `group`). Levels are `passive`, `active`, `timeSensitive`, and
`critical`; `passive` pushes silently.

| Type | Default level | Fires on |
| --- | --- | --- |
| `taskDone` | `active` | Turn completed |
| `question` | `timeSensitive` | Codex is waiting for input |
| `approval` | `timeSensitive` | Permission request |
| `error` | `timeSensitive` | Turn ended with an error |
| `start` | `passive` | Session start |
| `quit` | `passive` | Session end |

## Subscribers

Every subscriber is a Bark device key with a label, an on/off switch, and an
independent profile per notification type. A profile may override the toggle,
the templates, and the presentation; omitted fields and empty template strings
inherit the type defaults. `bark_clear_profile` (or **Reset to type default**
in the dashboard) drops an override.

## Configuration

`~/.codex/bark-notify.json`. Pre-1.2 files — a `devices` list and boolean
`types` — are upgraded on read.

```json
{
  "mode": "work",
  "subscribers": [
    {
      "key": "…",
      "label": "我的 iPhone",
      "enabled": true,
      "profiles": { "error": { "level": "critical" } }
    }
  ],
  "types": {
    "taskDone": {
      "enabled": true,
      "level": "active",
      "sound": "",
      "icon": "",
      "group": "Codex",
      "title": "✅ <session_title>",
      "body": "任务：<task>\n结果：<complete_summary>"
    }
  }
}
```

In `away` mode the event context — not the rendered text — is queued, so a
template edited while away applies when the queue is flushed.
