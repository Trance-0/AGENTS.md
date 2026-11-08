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

## OpenClaw coding harness

`opencode/openclaw-plugin/` implements an ACP backend that sends coding work to
the persistent OpenCode HTTP server. All six repository plugins run there;
the local desktop and terminal UI connect to the same session store. The
server runs as a user systemd service with private state under DockerVolumes.
It uses the existing OpenAI credential through Responses with high reasoning.
See the [deployment and usage guide](deployment/opencode-harness.md) for setup,
session resume, model controls, persistent logs, and rollback.

## Agent dashboard

`dashboard/` is a Node.js 22 / Express service with a static browser UI, a
public server-sent event stream, and timestamped recording playback. npm manages
its dependencies. Casdoor provides OIDC identities: `app-agent` grants signed-in
chat and panel access; `admin-agent` permits stream start/end and recording
moderation. Panel mutations additionally require the same-origin request
header (or the dashboard bearer token). Guests see the player, chat history,
and selectable recommendations; manager panels remain private. Members see
grouped, tabbed pages (OpenClaw, Usage, Adapters, Builds, Settings) laid out
from registry metadata.

The player draws a scene of widgets (text, pooled metrics, the witch avatar, a
desk cat, clock, allowlisted images) entirely in the browser by folding
recorded `widget` events and OpenClaw activity
(`dashboard/public/scene/`). Admins edit the saved default layout, which opens
every stream, with an on-stage editor; live edits are recorded for replay.
OpenClaw has a token-protected scene API for its own live streams. Every
response carries a strict Content-Security-Policy. See
`ai-platform-design/stream-scenes.md` section 10.

OpenClaw, AstrBot, and Jenkins are monitored through local HTTP endpoints.
The OpenClaw `dashboard-stream` plugin gives the owner-facing main agent a
scoped stream-control tool. Agent/model/tool lifecycle events are saved in the
recording. Assistant text is public only for the session that starts a stream;
private prompts and tool results are excluded. File tools publish only their
target path, lifecycle stage, and duration; credential filenames are masked.
OpenClaw writes daily JSONL activity files to a host-backed shared directory.
The dashboard mounts that directory read-only and tails it into the live
recording; cursors persist separately in dashboard storage. A first attachment
starts at the current end of the logs. Later restarts resume the saved cursor.

The administrator-only Usage group provides a pooled summary, per-account CPA
quota, and OpenClaw token metrics.
The usage exporter records tokens by route/model in separate shared files; a
SQLite database stores replay-safe events, pricing, and aggregation cursors.
The CPA management key is encrypted with a separately mounted master key.
See [metrics architecture and CC Switch references](development/dashboard-metrics.md).

### Jenkins, Docker, and FRP deployment

The Docker Compose service binds to host loopback on port 14143. The existing
host-network frpc container forwards it to a private FRP remote TCP port; the remote
HTTPS reverse proxy serves `https://live.trance-0.com`. Panel toggles persist in
a host bind directory (a named volume before dashboard 0.2.6). The same directory holds durable recording metadata and NDJSON
events containing public stream logs and viewer chat. Visible recordings sort
by the administrator's recommendation score and date. The isolated OpenClaw
`dashboard-host` agent answers authenticated chat through player log events,
with tools denied and private workspace access disabled. Live sessions resume
across deployments with the same ID. Watching counts deduplicate tabs using a
signed browser-session cookie. OpenClaw can set the live summary. Sessions expire after
12 hours and are cleared on restart.
Docker retains structured, timestamped application logs with rotation.

After preparing the metrics key/storage in the deployment runbook and
configuring the Casdoor application and the gitignored `dashboard/.env`,
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

The OpenClaw primary/fallback order is `cpa/claude-opus-5-5-high`,
`cpa/gpt-6-astra`, then `openai/gpt-6-astra`, configured both globally and for
`dashboard-host`. CPA Gemini definitions and aliases are removed. Recorded
model events include provider and run ID; gateway error completions are treated
as failures even when HTTP status is 200.

The [dashboard development log](development/dashboard-log.md) records root
causes, implementation decisions, and verification evidence for UI rounds.

The `agent-dashboard` Jenkins job pulls `ai-infra-v0` from GitHub on push and
builds/tests/deploys that revision. Runtime env is private on `local-docker`;
SCM never reads local source. The deployment retains recording data and rollback
containers. See the [Jenkins runbook](deployment/dashboard.md#jenkins-webhook-deployment-013).

Announcement activity retains gateway run IDs and safe reply-generation status.
The stream reports a parent reply pending after 90 seconds without a completed
model event. Private conversation text is not inferred from lifecycle markers.
See the development log for the local parent-announcement delivery repair.

OpenClaw settings use grouped form controls with an optional JSON tab. The
[scheduled-task editor](development/openclaw-settings.md) manages prompts, models, schedules, time zones,
and delivery for enabled and paused jobs through the authenticated gateway.

### AstrBot adapter access

Administrator channel-access settings are available at `/adapters`. The list
editor controls owner DM execution and selected groups/senders through a private
policy directory shared read-only with PCP. Group access starts empty; each group
requires its own sandboxed execution agent. PCP checks each tool call against
the current policy and live grant.

### Context sync and recovery integration

The session manager now registers PCP projects/workspaces, writes versioned
task context and merges redacted messages by stable identity. Legacy messages
are mapped without changing their IDs or contents. The plugin is split into
focused registration, tool and synchronization modules.

The OpenClaw release helper deploys immutable images, verifies runtime identity
and channel health, and promotes known-good releases after a soak. Its systemd
watchdog recovers independently of Jenkins; the dashboard reads a restricted
status record. Staging rollback, recovery and kill-switch checks passed.
