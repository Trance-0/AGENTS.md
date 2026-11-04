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

## Panels

Panels are modules discovered from `server/panels/`. Each exports a
`createXxxPanel(ctx)` returning `{ id, title, description, icon, settings,
status, data }`. Disabling a panel is a soft toggle (`panels-state.json`) that
gates its routes with no restart; `data` is served per-panel and server-side
resolvers never reach the browser.

| Panel | Purpose |
|---|---|
| `live-stream` | The streaming window (uptime + logs + timeline). |
| `openclaw` | Model backend manager: provider names and env var names only. |
| `astrbot` | QQ/WeChat relay status. |
| `build-status` | Jenkins build / LKG status (read-only). |
| `settings` | Placeholder for theme / appearance. |

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
as well; administrators need both groups. Panel-toggle mutations additionally
require the dashboard bearer token. Verify memberships on the user record. The generated
client ID and secret go in the gitignored `.env`.

## Configuration

Copy `.env.example` to `.env` (gitignored) and fill in real values:

| Key | Meaning |
|---|---|
| `OPENCLAW_ENDPOINT` / `OPENCLAW_TOKEN` / `OPENCLAW_AGENT` | Private gateway address, bearer token, and isolated host agent. |
| `ASTRBOT_ENDPOINT` / `ASTRBOT_USERNAME` / `ASTRBOT_PASSWORD` | AstrBot API + dashboard login. |
| `OIDC_*` | Casdoor issuer, client id/secret, redirect URI, required group. |
| `JENKINS_ENDPOINT` / `JENKINS_USER` / `JENKINS_TOKEN` | Read-only build status. |
| `DASHBOARD_TOKEN` | Required by panel-toggle endpoints, along with an admin session. |
| `OPENCLAW_STREAM_TOKEN` | Separate machine credential for the OpenClaw stream-control/event bridge. |
| `SESSION_SECRET` | Required session signing secret; generate a random value. |

Secrets never enter git. In Jenkins the same values are bound from credentials
(see `dashboard/Jenkinsfile`), and `.env` is only for local runs.

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
after filling in `dashboard/.env`:

```sh
npm ci --prefix dashboard
npm test --prefix dashboard
docker compose -f dashboard/compose.yaml up -d --build
curl --fail --max-time 10 https://live.trance-0.com/healthz
```

Compose binds `127.0.0.1:14143`; the existing local frpc container maps it to
remote TCP port 6018. Panel toggles and stream recordings persist in a named volume. Sessions expire
after 12 hours and reset on restart. Settings fields currently display values;
they do not save upstream configuration. See the
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
