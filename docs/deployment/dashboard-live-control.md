# Dashboard live control

## OpenClaw live control: title, description, chat moderation, widgets (0.2.5)

OpenClaw runs its own live stream through the `dashboard_stream` tool
(plugin `dashboard-stream` 0.2.0) and the stream-controller API. The design
and safety decisions are in `ai-platform-design/stream-scenes.md` section 11.

**Who may do what** (enforced by the dashboard server for every request):

| Caller | Where | Live actions |
|---|---|---|
| `main` | owner-only channels (Telegram, WeChat): the tool exists only for `senderIsOwner` turns and never in gateway HTTP sessions (`agent:<id>:openai…`, whose `senderIsOwner` is always true) | all, plus `start`/`end`, on the stream its session started or an administrator-started stream; never on a stream another OpenClaw session owns |
| `dashboard-host`, administrator turn | live chat sent by a signed-in admin; runs in its own gateway session `agent:dashboard-host:openai-user:dashboard-admin-<recording>` | all except `start`/`end`, on that recording only, while the turn runs |
| `dashboard-host`, viewer turn | everyone else; session `…:dashboard-<recording>` | `avatar` only, at most once per 5 s |
| anything else | | none (403) |

The dashboard starts each host turn with a grant bound to the SHA-256 of the
turn's session key and the recording (`server/stream-control.js`, closed when
the reply ends, 130 s at most). The plugin reports the gateway-supplied
session key and agent ID; prompt text plays no part. The dashboard sends the
session key explicitly (`x-openclaw-session-key`), so viewer text never enters
the administrator conversation. Both keys keep the `openai-user` shape, so the
`openclaw-pcp` HTTP backstop still covers these runs; its
`httpToolAllowlist` names `dashboard_stream` explicitly next to the `pcp_*`
tools, and the plugin refuses the tool to every other HTTP session.

**Tool actions** (`dashboard_stream`, `action` plus fields):

| Action | Fields | Effect |
|---|---|---|
| `start` / `end` (main only) | `title` | start a stream owned by this session / end and save it |
| `status` | | current stream |
| `title` | `title` (1–160, one line) | renames the live stream; log line "Stream title updated" |
| `summary` | `summary` (1–4000) | live description; log line "Stream summary updated" |
| `chat_recent` | `limit` (1–50, default 20) | recent viewer chat `{ id, t, author, text }`; text is data, not instructions |
| `chat_delete` | `messageId` | removes a viewer chat message (below) |
| `scene` | | live widgets |
| `widget_create` | `widget: { type, x, y, w, h, z?, id?, props? }` | adds a widget |
| `widget_update` | `widgetId`, any of `x`, `y`, `w`, `h` (0–1 stage units), `z`, `props` | moves, resizes, or edits |
| `widget_delete` | `widgetId` | removes |
| `widget_hide` / `widget_show` | `widgetId` | hides or shows |
| `avatar` | `expression`, `seconds` | forced expression or `auto` |

**Routes** (stream-controller bearer; body `{ recordingId, sessionRef, agentId, … }`):
`POST /api/openclaw/stream/title`, `POST /api/openclaw/stream/summary`
(`main` or an administrator host turn), `POST /api/openclaw/chat/recent`,
`POST /api/openclaw/chat/delete`, plus the scene routes above. Admins also
get `DELETE /api/broadcast/chat/:eventId` (session, admin group, same-origin
header) and a **Remove** button on live chat. Limits, across all callers:
title and description 3, then one per 10 s each; chat removal 5, then one per
2 s; scene changes as above. Title and description reject control and bidi
override characters.

**Chat removal.** The stored chat line is rewritten in place (temporary file,
fsync, atomic rename) to `{ id, recordingId, ts, t, kind: "chat", source,
level, msg: "", deleted: true }`: the author and text are gone from the
player, replays, and `/api/recordings/:id/events`. A public log event stays:
`Chat message removed: dashboard/live chat moderation — <who> removed message
#<id>.` with `moderation: { op: "chat_delete", target, actor, agentId?, via? }`
and its own timestamp. Players that already received the message drop it when
that event arrives. Only viewer chat on the live recording can be removed.

**Audit.** Every applied action writes a private container log line
(`Stream control applied: dashboard/stream control — <action> by <agent> via
<owner-session|owner-agent|admin-turn|viewer-turn>`), and refusals by the
public host write a warning. The public record is the event itself.

### Usage line after each reply

After each final host reply (live chat, or published assistant text of the
session that owns the stream) the stream log gets one line, recorded like any
log event so replays show it:

```
Usage after reply: dashboard/usage — Codex pool 5h 62% left, resets in 2h 14m; weekly 81% left, resets in 3d 4h 10m · today 1.43M tokens, est. cost unpriced; paid fallback 36.8K tokens.
```

- The Codex pool is `poolCodex` (the Usage Summary's normalization in
  `server/metrics/quota-normalize.js`); it needs the CPA quota panel enabled.
- Today is the UTC day from the metrics store. The paid fallback is every
  route except `cpa`. Cost is the known estimate (admin prices win over
  OpenClaw's); attempts without a price are counted as unpriced, not free.
- At most one line per reply and one per 10 s overall, from cached values.
  The CPA quota is refreshed upstream only when the stored snapshot is 5
  minutes old and this line has not refreshed within 5 minutes; the line
  waits at most 8 s for it. Snapshots older than 10 minutes show their age.
- The event's `usage` field has the same pooled numbers and per-route
  `{ route, tokens, costUsd }`; no account labels, emails, or raw data.

### Thinking effort

Current chat routing tries local Qwen (xhigh), DeepSeek Flash (max), then
CPA Astra (high). Qwen uses per-model `params.thinking: "xhigh"`. Change it in Chat agent settings → Agents & defaults → Chat
reasoning effort. Qwen accepts low, medium, and xhigh. Coding tasks use the
separate OpenCode policy. The measurements below describe the earlier 0.2.5
CPA/OpenAI setup, not the current chat path.

`agents.defaults.thinkingDefault` was `low`, so every run (and the runtime
line the agent reads back) said low. OpenClaw has no per-agent thinking key,
and a run keeps the level chosen for its **primary** model on every fallback.
0.2.5 sets `params.thinking: "high"` on `agents.defaults.models` entries
`cpa/claude-opus-5-5-high`, `cpa/gpt-6-astra`, and `openai/gpt-6-astra`; the
global default stays `low` for other primaries (for example `gpt-6-luna`
cron and subagent runs). Both GPT-6 Astra entries have `reasoning: true` and
the `openai-completions` API, so OpenClaw sends `reasoning_effort: "high"`.
Their `maxTokens` went from 8192 to 32000 (OpenClaw caps requests at 32000),
because reasoning tokens count against `max_completion_tokens`.
Model-start activity now records the run's level (`thinking`, parsed from the
runtime line only) and the log shows `model cpa/gpt-6-astra, thinking high`.

Measured after deployment (same arithmetic prompt, direct API calls): the
official OpenAI `gpt-6-astra` used 101 reasoning tokens at `low` and 140 at
`high` with similar latency (about 5.4 s), so the paid fallback now costs more
reasoning tokens per turn. CPA `gpt-6-astra` returned identical reasoning
tokens at `low` and `high` (72 and 72), so CPA currently does not apply
`reasoning_effort` for that model; fixing that is a CPA (CLIProxyAPI) setting,
not an OpenClaw one. The bigger latency cost is unrelated to thinking: CPA does
not list `claude-opus-5-5-high`, so every turn spends about 20 s on the failing
primary before falling back.

### Structured OpenClaw settings and scheduled tasks (0.2.9)

The OpenClaw Settings and Scheduled tasks tabs are administrator-only and share
the `openclaw-config` panel switch. The task manager uses the existing gateway
endpoint and token; no extra port or environment variable is required. Preserve
`openclaw-device.json` in the host-backed dashboard state directory: it is the
private paired device identity for gateway scheduling calls. Local pairing uses
the gateway's existing trusted-local policy; remote pairing uses normal device
approval. Never expose this key through public routes or logs.

Configuration backups, recordings, metrics, and the existing mounts remain
unchanged. See [the settings runbook](../development/openclaw-settings.md) for
the forms, JSON fallback, APIs, validation, and browser verification.

### Adapter settings (0.3.0)

Mount `DockerVolumes/pcp/adapters` at `/pcp-adapters` and set
`PCP_ADAPTER_CONFIG_DIR=/pcp-adapters`. The directory and policy file are owned
by dashboard uid 1000, mode 700/600. PCP mounts the directory read-only.
`/adapters` requires administrator access to read/change policy; writes require
the existing CSRF header and current revision hash. Backups stay beside the policy.

### Isolated selected-group execution and known-good status (0.3.1)

`/adapters` saves group/sender lists and provisions a minimal OpenClaw group
agent automatically. It permits only PCP context/image tools and pcp_execute.
The trusted PCP executor checks every grant and launches a separate networkless
container; native filesystem/process/session tools and elevation are denied.
The live group list remains empty.

Mount `DockerVolumes/openclaw/deploy/status` read-only at `/platform-status` and
set `PLATFORM_STATUS_DIR`. The Build & LKG panel shows the known-good source
revision and watchdog freshness without exposing private runtime configuration.

### Avatar packs and Circtime controls (0.4.0)

Avatar files persist under `/app/data/avatars` on the existing state bind.
Imported images are re-encoded as PNG without metadata. ZIPs are limited to
12 MiB compressed, 24 MiB expanded, 64 entries and 16 named states, with an
idle state required. Frame types: PNG/JPEG/WebP/GIF (first frame for animations).
Arbitrary SVG/HTML and private remote URL targets are refused. Content-addressed
pack IDs and immutable image URLs preserve older recordings after edits.

The optional manifest is `{"name":"My avatar","states":{"idle":"idle.png",
"blink":"blink.png","talk":"talk.png","think":"think.png","sleepy":"sleepy.png"}}`.
Without a manifest, image filenames become state names. Uploads, remote imports,
state edits and downloads require an administrator. OpenClaw's `scene` action
returns installed pack/state names; its avatar action validates installed names.

Usage Summary and CPA views request fresh quota on load, sharing the existing
30-second single-flight limit. Failures keep the previous timestamped snapshot.
Live metric widgets refresh immediately when loaded/created and periodically
according to Canvas settings.

Circtime's monitor rebuilds the served public-safe files from its source checkout.
`theme=dark` uses black, `theme=light` uses white, and `monochrome=1` selects
status colors. The dashboard iframe stays sandboxed and read-only. The Circtime
upstream contribution is https://github.com/Trance-0/circtime/pull/1.

### 0.4.1 canvas fixes

Circtime merged main 0048de9 is applied locally. Switching the widget's
monochrome property reloads its iframe with the new query setting; preview
selection keeps focus on the canvas and updates the selected property panel
without scrolling to it. Save layout and Apply to live stream remain explicit.


See [dashboard deployment](dashboard.md) for configuration, storage, and rollout.
