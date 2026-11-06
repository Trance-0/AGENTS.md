# Agent dashboard: local Docker and remote HTTPS

## Shared OpenClaw activity logs

Create the shared host directory before deploying:
`/home/motuariki/Documents/DockerVolumes/openclaw/activity` (owned by UID/GID
1000, mode 0750). Both containers bind it at `/var/log/openclaw-activity`:
OpenClaw has read/write access; the dashboard uses a read-only mount. Override
the host location with `OPENCLAW_ACTIVITY_HOST_DIR` in Compose or the Jenkins
deployment environment. Set the gateway's `dashboard-stream` plugin config
`activityDir` to `/var/log/openclaw-activity` and dashboard env
`OPENCLAW_ACTIVITY_DIR` to that same container path.

The plugin writes `activity-YYYY-MM-DD.jsonl`. Only agent/model/tool lifecycle
metadata and read/write/edit target paths are exported, with sensitive file
names masked. Commands, file contents, raw provider errors, credentials, and
session transcripts stay private. Owner-session assistant text retains its
existing authorized HTTP delivery. The dashboard only reads the shared files;
its ingestion cursor and stream recordings remain in its own data volume.

The reader checks for new records every 500 ms and resumes after restart.
First attachment skips historical activity; events produced before the current
stream began cannot enter that stream. Truncation, daily rotation, and partial
UTF-8 lines are handled. Stream start/end remains owner/admin controlled.
The existing recording and ID survive deployment. Verify Docker reports
`RW=false` for the dashboard activity mount and that a live `read` tool call
shows both its starting and completed file-path events in the public player.

The browser connects to `https://live.trance-0.com`. Its remote reverse proxy
terminates TLS and routes HTTP to a private FRP remote TCP port. The existing local
`frpc` container uses host networking and forwards requests to
`127.0.0.1:14143`. Docker Compose runs `agent-dashboard-v0.2.3` using image
`agent-dashboard:0.2.3`, with Node.js 22 as the unprivileged `node` user.

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
Stream start/end, recording visibility/score changes, and panel enable/disable
toggles require `admin-agent` and the same-origin `X-Dashboard-Request: 1`
header; admins toggle a panel with the "Panel enabled" switch at the top of
each of its tabs, or from **Settings → Panels**, which lists every panel.
Non-browser automation may instead send the `DASHBOARD_TOKEN`
bearer with an admin session; a present but wrong bearer is rejected (401),
never treated as the header path. Disabled and admin-only panels (Usage
summary, CPA quota, OpenClaw usage, OpenClaw config) are not shown to members,
and a sidebar group is listed only when it has a panel the viewer can see;
guests see only Live. These permissions grant no Casdoor-wide administrative rights.

The sidebar has six groups, each one page with tabs: **Live** (the player),
**OpenClaw** (Status, Backends, Config), **Usage** (Summary, CPA quota, Token
metrics), **Adapters** (AstrBot), **Builds**, and **Settings**. Panels declare
`group`, `order`, and `tabs` in the registry (`server/registry.js`); the
existing panel IDs, soft toggles, and data routes are unchanged. Pages are
linkable as `#group/tab` (for example `#usage/cpa-quota`); old `#panel-id`
links open the panel's group. Existing sessions must sign out
and back in to acquire changed memberships.

## Private configuration

The private runtime environment (all dashboard config and secrets) is the
host file
`/home/motuariki/Documents/DockerVolumes/agent-dashboard/secrets/deploy.env`
(owner 1000:1000, mode `0600`, directory mode `0700`). Jenkins deploys with it
(`DEPLOY_ENV_SOURCE`), and `compose.yaml` reads it by default (override with
`DASHBOARD_ENV_FILE`). Create it from `dashboard/.env.example` and replace all
placeholder credentials. Since 0.2.8 no copy lives in the repository working
tree: on the host, `dashboard/.env` is only a symlink to that file for the
local development instance (`npm start`), and `scripts/deploy.py` refuses an
environment file that is a symlink or sits inside the checkout. Set:

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
Panel settings rows that show endpoints or files are read-only displays of
this environment. The Settings page (theme: system/light/dark; motion:
system/reduce/full; autoplay recordings; playback speed) and the top-bar theme
button are per-browser preferences in `localStorage` (`agent-dashboard.theme`,
`agent-dashboard.motion`, `agent-dashboard.autoplay`,
`agent-dashboard.playbackRate`); they are never sent to the server.

Verify ignored credentials with `git check-ignore dashboard/.env`. Never print
the resolved Compose configuration: it contains the environment secrets
(`docker compose ... config --quiet` only validates).

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
Dashboard state (`/app/data`: panel toggles, recordings, scene layout and
settings, config-editor backups, activity cursors) lives in the host directory
`/home/motuariki/Documents/DockerVolumes/agent-dashboard/state` (owner
1000:1000, mode 700; override with `DASHBOARD_STATE_HOST_DIR`), bind-mounted by
both `compose.yaml` and `scripts/deploy.py`. Compose does not create it
(`create_host_path: false`); see "Dashboard state storage (0.2.6)". Do not
remove it during updates. Sessions use a bounded in-memory store and
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
remotePort = <private-remote-port>
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
to a private FRP remote port cannot set the secure login cookie; use the HTTPS hostname.

## Verification and logs

`npm test --prefix dashboard` exercises a local OIDC issuer with signed ID
tokens: missing or mismatched login state, nonce validation, group denial,
viewer mutation denial, session regeneration, logout, HTTPS cookies, bearer
tokens, and JSON panel toggles (browser header path, cross-origin and viewer
denial, wrong-bearer rejection). It runs against isolated temporary state.

For a live check, sign in through the public hostname with an authorized
Casdoor account. Verify panel status and that log events arrive immediately.
An unauthenticated `/api/panels` request must return 401; a signed-in viewer
without `app-agent` must be denied at the callback. A viewer with `app-agent`
and without `admin-agent` must receive 403 for mutations, including panel
toggles, even with a valid bearer token. Remove any temporary test identities after testing.

```sh
docker logs --timestamps --tail 100 agent-dashboard-v0.2.3
docker inspect agent-dashboard-v0.2.3 --format '{{.State.Health.Status}}'
```

Docker retains three rotated JSON log files of up to 10 MB each. Application
records contain timestamp, level, and diagnostic message; sign-in events omit
personal identity data. Bearer tokens, OIDC secrets, and session cookies must
never be included in logs.

## Rollback

Before a future update, retain the current image under a distinct local tag.
To roll back, restore the previous source revision or retag the retained image
as `agent-dashboard:0.2.6`, then run
`docker compose -f dashboard/compose.yaml up -d --no-build`. Keep the private
environment file and the state directory. Images older than 0.2.6 expect the
legacy `dashboard_dashboard-state` volume; see "Dashboard state storage (0.2.6)"
for rolling back across the storage change. To remove just the dashboard exposure,
restore the saved FRP configuration, validate it, and restart `frpc`; other
services and the existing development dashboard do not need changing.

`dashboard/Jenkinsfile` is the active Pipeline-from-SCM deployment. The job
pulls GitHub branch `ai-infra-v0` and reads this file from the remote checkout.
Local files supply runtime secrets only. See the Jenkins section below.


## Dashboard state storage (0.2.6)

`/app/data` is a bind mount of
`/home/motuariki/Documents/DockerVolumes/agent-dashboard/state` (owner
1000:1000, mode 700), overridable with `DASHBOARD_STATE_HOST_DIR` for both
`scripts/deploy.py` and `compose.yaml`. It holds `recordings/`, `scene/`,
`panels-state.json`, `openclaw-config-backups/`, and
`openclaw-activity-cursor.json`. Metrics stay in their own bind directory.

`scripts/deploy.py`, after it stops the previous container and archives the
active state (`backups/<stamp>/data.tar`, from whichever of the volume or the
directory that container used):

1. creates the directory if missing (1000:1000, 700) through a root helper
   container, so it works whatever user the Jenkins agent runs as;
2. if the directory is empty and the legacy volume `dashboard_dashboard-state`
   has data, copies it with `cp -a` (owners, modes, times preserved) and
   compares a manifest of every entry (path, owner, mode, size, SHA-256) of
   both sides; any difference stops the deploy and restarts the previous
   container on its volume;
3. if both have data, uses the directory and logs that the volume was left
   alone;
4. refuses to start when the directory is still empty while the volume has
   data;
5. after starting, checks that `docker inspect` shows a bind mount of the
   directory at `/app/data`.

The legacy volume is never deleted or written. Check with
`docker inspect agent-dashboard-v<version> --format '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}}{{println}}{{end}}'`.

**Rollback across the storage change** (to an image older than 0.2.6): stop
the 0.2.6+ container, then start the retained previous container (it still
mounts the volume) with `docker start agent-dashboard-v<old>` or recreate it
with `--mount type=volume,src=dashboard_dashboard-state,dst=/app/data`. The
volume holds the state as of the migration; anything recorded afterwards is
only in the directory. To carry it back, copy the directory into the volume
with a root helper container
(`docker run --rm --user 0 --entrypoint sh --mount type=bind,src=<state dir>,dst=/from,readonly --mount type=volume,src=dashboard_dashboard-state,dst=/to <image> -c 'cp -a /from/. /to/'`)
while no dashboard container is running. Also restore
`scene/scene-layout.v1.json` as `scene/scene-layout.json` if a saved layout
was migrated (see "Stream scenes and widgets").


## Dashboard storage layout (0.2.8)

A recreated container keeps everything: every persistent path is a host bind
under `/home/motuariki/Documents/DockerVolumes/`, set by both
`scripts/deploy.py` and `compose.yaml`. Nothing persistent is in a named
volume, the container layer, or the repository working tree.

| Host path (under `DockerVolumes/`) | Container path | Owner, mode | Contents |
|---|---|---|---|
| `agent-dashboard/state/` | `/app/data` (rw) | 1000:1000, 700 | recordings, scenes, panel state, `openclaw-config-backups/`, activity cursor |
| `agent-dashboard/metrics/` | `/app/metrics` (rw) | 1000:1000, 700 | `metrics.sqlite` (+WAL), encrypted CPA credential |
| `agent-dashboard/secrets/deploy.env` | env file (not mounted) | 1000:1000, 600 | all runtime config and secrets |
| `agent-dashboard/secrets/metrics-encryption.key` | `/run/secrets/metrics-encryption.key` (ro) | 1000:1000, 400 | metrics master key |
| `agent-dashboard/backups/<UTC stamp>/` | not mounted | root, 700 | per-deploy `data.tar`, `metrics.tar`, replaced plugin |
| `circtime/dist/` (circtime's) | `/embed-src/circtime` (ro) | — | embed build |
| `openclaw/config/` (OpenClaw's) | `/openclaw-config` (rw) | — | live `openclaw.json` |
| `openclaw/activity/` (OpenClaw's) | `/var/log/openclaw-activity` (ro) | — | activity metadata |

On each deploy, `scripts/deploy.py` restores `secrets/` to 1000:1000/700,
`deploy.env` to 600, and `backups/` to 700 (through a root helper
container), and after start it checks that `docker inspect` shows bind mounts
for `/app/data`, `/app/metrics`, and the key; otherwise it removes the new
container and restarts the previous one. Sessions are in memory by design
(sign in again after a restart). `docker diff` on the running container shows
only mount points. The legacy `dashboard_dashboard-state` volume is still kept
for rollback. Rollback for 0.2.8 itself: restart the retained
`agent-dashboard-v0.2.7` container (same mounts); if the dev instance needs a
plain file again, replace the `dashboard/.env` symlink with a copy of
`deploy.env` (mode 600).

## Jenkins storage (host)

The Jenkins controller and its agents keep all data in plain bind mounts
under `/home/motuariki/Documents/DockerVolumes/jenkins/`: `jenkins_home/`
(controller `/var/jenkins_home`: jobs, build history, plugins, credentials),
`agent_home/` (agent `/var/lib/jenkins`: agent secret, `secrets/*-deploy.env`,
`backups/`), `workspace/` (node remote root, bound at the same absolute path so
build containers resolve workspace binds), plus the empty `agent_jenkins_home/`
and `registry_proxy_home/`. Their compose file is
`DockerVolumes/jenkins/config/compose.yaml` (start with `config/start.sh`); it
contains no secrets. Until 2026-11-06 the same directories were reached
through the bind-backed named volumes `jenkins_*_persistent`; those volume
objects are kept for rollback. Backups and the rollback procedure are in the
private host note `DockerVolumes/jenkins/README.md`. The buildx builder state
(`buildx_buildkit_pcp-jenkins0_state`) is a disposable build cache and stays a
builder-managed volume.

## OpenClaw public host

Create a dedicated agent in the existing gateway configuration, preserving
other agents and bindings. This deployment uses:

```json
{
  "id": "dashboard-host",
  "name": "Dashboard Host",
  "workspace": "/home/node/.openclaw/dashboard-host",
  "tools": { "profile": "minimal", "alsoAllow": ["dashboard_stream"], "deny": ["session_status"] },
  "memorySearch": { "enabled": false }
}
```

Since 0.2.5 its only tool is `dashboard_stream`, and the dashboard decides
per turn what it may do (see [OpenClaw live control](#openclaw-live-control-title-description-chat-moderation-widgets-0-2-5)).
Before 0.2.5 it was `deny: ["*"]`, and the workspace `AGENTS.md` said "Do not
use tools"; together they are why it answered that tool use and operational
access were disabled. The workspace instructions (host-only, not in this
repository) now say that `dashboard_stream` is its only tool, that the
dashboard decides per turn from the verified sign-in, and that a refusal is
final. The previous text is backed up in the private
`~/.local/state/agent-dashboard/` directory.

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
Existing recordings survive container updates in the state directory
(`/home/motuariki/Documents/DockerVolumes/agent-dashboard/state`; before 0.2.6,
the `dashboard_dashboard-state` volume).
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
state directory or the legacy volume. Version 0.1.0 can run against the volume but does not expose recordings;
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
It also covers the player controls: icons, play/pause state, the speed menu
(2x replay timing and live 1x lock), and YouTube-style auto-hide.
`scripts/ui-browser-check.mjs` covers system/light/dark themes (persistence,
no flash on reload, settings/top-bar sync), viewer versus admin sidebars, the
icon rail and mobile menu, and an in-browser admin panel toggle.
`scripts/pages-browser-check.mjs` covers the grouped pages and tabs (keyboard,
deep and legacy links), the usage summary, the OpenClaw agent/fallback table,
the Settings controls, the admin panel-switch list, and 390 px layouts in both
themes. If the host
Node.js is older than 22, run it inside the matching
`mcr.microsoft.com/playwright:v<version>-noble` image with the dashboard
`node_modules` and the Playwright package mounted read-only.
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
trusted owner sender. Since 0.2.5 the `dashboard-host` agent has only this
tool, and the dashboard limits it per turn: administrator turns may run the
live stream, viewer turns may only set a timed avatar expression (see
[OpenClaw live control](#openclaw-live-control-title-description-chat-moderation-widgets-0-2-5)). Config validation is read-only with:

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
unchanged. Since 0.2.5 it may not change a stream another OpenClaw session
started (the same rule as `end`).
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
on the host and Jenkins agent (owner 1000:1000, mode `0600`, in a `0700`
directory; see "Dashboard storage layout (0.2.8)"). Populate it with the same keys as
`dashboard/.env.example`. It is independent from SCM and survives pushes.
The agent's workspace is mounted at the same absolute host path so test
container binds resolve against the checked-out remote source.

Stages: checkout remote → versioned image build → Node 22 server tests →
isolated container health check → stop writes and back up state → deploy →
local/public health verification → update installed OpenClaw plugin if changed.
Images include the package version and Jenkins build number; containers include
the software version. State is the bind directory
`/home/motuariki/Documents/DockerVolumes/agent-dashboard/state` (0.2.6; it was
the `dashboard_dashboard-state` volume before).
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


## Stream host model policy (0.1.4)

The canonical private gateway config is `.openclaw/openclaw.json` in the
OpenClaw persistent mount. Set both `agents.defaults.model` and the
`dashboard-host` entry's `model` to:

```json
{
  "primary": "cpa/claude-opus-5-5-high",
  "fallbacks": ["cpa/gpt-6-astra", "openai/gpt-6-astra"]
}
```

These are the exact configured IDs: CPA publishes Opus 5.5 as
`claude-opus-5-5-high`. The official `openai` provider uses
`https://api.openai.com/v1`. Preserve existing provider key references; do not
copy credentials into the dashboard, prompts, or documentation. Ensure all
three IDs are in `agents.defaults.models` if its model allowlist is enabled.
Remove CPA Gemini entries from that allowlist and `models.providers.cpa.models`.
Check agent overrides and cron/session overrides for old CPA Gemini selections.
Generated agent model registries must also reflect the updated canonical list.
Historical transcripts and recorded events may still mention older models;
these do not authorize selecting them on a new run.

Validate with `docker exec openclaw-openclaw-gateway-1 node dist/index.js config validate`.
After changes, restart the gateway and dashboard, preserving the shared
activity mount and recording volume. A Jenkins deployment of a changed plugin
restarts both services. Confirm the main and `dashboard-host` resolved model
orders after restart and verify a real multi-turn request using existing
conversation history.

The 0.1.4 deployment checks found CPA Opus 5.5 listed but unavailable with HTTP
503 `auth_unavailable`. Native OpenClaw fallback selected CPA GPT-6 Astra and
completed two consecutive turns. A direct official API GPT-6 Astra probe also
succeeded. Opus availability depends on CPA restoring authentication for that
upstream model; changing dashboard credentials cannot fix that response.

Model activity records now include `provider`, `model`, and `runId`, and the
host reply preserves the gateway completion ID as `runId`. The modern
`before_model_resolve` hook records the start of a model attempt; the legacy
`before_agent_start` hook was called twice across model/prompt phases. Legitimate
fallback attempts can still produce separate start events at different times.
Shared file logs and the existing authenticated HTTP event path remain intact.

## OpenClaw config editor and AstrBot relay (0.1.5)

### Shared config directory

The live OpenClaw config is `/home/motuariki/Documents/DockerVolumes/openclaw/config/openclaw.json`
(directory mode `0700`, file `0600`, UID/GID 1000). Mounts:

| Container | Mount | Access |
| --- | --- | --- |
| `openclaw-openclaw-gateway-1` / `openclaw-cli` | `/etc/openclaw`, with `OPENCLAW_CONFIG_PATH=/etc/openclaw/openclaw.json` | read-only |
| `agent-dashboard-v*` | `/openclaw-config`, with `OPENCLAW_CONFIG_FILE=/openclaw-config/openclaw.json` | read-write |

The directory is bind-mounted rather than the file, so the dashboard's atomic
`rename` replacement is visible inside OpenClaw, and OpenClaw's watcher
hot-reloads it. The old writable `~/.openclaw/openclaw.json` was moved out of
the state directory. OpenClaw can no longer rewrite its own config: `config set`,
onboarding, and doctor/auto-update writes fail with `EROFS`. Auto-update is off
(`update.auto.enabled=false`) because the container image is pinned.

The config holds no literal credentials. `gateway.auth.token` and
`channels.telegram.botToken` are env SecretRefs (`OPENCLAW_GATEWAY_TOKEN`,
`TELEGRAM_BOT_TOKEN`) supplied from OpenClaw's private `.env`. Validate it with
`docker compose -f <openclaw>/docker-compose.yml run --rm --no-deps -T openclaw-cli config validate`.

### Editing from live.trance-0.com

The **OpenClaw config** panel requires a signed-in `trance-0/admin-agent` member.
Regular viewers get 403 even for reads. Saves also require the same-origin
`X-Dashboard-Request: 1` header.

- `GET /api/admin/openclaw-config` returns the config with string values under
  secret-looking keys (`*token`, `*secret`, `*password`, `*apiKey`, `*cookie`,
  …) replaced by `__dashboard_redacted__`. Env SecretRefs and `*File` paths
  are shown unchanged.
- `PUT /api/admin/openclaw-config` with `{ text, baseHash }`:
  - invalid JSON and non-object roots are rejected (400);
  - a hash that no longer matches the file is rejected (409), so concurrent
    edits never overwrite each other;
  - placeholders are restored from the live file; a placeholder with no
    stored original is rejected;
  - the previous file goes to `/app/data/openclaw-config-backups/` (newest 20
    kept) before the replacement is written as `0600`.
- Saves are recorded in the dashboard container log with the admin's subject
  ID, never in the public stream. Disabling the panel gates both routes
  without a restart.

This intentionally differs from build-plan Task 11 ("commit to an
`agent-stack` branch, never edit live files"): the owner chose live editing for
v0. Every save is backed up. Roll back by copying a backup over the live file.

### AstrBot → OpenClaw relay

AstrBot runs with host networking and uses provider source `openclaw`
(`http://127.0.0.1:18789/v1`, OpenAI-compatible, gateway token, timeout 300 s).
Its default agent-runner provider is `openclaw/relay` with no fallback, so
OpenClaw is the only backend; OpenClaw applies its own model fallbacks. The
model name selects OpenClaw's `relay` agent (`tools.profile: minimal`). AstrBot
does not send the OpenAI `user` field, so every request is a new OpenClaw
session and AstrBot supplies the conversation history. Per-platform AstrBot
config profiles (`data/config/abconf_*.json`) keep their own provider choice;
bind a channel to the default profile, or set its profile's provider to
`openclaw/relay`.

The dashboard shows relay receipt without an AstrBot credential. The OpenClaw
activity file already records `relay` agent lifecycle metadata. The dashboard
labels those events `AstrBot relay message received / reply generated /
request completed` (source `astrbot`). The AstrBot panel shows the request
count, the last request and reply times, and failures. Message text, senders,
and conversation IDs are never exported.

### Loopback-only listeners

OpenClaw now binds `127.0.0.1:18789` (`OPENCLAW_GATEWAY_BIND=loopback`), and its
Compose file publishes no ports under host networking. The Control UI accepts
only loopback origins with device auth enabled; reach it through an SSH tunnel.
AstrBot's dashboard (6185) and reverse-WebSocket listeners (6099/6199) bind
`127.0.0.1` and are reached through the local `frpc` tunnels.
Telegram groups use `groupPolicy: allowlist` with the owner's ID only.

### Persistent git credentials for OpenClaw

`~/.git-credentials` inside the container is lost when the container is
recreated. That is why OpenClaw could not push `0360e61`. The Nesbitt-bot
credentials now live in `/home/node/.openclaw/credentials/git-credentials`
(`0600`) on the persistent state mount. They are wired in through
`GIT_CONFIG_GLOBAL=/home/node/.openclaw/credentials/gitconfig`. The workspace
`TOOLS.md`/`AGENTS.md` (injected into the system prompt) tell the agent where
they are and how to test them before asking for a token.

## Admin usage and quota metrics

The **Usage** group (Summary, CPA quota, Token metrics) is shown to
administrators only. Usage collection works while no public stream is running. Enter the CPA
remote dashboard management key in its panel after deployment, then select
**Refresh quota**. Enter route/model rates under **OpenClaw usage → Model
prices** when OpenClaw does not have known rates. The price view labels unknown
costs instead of presenting them as free.

Jenkins prepares two persistent resources beside `secrets/deploy.env`:

- `secrets/metrics-encryption.key`: 32 random bytes, UID/GID 1000, mode 0400.
  The existing key is preserved on every deployment. It is mounted read-only
  at `/run/secrets/metrics-encryption.key` in the dashboard only.
- `metrics/`: UID/GID 1000, mode 0700. This host-backed directory contains
  `metrics.sqlite` (including WAL files while running) and the encrypted CPA
  credential. It mounts at `/app/metrics` and survives container/volume removal.

The associated variables are `METRICS_ENCRYPTION_KEY_FILE` and
`METRICS_DATA_DIR`. For Compose, prepare the resources first and set
`METRICS_KEY_HOST_FILE` and `METRICS_DATA_HOST_DIR` if their default host paths
are unsuitable. For local development, use a private 32-byte file generated
with `openssl rand -out <private-key-file> 32`, set mode 0400, and point
`METRICS_ENCRYPTION_KEY_FILE` to it. Never commit or print its contents.

Deployment stops dashboard writes and archives the metrics directory alongside
recording backups. Back up the master key separately in your private secret
backup: ciphertext cannot be restored without the original key. Do not replace
an existing key to fix a decryption error. Restoring a metrics snapshot requires
its SQLite files and encrypted credential, plus the matching separate key.
OpenClaw retains read-only access to its existing config, and the dashboard
retains read-only access to shared activity/usage logs.

The [metrics design and reference notes](../development/dashboard-metrics.md)
identify the CC Switch visualization/storage sources and explain accounting
limits and tests.

## Stream scenes and widgets (0.2.0)

The Live player draws a scene over the log: widgets (`text`, `metric`,
`avatar`, `cat`, `clock`, `image`) on a 16:9 stage. Everything is rendered in
the browser from recorded `widget` events plus existing OpenClaw activity; the
server only validates, stores, and relays. Design and event format:
`ai-platform-design/stream-scenes.md` section 10.

### Storage

`/app/data/scene/` in the state directory: `scene-layout.json` (saved
default layout, versioned, `schema: 2` since 0.2.6) and `scene-settings.json`
(image allowlist, disabled embeds, widget defaults, built-in layout contents,
metric refresh). Both are written atomically with mode 0600 and are covered by
the pre-deploy backup of `/app/data`. Deleting `scene-layout.json` restores the
built-in layout (avatar, cat, and the circtime backdrop when served).

**Layout migration (0.2.6).** On the first start, a saved layout without
`schema: 2` is migrated once: only the built-in circtime backdrop (id
`backdrop`, `/embed/circtime/`, whole stage) moves to the log component; every
other embed gets `attach: "stage"` and stays exactly where it was. The file's
`version` goes up by one, the original is kept as `scene-layout.v1.json`, and
the dashboard log says which widgets moved. Images older than 0.2.6 reject the
new `attach`/`theme` props and drop embed widgets from a migrated layout; to
roll back, restore `scene-layout.v1.json` as `scene-layout.json`. Embeds
recorded in older recordings have no `attach` and replay on the stage exactly
as before.

### Editing

Admins use **Edit scene** under the player. With no live stream, edits change
only the saved layout; it is replayed as the opening scene of every new stream.
While a stream is live, edits are recorded in the recording (so replay, seek,
and speed show them) and also saved to the layout. The layout opens a stream
only when it starts: a stream that was already live during an upgrade (or
resumed after a restart) keeps running without an injected opening scene.
**Settings → Canvas settings** is the settings view of the same layout and the
scene configuration (below). Edit scene's widget menu also has **Hide on stream / Show on stream**.

### Canvas settings (0.2.6)

Administrators only: the section is rendered only for admins, and every route
it calls requires the admin session plus the same-origin
`X-Dashboard-Request: 1` header (members get 403, guests 401).

- **Draft.** The section edits a local draft of the saved layout; nothing is
  stored until **Save layout** or sent to viewers until **Apply to live
  stream**. **Discard changes**, **Use built-in layout**, and (while live)
  **Load live scene** reset the draft.
- **Widget list.** Grouped by layer: *On the stage*, *Log component backdrop*,
  *Stage backdrop*, top layer first. Each row shows type, ID and a summary,
  position and size (percent of the stage, or of the log box for log embeds),
  layer (`z`), and a visibility switch; buttons move it up/down a layer,
  duplicate, or delete it. Choosing a row opens its properties: position,
  size, layer, visible, and the type's props as a form generated from the
  widget schema and checked with the shared validator (`public/scene/schema.js`)
  as you type. An invalid widget is marked and blocks Save and Apply.
- **Preview.** The draft drawn by the viewer renderer, scaled, with sample
  metric values; a switch shows the live scene instead while a stream is live.
  Hidden widgets are not drawn (viewers never see them).
- **Save layout** → `PUT /api/scene/layout` with `baseVersion` (409 if the
  layout changed elsewhere). It never touches the live recording.
- **Apply to live stream** (only while live) lists the difference between the
  draft and the live scene and asks for confirmation (Cancel has focus). It
  then sends the operations one by one to the widget routes with
  `?scope=live` (paced under the 5/s admin limit, retrying a 429), so each is a
  recorded `widget` event exactly like an on-stage edit. With `scope=live` the
  saved layout is not changed; Save layout is separate.
- **Scene configuration** → `PUT /api/scene/settings` (partial saves merge):
  image allowlist; which served embed pages are enabled (disabling one that a
  widget uses asks first; such widgets drop out of the layout, and re-enabling
  before the next save brings them back); embed defaults (attachment, opacity,
  theme); metric defaults (source, colour) and refresh (every 2, 5, 10, 15,
  30, or 60 minutes while a metric widget is live; CPA upstream refresh on or
  off); avatar and cat mirroring; which widgets the built-in layout includes.
  Defaults apply to widgets created without those props, by any editor.

### Embed widget (circtime)

The `embed` widget shows a dashboard-served page behind the log text: a
sandboxed iframe (`sandbox="allow-scripts"`, `referrerpolicy="no-referrer"`,
opaque origin) with `pointer-events: none`, so log text above it stays
selectable and copyable. Its page must be on the server-side allowlist; today
only `/embed/circtime/`, the circtime uptime radar.

- **Attachment (0.2.6).** Prop `attach`: `log` (default) makes the embed the
  **log component's backdrop**: it lives in a layer that tracks the log
  panel's box and sits directly before the log element at the same z-index,
  so it is sized to the log region and moves with it in normal, theater, web
  full screen, full display, and mobile layouts. Its `x/y/w/h` are fractions
  of that box (default the whole box). `stage` puts it on the 16:9 stage's
  back layer as in 0.2.2–0.2.3. Settable in Canvas settings and in Edit
  scene's properties form. In Edit scene a log embed stays in the log box: a
  click on empty stage opens its menu, Tab reaches it, arrow keys move it
  within the log box.
- **Theme (0.2.6).** Prop `theme`: `system` (default) follows the dashboard
  theme helper (`public/theme.js`), passing the resolved theme in the URL and
  later changes by message; `dark`/`light` fix it in the URL.
- **Defaults.** Opacity 0.3, `attach: log`, `theme: system`, part of the
  built-in layout (id `backdrop`) when the page is served.

- **Mount.** Host directory `/home/motuariki/Documents/DockerVolumes/circtime/dist`
  (override with `CIRCTIME_EMBED_HOST_DIR`), mounted read-only at
  `/embed-src/circtime` with `CIRCTIME_EMBED_DIR` pointing there, by both
  `scripts/deploy.py` and `compose.yaml`. If the directory has no
  `index.html`, the deploy skips the mount (warning, not a failure) and the
  route stays off (404); an empty Compose mount point behaves the same.
- **Entry.** `/embed/circtime/?embed=1&theme=<light|dark>&parent_origin=<dashboard origin>`
  (resolved theme, because the dark radar is faint on light). Theme changes
  are posted as `{ type: "circtime-theme", theme }` with target `"*"` (the
  frame's origin is `null`; only the theme name is sent); circtime accepts them
  only from its parent at `parent_origin`.
- **CORS instead of `allow-same-origin`.** The opaque-origin frame loads its
  module script, stylesheet, and JSON as cross-origin requests, so this path
  alone answers `Access-Control-Allow-Origin: *` (no credentials headers) for
  GET/HEAD; other methods get 405. The content is a public, sanitized status
  page and needs no cookies. This keeps the embed unable to read dashboard
  cookies, storage, or APIs, which `allow-same-origin` would not.
- **Caching and compression.** JSON and HTML: `Cache-Control: no-cache` with
  weak ETags (304 on match). Vite-hashed `assets/*-<hash>.*`:
  `public, max-age=31536000, immutable`. JSON, JS, CSS, HTML, and SVG are
  brotli- or gzip-compressed in-process (`server/scene/embed-static.js`,
  `node:zlib`, no new dependency) and cached by size and mtime.
- **Headers.** `Content-Security-Policy: default-src 'self'; script-src
  'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; ...;
  frame-ancestors 'self'`, `X-Content-Type-Options: nosniff`. Dotfiles,
  traversal, and non-file paths are 404; the entry URL without its trailing
  slash redirects to it.
- **Known limits.** circtime has no frame-rate option; it animates at the
  browser's full rate while visible (browsers throttle hidden tabs). Its DNS
  analyzer worker runs only from a button, which cannot be clicked through
  `pointer-events: none`, and the CSP blocks its external lookups anyway.

### Admin API

Admin session required (401 signed out, 403 without `admin-agent`).
Mutations also need the same-origin `X-Dashboard-Request: 1` header, or the
`DASHBOARD_TOKEN` bearer with the admin session (a wrong bearer is 401).

| Route | Effect |
|---|---|
| `GET /api/scene/layout` | `{ layout: { version, updatedAt, builtin, widgets }, live: { recordingId, widgets } \| null, settings }` |
| `PUT /api/scene/layout` | `{ widgets, baseVersion }` replaces the saved layout only (409 if `baseVersion` is stale) |
| `POST /api/scene/widgets` | `{ widget }` → 201 `{ widget, recorded, layoutVersion }` |
| `PATCH /api/scene/widgets/:id` | `{ changes }` (geometry, `z`, `hidden`, individual `props`; never `id`/`type`) |
| `DELETE /api/scene/widgets/:id` | removes from the live scene and/or saved layout |
| `…/widgets[/:id]?scope=live` | the three routes above, live scene only (409 if offline); the saved layout is untouched |
| `GET/PUT /api/scene/settings` | `{ imageAllowlist, disabledEmbeds, defaults: { metric, avatar, cat, embed }, builtin: { avatar, cat, embed }, metricRefresh: { minutes, cpa } }`; PUT merges, unknown fields are 400. The response adds `embeds` (enabled) and `servedEmbeds` |

A widget may carry `hidden: true` (omitted when visible): it stays in the
scene and the recording but is not drawn for viewers.

### OpenClaw scene API

Used by the `dashboard_stream` tool since 0.2.5. Each request needs the
stream-controller bearer (`OPENCLAW_STREAM_TOKEN`, timing-safe compare; 401
otherwise) and `recordingId` + `sessionRef` (64 hex) + `agentId`; who may act
on which live recording is decided by `server/stream-control.js` (see
[OpenClaw live control](#openclaw-live-control-title-description-chat-moderation-widgets-0-2-5)).
Without `agentId` the original rule applies: only the live recording the
session started. Malformed IDs get 400, no right 403, not the caller's live
recording 409. OpenClaw changes only the live recording, never the saved
layout. Limit: 2 changes/s (burst 10), plus the shared 10 scene events/s cap;
over the limit returns 429.

| Route | Body / query | Result |
|---|---|---|
| `GET /api/openclaw/scene/layout` | `?recordingId=&sessionRef=` | `{ recordingId, widgets }` |
| `POST /api/openclaw/scene/widgets` | `{ recordingId, sessionRef, widget: { type, x, y, w, h, z?, id?, props? } }` | 201 `{ widget, recorded: true }` |
| `PATCH /api/openclaw/scene/widgets/:id` | `{ recordingId, sessionRef, changes }` | `{ widget, recorded }` |
| `DELETE /api/openclaw/scene/widgets/:id` | `{ recordingId, sessionRef }` | `{ id, recorded }` |
| `POST /api/openclaw/scene/avatar` | `{ recordingId, sessionRef, expression, seconds? }` | `{ avatar, recorded: true }` |

`changes` may set `hidden: true/false` (hide/unhide: the widget stays in the
scene and is not drawn for viewers; the editor shows it dimmed with a dashed
outline and a **Hide on stream / Show on stream** menu item). `expression` is
`idle`, `blink`, `talk`, `think`, `sleepy` (forced for `seconds`, 1–120,
default 10) or `auto` (back to activity-derived expressions); it is a
`widget` event with op `avatar`, so replay shows it.

Errors use the dashboard message shape, for example `Widget not created:
dashboard/scene widgets — widget type 'iframe' is not supported.`

### Content-Security-Policy

Every response carries `default-src 'self'; script-src 'self'; style-src
'self'; img-src 'self' data: <allowlisted image origins>; media-src 'self';
connect-src 'self'; font-src 'self'; frame-src 'self'; object-src 'none';
base-uri 'none'; form-action 'self'; frame-ancestors 'none'` with `frame-src
'self'` (0.2.2: only dashboard-served embeds may be framed). If the reverse
proxy adds its own CSP, browsers enforce both, so keep the proxy's at least as
permissive for images. `/scene/assets/` files have content-hashed names and
are served with `Cache-Control: public, max-age=31536000, immutable`; only the
hashed names exist.

### Verification

`scripts/scene-browser-check.mjs` (run with the other browser checks) draws
widgets, exercises the left-click menu, drag, resize, keyboard, and undo,
records live edits, replays them at seek times and 2x, drives avatar and cat
states from recorded OpenClaw activity, checks guest read-only rendering, the
log-component backdrop in every screen mode, and fails on any CSP violation.
`scripts/canvas-browser-check.mjs` covers Canvas settings: admin-only access,
the widget list and keyboard use, preview, attachment, configuration, Save vs.
Apply (confirmation, recorded events, saved layout untouched), both themes and
390 px with a contrast and overflow audit. After deployment, confirm the `Content-Security-Policy`
header with `curl -sI https://live.trance-0.com/ | grep -i content-security`.


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
