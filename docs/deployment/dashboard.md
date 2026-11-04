# Agent dashboard: local Docker and remote HTTPS

The browser connects to `https://live.trance-0.com`. Its remote reverse proxy
terminates TLS and routes HTTP to FRP remote TCP port 6018. The existing local
`frpc` container uses host networking and forwards requests to
`127.0.0.1:14143`. Docker Compose runs `agent-dashboard-v0.1.3` using image
`agent-dashboard:0.1.3`, with Node.js 22 as the unprivileged `node` user.

## Casdoor setup

In `https://auth.trance-0.com`, create application `admin/agent-dashboard` by
copying Gitea's OIDC configuration, with these dashboard-specific values:

- Organization: `trance-0`.
- Homepage: `https://live.trance-0.com/`.
- Redirect URI: `https://live.trance-0.com/auth/callback`.
- Grants: `authorization_code` and `refresh_token`.
- Token format and claims: Gitea's `JWT-Custom` configuration, including
  `Groups` and its `groups` array claim. Retain the signing certificate.
- Disable public sign-up and leave the default group empty.
- Generate a distinct client ID and secret; do not reuse Gitea's credentials.

Create enabled virtual groups `trance-0/app-agent` and `trance-0/admin-agent`.
Assign both to the dashboard administrator. Verify the user record's `groups`
as well as each group's `users`: creating a group with a users list alone did
not update the existing user's groups during this deployment.

Guests can watch public streams and visible recordings without signing in.
The dashboard enforces `app-agent` on sign-in for chat and private panels.
Stream start/end and recording visibility/score changes require `admin-agent`
and the same-origin `X-Dashboard-Request: 1` header. Panel mutations additionally
require `admin-agent` and the `DASHBOARD_TOKEN` bearer token. These permissions
grant no Casdoor-wide administrative rights. Existing sessions must sign out
and back in to acquire changed memberships.

## Private configuration

Copy `dashboard/.env.example` to `dashboard/.env`, set file permissions to
`0600`, and replace all placeholder credentials. Set:

```dotenv
OIDC_ISSUER=https://auth.trance-0.com
OIDC_CLIENT_ID=replace-with-generated-client-id
OIDC_CLIENT_SECRET=replace-with-generated-client-secret
OIDC_REDIRECT_URI=https://live.trance-0.com/auth/callback
OIDC_REQUIRED_GROUP=trance-0/app-agent
OIDC_ADMIN_GROUP=trance-0/admin-agent
```

Generate independent random `SESSION_SECRET` and `DASHBOARD_TOKEN` values.
The integration endpoints are `http://127.0.0.1:18789` for OpenClaw,
`http://127.0.0.1:6185` for AstrBot, and `http://127.0.0.1:8081` for Jenkins.
The manager panels probe availability and expose configuration names. Live
chat additionally requires `OPENCLAW_TOKEN` and `OPENCLAW_AGENT=dashboard-host`;
keep that operator credential in the private environment file only.
Settings fields are displays; they do not save upstream configuration.

Verify ignored credentials with `git check-ignore dashboard/.env`. Never print
the resolved Compose configuration: it contains the environment secrets.

## Start or update

From the repository root:

```sh
ss -ltn 'sport = :14143'
npm ci --prefix dashboard
npm test --prefix dashboard
docker compose -f dashboard/compose.yaml config --quiet
docker compose -f dashboard/compose.yaml up -d --build
docker compose -f dashboard/compose.yaml ps
curl --fail --max-time 10 http://127.0.0.1:14143/healthz
```

Port 14143 must be free or already owned by this deployment. Port 14141 is used
by a separate development instance on this host and is left intact.
The `dashboard_dashboard-state` volume stores panel toggles at `/app/data`;
do not remove it during updates. Sessions use a bounded in-memory store and
expire after 12 hours; restarting the container requires signing in again.

## FRP mapping

The active local `frpc` configuration is bind-mounted from
`/home/motuariki/Documents/workspace/frpc/dgx/frpc-docker-dgx.toml` to
`/etc/frp/frpc.toml`. Back it up privately before editing. Add this proxy while
preserving all other proxy entries:

```toml
[[proxies]]
name = "dgx-agent-dashboard"
type = "tcp"
localIP = "127.0.0.1"
localPort = 14143
remotePort = 6018
```

Validate before restarting the existing container:

```sh
docker exec frpc /usr/bin/frpc verify -c /etc/frp/frpc.toml
docker restart frpc
docker logs --since 1m frpc 2>&1 | rg 'dgx-agent-dashboard'
curl --fail --max-time 10 https://live.trance-0.com/healthz
```

The current frpc configuration has no admin API for hot reload. Restarting
briefly reconnects its other tunnels. A private copy of the original config
was retained in `~/.local/state/agent-dashboard/` for this deployment.

The remote reverse proxy must preserve `X-Forwarded-Proto: https`. The app
trusts forwarded headers from loopback, sets Secure/HttpOnly/SameSite=Lax
cookies, and sends `X-Accel-Buffering: no` for the log stream. Direct HTTP access
to remote port 6018 cannot set the secure login cookie; use the HTTPS hostname.

## Verification and logs

`npm test --prefix dashboard` exercises a local OIDC issuer with signed ID
tokens: missing or mismatched login state, nonce validation, group denial,
viewer mutation denial, session regeneration, logout, HTTPS cookies, bearer
tokens, and JSON panel toggles. It runs against isolated temporary state.

For a live check, sign in through the public hostname with an authorized
Casdoor account. Verify panel status and that log events arrive immediately.
An unauthenticated `/api/panels` request must return 401; a signed-in viewer
without `app-agent` must be denied at the callback. A viewer with `app-agent`
and without `admin-agent` must receive 403 for mutations even with a valid
bearer token. Remove any temporary test identities after testing.

```sh
docker logs --timestamps --tail 100 agent-dashboard-v0.1.3
docker inspect agent-dashboard-v0.1.3 --format '{{.State.Health.Status}}'
```

Docker retains three rotated JSON log files of up to 10 MB each. Application
records contain timestamp, level, and diagnostic message; sign-in events omit
personal identity data. Bearer tokens, OIDC secrets, and session cookies must
never be included in logs.

## Rollback

Before a future update, retain the current image under a distinct local tag.
To roll back, restore the previous source revision or retag the retained image
as `agent-dashboard:0.1.3`, then run
`docker compose -f dashboard/compose.yaml up -d --no-build`. Keep the private
environment file and state volume. To remove just the dashboard exposure,
restore the saved FRP configuration, validate it, and restart `frpc`; other
services and the existing development dashboard do not need changing.

`dashboard/Jenkinsfile` is the active Pipeline-from-SCM deployment. The job
pulls GitHub branch `ai-infra-v0` and reads this file from the remote checkout.
Local files supply runtime secrets only. See the Jenkins section below.


## OpenClaw public host

Create a dedicated agent in the existing gateway configuration, preserving
other agents and bindings. This deployment uses:

```json
{
  "id": "dashboard-host",
  "name": "Dashboard Host",
  "workspace": "/home/node/.openclaw/dashboard-host",
  "tools": { "profile": "minimal", "deny": ["*"] },
  "memorySearch": { "enabled": false }
}
```

Its workspace contains only public host/personality instructions. The existing
private main and relay workspaces are not shared. The gateway's existing
`gateway.http.endpoints.chatCompletions.enabled` must be true. Validate config
with `docker exec openclaw-openclaw-gateway-1 node dist/index.js config validate`.
Agent-list changes are dynamically reloaded; no gateway restart was needed.
A private pre-change gateway configuration backup is under
`~/.local/state/agent-dashboard/`. Do not expose its contents or gateway token.
The dashboard sends requests only to this agent and saves host replies only as
main player log events. It never delivers chat to external channels.

## Recording storage and moderation

Admins use Start stream / End stream on the main page. The default state after
a fresh install is offline; ordinary process startup does not start a stream.
Existing recordings survive container updates in `dashboard_dashboard-state`.
Each recording has `recordings/<UUID>.json` metadata and a corresponding
`recordings/<UUID>.ndjson` event file. Appends and metadata writes are synced to
disk before events are broadcast. After a restart, the same live stream resumes with its original recording ID
and start time. A partial trailing event is truncated before appending the
recovery event; all complete events and the current summary remain intact.

The event envelope keeps `id`, `ts`, `t`, `source`, `level`, and `msg`; `kind`
separates log and chat events, `recordingId` binds each event to a stream, and
chat includes the public display name. Future canvas actions can use additional
event kinds and payload fields. Current playback renders log events as text
and chat in the side panel at their original elapsed timestamps. Private
operational diagnostics are kept out of the public stream and recording files.

The recording library is admin-only. Hide excludes a recording from the public
catalog and blocks its event URL for guests and regular members. Admins retain
access. Scores from 0 to 100 order recommendations, with newest first for ties.
All visible recommendations are selectable by viewers. Event retrieval is
paginated at 1000 events per request; playback downloads pages with progress
and reconstructs the selected time without forcing the viewer back to live.

Before an update, back up `/app/data` and retain the previous versioned image.
Rollback uses the previous Compose source and image without removing the
volume. Version 0.1.0 can run against the volume but does not expose recordings;
retain a version 0.1.1 backup to restore recording playback later.

## Browser verification

The optional browser check uses an external Playwright install so browser
packages do not enter the production dependency tree. With Playwright and an
installed Chromium executable, run from the repository root:

```sh
DASHBOARD_BROWSER_CHECK=1 \
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
CHROMIUM_PATH=/absolute/path/to/chrome \
npm test --prefix dashboard
```

It runs against the temporary signed-token OIDC fixture and mock OpenClaw,
covering guest access, hover content, timestamp replay, chat separation,
responsive recommendations, screen modes, avatars, start/end, and moderation.
`npm test --prefix dashboard` also checks restart recovery, Unicode NDJSON
pagination, visibility/ranking, cross-stream reply isolation, and auth gates.


## OpenClaw stream control and lifecycle events (0.1.2)

The source plugin is `dashboard/openclaw-plugin/`. Copy that directory into
`/home/node/.openclaw/extensions/dashboard-stream` in the gateway's persistent
configuration mount. Generate a random machine token and place it in both the
ignored dashboard `OPENCLAW_STREAM_TOKEN` environment variable and a private
`/home/node/.openclaw/dashboard-stream.token` file (mode `0600`). This token
is separate from the gateway bearer token, browser sessions, and panel token.
Never put it in a prompt, tool argument, public log, or committed config.

Add the plugin ID to `plugins.allow`, retain existing plugin entries, and set:

```json
{
  "plugins": {
    "load": { "paths": ["/home/node/.openclaw/extensions/dashboard-stream"] },
    "entries": {
      "dashboard-stream": {
        "enabled": true,
        "config": {
          "endpoint": "http://127.0.0.1:14143",
          "tokenFile": "/home/node/.openclaw/dashboard-stream.token"
        }
      }
    }
  }
}
```

Append `dashboard_stream` to the main agent's `tools.alsoAllow`, preserving its
existing policy. The tool factory additionally requires agent `main` and a
trusted owner sender. The `dashboard-host` agent remains tool-denied, so public
chat cannot operate stream controls. Config validation is read-only with:

```sh
docker exec openclaw-openclaw-gateway-1 node dist/index.js config validate
```

Plugin changes require a gateway restart. On this host its configured
`on-failure` restart policy does not restart an orderly exit with status 0;
a plugin-triggered respawn left it stopped. Recover with
`docker start openclaw-openclaw-gateway-1` after confirming the state, then
check `/healthz` and `plugins list --json`. No volumes or existing agents need
recreation. The installed plugin directory is pinned in `plugins.load.paths`
to preserve explicit source provenance.

Ask the owner-facing OpenClaw agent to use `dashboard_stream` with
`action: start` and a title. `status` reports the stream; `end` saves it.
`action: summary` with `summary` text (1–4000 characters) sets the current live
description and persists it into the recording. The trusted owner-facing main agent may summarize the current live stream,
including streams started by a dashboard administrator; stream ownership stays
unchanged.
Repeated starts from the same session return the existing stream; a different
session cannot take over or end it. Browser administrators retain their
Start/End controls and recording moderation.

The machine API is `/api/openclaw/stream` (GET),
`/api/openclaw/stream/start`, `/api/openclaw/stream/end`, and
`/api/openclaw/stream/summary` (POST), and
`/api/openclaw/events` (POST). Every route requires the separate bearer token.
Event submissions target the recording ID and use unique event references to
avoid duplicate delivery. Events for ended or replaced streams are rejected.

Six native plugin hooks record agent start/end, model input/output milestones,
and tool start/end. Public metadata includes agent/model/tool names, status,
and duration. Prompts, system instructions, transcripts, tool parameters,
results, and raw errors are never forwarded. The session that explicitly starts
a broadcast may publish its assistant output as public log text; other sessions
publish metadata only. Side-chat host text continues through the existing
chat-response path, avoiding duplicate assistant text. These log events use the
existing NDJSON envelope and replay automatically with the stream.

The event queue serializes delivery with five-second request timeouts and a
256-event pending limit. Dashboard failures are logged and do not terminate an
agent run. Disconnected events can be lost; the bridge is not a durable replay
of the gateway's private history. It records live activity while a stream is on.


## Jenkins webhook deployment (0.1.3)

Job: `https://jenkins.trance-0.com/job/agent-dashboard/`.
SCM: `https://github.com/Trance-0/AGENTS.md.git`, branch `ai-infra-v0`,
script `dashboard/Jenkinsfile`, agent label `local-docker`.
The GitHub webhook targets `https://jenkins.trance-0.com/github-webhook/`.
The job and Jenkinsfile both register the GitHub push trigger. A push to this
branch builds that remote revision; the host working tree is not used.

To configure or repair the job, run on the host with private credentials:

```sh
read -r -s -p 'Jenkins password/token: ' JENKINS_PASSWORD
export JENKINS_PASSWORD
python3 dashboard/scripts/configure-jenkins.py --branch ai-infra-v0
unset JENKINS_PASSWORD
```

Runtime env lives at
`/home/motuariki/Documents/DockerVolumes/agent-dashboard/secrets/deploy.env`
on the host and Jenkins agent (mode `0600`). Populate it with the same keys as
`dashboard/.env.example`. It is independent from SCM and survives pushes.
The agent's workspace is mounted at the same absolute host path so test
container binds resolve against the checked-out remote source.

Stages: checkout remote → versioned image build → Node 22 server tests →
isolated container health check → stop writes and back up state → deploy →
local/public health verification → update installed OpenClaw plugin if changed.
Images include the package version and Jenkins build number; containers include
the software version. The existing `dashboard_dashboard-state` volume is reused.
Backups live under
`/home/motuariki/Documents/DockerVolumes/agent-dashboard/backups/<UTC stamp>/`.
The prior container and image are retained. A failed app rollout starts the
prior container again. Gateway plugin updates restart only that gateway; the
live recording continues in the dashboard container.

Verify the build cause says **Started by GitHub push** and the checkout SHA
matches the pushed commit. A manually queued build proves the pipeline only;
it does not prove delivery of a GitHub webhook. See the development log for
current run evidence.

The owner agent's checkout is
`/home/node/.openclaw/workspace/projects/agent-dashboard` in the gateway
container, on branch `ai-infra-v0`. Its repo-local SSH command uses the dedicated
key at `/home/node/.openclaw/dashboard-git/id_ed25519` and a pinned GitHub
known-hosts file. Add the matching public key as a **write-enabled deploy key**
for this GitHub repository. Private keys never enter the checkout or prompts.
After committing changes there, `git push origin ai-infra-v0` triggers Jenkins.

## Browser-session viewer counting and player controls

The watching count represents browser sessions currently connected to the
player's event feed. A signed HttpOnly session cookie is established before
opening the feed; every tab in that browser session shares it. Multiple tabs
and SSE reconnects cannot inflate the count. Separate profiles or browser
sessions have separate cookies and each count once. Closing the final
connection removes that session. This is a current audience count, not lifetime
unique users or IP addresses, and does not require another database container.

Playback uses accessible SVG Play/Pause icon controls. Pausing live playback
stops following the stream at the current time; Go live resumes following.
OpenClaw's current session summary is displayed beneath the player and remains
in saved recording metadata and the summary-change log event.
