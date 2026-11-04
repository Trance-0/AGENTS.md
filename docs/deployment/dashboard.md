# Agent dashboard: local Docker and remote HTTPS

The browser connects to `https://live.trance-0.com`. Its remote reverse proxy
terminates TLS and routes HTTP to FRP remote TCP port 6018. The existing local
`frpc` container uses host networking and forwards requests to
`127.0.0.1:14143`. Docker Compose runs `agent-dashboard-v0.1.1` using image
`agent-dashboard:0.1.1`, with Node.js 22 as the unprivileged `node` user.

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
docker logs --timestamps --tail 100 agent-dashboard-v0.1.1
docker inspect agent-dashboard-v0.1.1 --format '{{.State.Health.Status}}'
```

Docker retains three rotated JSON log files of up to 10 MB each. Application
records contain timestamp, level, and diagnostic message; sign-in events omit
personal identity data. Bearer tokens, OIDC secrets, and session cookies must
never be included in logs.

## Rollback

Before a future update, retain the current image under a distinct local tag.
To roll back, restore the previous source revision or retag the retained image
as `agent-dashboard:0.1.1`, then run
`docker compose -f dashboard/compose.yaml up -d --no-build`. Keep the private
environment file and state volume. To remove just the dashboard exposure,
restore the saved FRP configuration, validate it, and restart `frpc`; other
services and the existing development dashboard do not need changing.

`dashboard/Jenkinsfile` is the earlier CI scaffold. It was not configured or
run for this deployment; its deployment settings still require alignment with
this Compose setup before it can replace the local workflow.


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
disk before events are broadcast. After a restart, an unfinished stream is
closed with `status: interrupted`, retaining all complete event records.

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
