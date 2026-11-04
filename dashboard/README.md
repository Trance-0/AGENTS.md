# Agent Dashboard

A self-hosted dashboard for the AI platform. Hot-pluggable manager panels behind
Casdoor OIDC (`auth.trance-0.com`), with a YouTube-style **live stream window**
that streams logs, drives a progress bar off uptime, and lets you drag/draw on
the timeline to inspect events at any timepoint.

## Layout

- **Stream** — the live window. The "video" is the log feed; the red progress
  bar is the dashboard uptime; every log event is a tick on the timeline. Drag
  the bar to scrub, or click-drag to draw a range and see the events inside it.
- **Plugins** — every panel appears in the side menu. Panels self-describe, so
  adding one never changes the dashboard core.
- **Recommended / Settings** — placeholders for now.

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
Casdoor OAuth app, with the group renamed:

```
gitea:  group-claim groups, required value trance-0/app-gitea
agent:  group-claim groups, required value trance-0/app-agent
```

In Casdoor, create an application for the dashboard (copy the Gitea app) and set
its **Groups** requirement to `trance-0/app-agent`, then configure the redirect
URI `https://live.trance-0.com/auth/callback`. Create `trance-0/admin-agent`
as well; administrators need both groups, and mutations also require the
dashboard bearer token. Verify memberships on the user record. The generated
client ID and secret go in the gitignored `.env`.

## Configuration

Copy `.env.example` to `.env` (gitignored) and fill in real values:

| Key | Meaning |
|---|---|
| `OPENCLAW_ENDPOINT` / `OPENCLAW_TOKEN` | Gateway address + bearer token. |
| `ASTRBOT_ENDPOINT` / `ASTRBOT_USERNAME` / `ASTRBOT_PASSWORD` | AstrBot API + dashboard login. |
| `OIDC_*` | Casdoor issuer, client id/secret, redirect URI, required group. |
| `JENKINS_ENDPOINT` / `JENKINS_USER` / `JENKINS_TOKEN` | Read-only build status. |
| `DASHBOARD_TOKEN` | Required by every mutating endpoint, along with an admin session. |
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
remote TCP port 6018. Panel toggles persist in a named volume. Sessions expire
after 12 hours and reset on restart. Settings fields currently display values;
they do not save upstream configuration. See the
[deployment runbook](../docs/deployment/dashboard.md) for OIDC groups, tunnel
setup, logs, and rollback.

## CI/CD

`dashboard/Jenkinsfile` is an earlier scaffold that builds the image, smoke-tests it, deploys it on the
docker build node, and rolls back on failure. Credential IDs used:

- `dashboard-oidc-client-secret`, `dashboard-session-secret`, `dashboard-token`
- `openclaw-gateway-token`, `astrbot-password`

Once configured, the SCM webhook can trigger this pipeline to deploy UI and
feature changes through CI.

This scaffold was not used for the public test deployment and must be aligned
with the Compose configuration before enabling it.
