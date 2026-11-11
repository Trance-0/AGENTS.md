# Agent Dashboard

A self-hosted dashboard for the AI platform. Hot-pluggable manager panels behind
Casdoor OIDC (`auth.trance-0.com`), with a YouTube-style **live stream window**
that streams logs, records events against stream time, and lets you drag/draw on
the timeline to inspect events at any timepoint.

## Watching and streaming

Guests can watch the public log player, view chat history, and choose visible
recordings from recommendations. Sign in through Casdoor to send live chat or
open manager panels. Hover anywhere on the timeline for a reconstructed log
preview; drag to seek and use Play/Pause for timed replay of logs and chat.
Theater, Web full screen, and Full display modes are available in the player.

Administrators can start and end streams on the main page. Ending saves the
stream as a recording. The recording library includes hidden recordings and
lets admins set visibility and recommendation scores from 0 to 100. Visible
recordings appear to everyone, ordered by score and date. Logs and chat are
checkpointed as they arrive; interrupted streams remain available for replay.

Viewer messages appear in side chat. OpenClaw responds only in the main log
player, using an isolated `dashboard-host` agent with no tools or private
workspace. Sending chat requires sign-in, an active stream, and a same-origin
request. Chat has a five-second per-user cooldown and one host response at a
time; upstream calls time out after 90 seconds.

The owner-facing OpenClaw main agent can also start/status/end broadcasts with
`dashboard_stream` (including `action: summary` for the live description). Its `dashboard-stream` plugin records agent/model/tool
lifecycle events using a separate stream-controller credential. Starting a
stream makes subsequent assistant text in that session public; other sessions
contribute only activity metadata. The public chat host retains its no-tools
policy. See the deployment runbook for installation.

## Stream scenes

The player shows a scene over the log: text, metric, avatar (the owner's
witch), desk cat, clock, allowlisted image widgets, and a faint sandboxed
embed backdrop (the circtime uptime radar, when the operator serves it). The avatar and cat
react to recorded OpenClaw activity (think, talk, blink, sleepy on the paid
fallback; paws on tool and output events). Admins use **Edit scene** under the
player: drag on the stage to add a widget, left-click a widget for its menu,
drag or use the corner handles and arrow keys, Delete to remove, Esc to exit,
Ctrl+Z to undo. Offline edits change the saved default layout that opens every
stream; live edits are also recorded, so replay shows them. See the
[runbook](../docs/deployment/dashboard.md#stream-scenes-and-widgets-020) for
the admin and OpenClaw scene APIs and the CSP.

## Usage and quota

Administrators see the **Usage** group: Summary (pooled Codex quota with reset
countdowns, token totals), CPA quota (per account), and Token metrics.
Save your CPA remote dashboard management key in the quota panel; it is stored
encrypted on the dashboard side. OpenClaw usage offers token and price views,
route/model filters, trends, breakdowns, and editable rates. Usage without a
known price is labeled unpriced. Collection starts with the installed plugin
and does not depend on a public broadcast.

See the [metrics design](../docs/development/dashboard-metrics.md) for the
CC Switch source references and accounting semantics, and the
[deployment runbook](../docs/deployment/dashboard.md#admin-usage-and-quota-metrics)
for the separate encryption key and persistent SQLite storage.

## Panels

Panels are modules discovered from `server/panels/`. Each exports a
`createXxxPanel(ctx)` returning `{ id, title, description, icon, group, order,
tabs, settings, status, data }`. `group` places the panel on one of the sidebar
pages (`live`, `openclaw`, `usage`, `adapters`, `builds`, `settings`; see
`GROUPS` in `server/registry.js`), `order` sorts it within the page, and
`tabs` (default: one tab named `tabTitle` or `title`) lists the tabs it owns.
Disabling a panel is a soft toggle (`panels-state.json`) that gates its routes
with no restart; `data` is served per-panel and server-side resolvers never
reach the browser.

| Group · tab | Panel | Purpose |
|---|---|---|
| Live | `live-stream` | The streaming window (uptime + logs + timeline). |
| OpenClaw · Status, Backends | `openclaw` | Gateway health, agents with model fallback chain; provider and env var names only. |
| OpenClaw · Settings, Scheduled tasks | `openclaw-config` | Grouped configuration forms with optional JSON editing; prompt, model, schedule, and delivery management (admin). |
| Usage · Summary | `usage-summary` | Pooled Codex quota and token totals (admin). |
| Usage · CPA quota | `cpa-quota` | Per-account quota (admin). |
| Usage · Token metrics | `usage-metrics` | Tokens and estimated cost (admin). |
| Adapters · AstrBot | `astrbot` | QQ/WeChat relay status. |
| Builds | `build-status` | Jenkins build / LKG status (read-only). |
| Settings | `settings` | Per-browser theme, motion, autoplay, speed; admin panel switches. |

## OpenClaw settings

OpenClaw → Settings opens a form editor grouped into agents, models, channels,
conversations, tools, gateway, and plugins. JSON is a secondary tab for advanced
editing and backup copies. Values survive switching tabs; masked credentials
are retained and every configuration save backs up the previous file.

OpenClaw → Scheduled tasks lists every enabled and paused job across agents.
Create, edit, pause, or delete tasks using forms for prompts, model overrides,
once/interval/daily/weekly/cron schedules, time zones, execution options, and
result delivery. New tasks start paused. UI and JSON tabs share one draft;
activity shows the gateway's next/last run and delivery status.

Task operations use the authenticated gateway scheduling API, with a persistent
private device identity in dashboard state. Administrators and same-origin
mutations are required. The scheduler validates writes; stale dashboard edits
are rejected. See [the settings runbook](../docs/development/openclaw-settings.md).

## OIDC (Casdoor)

The dashboard signs in through `https://auth.trance-0.com`. It reuses Gitea's
Casdoor OAuth claim/signing configuration with a separate client and groups:

```
gitea:  group-claim groups, required value trance-0/app-gitea
agent:  group-claim groups, required value trance-0/app-agent
```

In Casdoor, create an application for the dashboard (copy the Gitea app) and set
its **Groups** requirement to `trance-0/app-agent`, then configure the redirect
URI `https://live.trance-0.com/auth/callback`. Create `trance-0/admin-agent`
as well; administrators need both groups. Admin mutations, including panel
toggles from the browser, need the admin session and the same-origin
`X-Dashboard-Request: 1` header; scripts may toggle panels with the dashboard
bearer token instead. Verify memberships on the user record. The generated
client ID and secret go in the gitignored `.env`.

## Host models and connection

The dashboard calls the local OpenClaw gateway at `127.0.0.1:18789` with
`model: openclaw:dashboard-host`; OpenClaw resolves the real model. Its exact
order is `cpa/claude-opus-5-5-high` → `cpa/gpt-6-astra` →
`openai/gpt-6-astra` (official API). CPA Gemini models are disabled.
Recorded model events expose the provider/model and gateway run ID so a reply
can be traced to its actual backend. Error completions returned with HTTP 200
are warnings, not successful host replies.

## Configuration

The deployed configuration is the private host file
`/home/motuariki/Documents/DockerVolumes/agent-dashboard/secrets/deploy.env`
(mode 600; see the deployment runbook, "Dashboard storage layout"). For local
runs, copy `.env.example` to `.env` (gitignored) and fill in real values:

| Key | Meaning |
|---|---|
| `OPENCLAW_ENDPOINT` / `OPENCLAW_TOKEN` / `OPENCLAW_AGENT` | Private gateway address, bearer token, and isolated host agent. |
| `ASTRBOT_ENDPOINT` / `ASTRBOT_USERNAME` / `ASTRBOT_PASSWORD` | AstrBot API + dashboard login. |
| `OIDC_*` | Casdoor issuer, client id/secret, redirect URI, required group. |
| `JENKINS_ENDPOINT` / `JENKINS_USER` / `JENKINS_TOKEN` | Read-only build status. |
| `DASHBOARD_TOKEN` | Optional automation path for panel toggles (with an admin session); browsers use the same-origin header instead. |
| `OPENCLAW_STREAM_TOKEN` | Separate machine credential for the OpenClaw stream-control/event bridge. |
| `SESSION_SECRET` | Required session signing secret; generate a random value. |

Secrets never enter git. Jenkins and `compose.yaml` read the private host file
above (`DEPLOY_ENV_SOURCE` / `DASHBOARD_ENV_FILE`); `.env` is only for local runs.

## Run locally

```bash
cd dashboard
cp .env.example .env   # then edit
npm install
npm start              # http://127.0.0.1:14141
```

For local HTTP development, allow and set
`OIDC_REDIRECT_URI=http://127.0.0.1:14141/auth/callback` in the development
Casdoor application. The public deployment uses Secure cookies and HTTPS.

## Public test deployment

The dashboard is served at <https://live.trance-0.com>. From the repository root,
after filling in the private `secrets/deploy.env` and preparing the metrics key/storage
described in the deployment runbook:

```sh
npm ci --prefix dashboard
npm test --prefix dashboard
docker compose -f dashboard/compose.yaml up -d --build
curl --fail --max-time 10 https://live.trance-0.com/healthz
```

Compose binds `127.0.0.1:14143`; the existing local frpc container maps it to
a private FRP remote TCP port. OpenClaw activity uses a shared host directory mounted
read-only in the dashboard; prepare it and configure the plugin as described
in the deployment runbook. The live player shows file-tool target paths and
start/completion events without file contents. Panel toggles and stream
recordings persist in a host bind directory (`DASHBOARD_STATE_HOST_DIR`). Sessions expire
after 12 hours and reset on restart. Panel settings rows display deployment
values read-only; the Settings page's theme, motion, autoplay, and speed
preferences are saved per browser only. See the
[deployment runbook](../docs/deployment/dashboard.md) for OIDC groups, tunnel
setup, logs, and rollback. The [development log](../docs/development/dashboard-log.md)
records fixes and verification for each dashboard round.

## CI/CD

The `agent-dashboard` Jenkins job reads `dashboard/Jenkinsfile` from GitHub
branch `ai-infra-v0`. The GitHub push webhook runs remote checkout, a versioned
image build, Node 22 server tests, an isolated smoke check, recording backup,
and deployment. Runtime secrets stay on the build agent. Existing live streams
resume with the same recording ID after deployment; prior containers and images
are retained for rollback. Changed OpenClaw plugin code is deployed as well.

See the [Jenkins runbook](../docs/deployment/dashboard.md#jenkins-webhook-deployment-013)
for job setup, private env paths, container-agent Git pushes, and verification.
Watching counts browser sessions once across tabs and reconnects. Playback uses
accessible Play/Pause icons; the public description displays the stream summary.

### AstrBot adapter access

Administrator channel-access settings are available at `/adapters`. The list
editor controls owner DM execution and selected groups/senders through a private
policy directory shared read-only with PCP. Group access starts empty; each group
requires its own sandboxed execution agent. PCP checks each tool call against
the current policy and live grant.

### Canvas and avatar editing (dashboard 0.4.0)

Canvas is now a separate administrator panel with Layout and Avatars tabs.
Drag preview widgets to move them, use corner handles to resize, or select
Draw widget to create a rectangle. Save layout changes the default scene;
Apply to live stream records the changes in the current stream.

The avatar library imports ZIP collections from upload or a public HTTPS URL,
previews named states, edits resource mappings as new immutable packs, and
downloads packs. Avatar widget properties select the pack/state and blink
interval/duration. The OpenClaw scene tool returns the available avatar catalog.
Usage Summary checks quota on load by default, has Check now/auto-update controls,
and shows the last snapshot time. Circtime backdrop properties include the
red/yellow/green Monochrome toggle; fixed dark embeds now have black backgrounds.

### Reliable task saves and delegated coding status

Task updates send only changed fields, preserving older stored configuration
that the current gateway write schema does not accept. Successful saves show a
top notification with Undo for five seconds; failures also show a visible alert.
Undo checks the saved revision before reverting.

The shared OpenCode bridge reports sanitized provider billing/auth blockers and
permission waits clearly and supplies the host/container path mapping in coding
requests. PCP's delegated-work monitor carries progress and terminal results
back to the original AstrBot conversation after the initial HTTP turn ends.
