# Project documentation

This repository contains the canonical agent rules and the personal OpenCode
plugins. See [the root README](../README.md) for installation and the plugin list.

The plugins are TypeScript modules loaded by OpenCode; the plugin manager serves
their settings dashboard locally. Session Manager reads the OpenCode SQLite
database and external agent stores. Portable archives retain session records
and revisions for merging into another device's database.
Directory synchronization uses per-project, per-session JSON revisions instead
of archives, with Manual, Local only, Directory and Auto modes.

See [session archive transfer](development/session-archives.md) for the device
transfer workflow, format scope, and isolated verification commands.

## Agent dashboard

`dashboard/` is a Node.js 22 / Express service with a static browser UI, a
public server-sent event stream, and timestamped recording playback. npm manages
its dependencies. Casdoor provides OIDC identities: `app-agent` grants signed-in
chat and panel access; `admin-agent` permits stream start/end and recording
moderation. Panel mutations additionally
require the dashboard bearer token. Guests see the player, chat history, and
selectable recommendations; manager panels remain private.
OpenClaw, AstrBot, and Jenkins are monitored through local HTTP endpoints.
The OpenClaw `dashboard-stream` plugin gives the owner-facing main agent a
scoped stream-control tool. Agent/model/tool lifecycle events are saved in the
recording. Assistant text is public only for the session that starts a stream;
private prompts, tool arguments, and tool results are excluded.

### Jenkins, Docker, and FRP deployment

The Docker Compose service binds to host loopback on port 14143. The existing
host-network frpc container forwards it to remote TCP port 6018; the remote
HTTPS reverse proxy serves `https://live.trance-0.com`. Panel toggles persist in
a named volume. The same volume holds durable recording metadata and NDJSON
events containing public stream logs and viewer chat. Visible recordings sort
by the administrator's recommendation score and date. The isolated OpenClaw
`dashboard-host` agent answers authenticated chat through player log events,
with tools denied and private workspace access disabled. Live sessions resume
across deployments with the same ID. Watching counts deduplicate tabs using a
signed browser-session cookie. OpenClaw can set the live summary. Sessions expire after
12 hours and are cleared on restart.
Docker retains structured, timestamped application logs with rotation.

After configuring the Casdoor application and the gitignored `dashboard/.env`,
run these commands from the repository root:

```sh
npm ci --prefix dashboard
npm test --prefix dashboard
docker compose -f dashboard/compose.yaml config --quiet
docker compose -f dashboard/compose.yaml up -d --build
curl --fail --max-time 10 https://live.trance-0.com/healthz
```

The [dashboard deployment runbook](deployment/dashboard.md) covers the OIDC
callback, group membership, tunnel, logs, and rollback.

The [dashboard development log](development/dashboard-log.md) records root
causes, implementation decisions, and verification evidence for UI rounds.

The `agent-dashboard` Jenkins job pulls `ai-infra-v0` from GitHub on push and
builds/tests/deploys that revision. Runtime env is private on `local-docker`;
SCM never reads local source. The deployment retains recording data and rollback
containers. See the [Jenkins runbook](deployment/dashboard.md#jenkins-webhook-deployment-013).
