# Design: personal AI platform with shared context and self-evolving infra

As of 2026-11-03. Claims about third-party tools link to sources in `agent-comparison.md`. Anything not confirmed from a source is marked (unverified).

## Problem statement

One personal AI platform runs on the owner's own machine. These channels share context through PCP (Personal Context Protocol, the owner's project at https://pcp.trance-0.com/):

- QQ and WeChat, through AstrBot
- Telegram and WeChat, through OpenClaw
- Claude Code, over SSH and inside the OpenClaw container

The v0 stack is AstrBot, OpenClaw, PCP and Claude Code. Codex is left out of v0. Its notes are kept below for a later version.

An autonomous agent may rewrite its own stack. Version history and the last good build must survive anything the agent does.

## Requirements

- Local device, personal use only.
- PCP is the context hub. Agents only append. The human dashboard owns organizing and cleaning up context.
- OpenClaw is the only executor and owns the model backend config. AstrBot only adapts QQ and WeChat messages and does not use its built-in agent.
- Jenkins is the only CI/CD system. Git pushes trigger builds and deploys through a webhook.
- The agent is fully autonomous. It can read Jenkins logs and change its own pipeline config. It can't delete history, and it can't change git, the Jenkins controller, the last-known-good (LKG) image or rollback.
- The agent works in mounted container volumes and pushes its changes to git.
- Claude Code runs inside the OpenClaw container, because the agent workspaces live in Claude Code. Its credential comes from a host Claude config mounted read-only.
- A dashboard hosts hot-pluggable manager panels. It is a separate service, not built on dsh.

## Zones

The design rests on one rule: the part that rolls back must not be changeable by the part being rolled back.

| Zone | Contents | Agent access |
|---|---|---|
| Platform (root of trust) | Forgejo, Jenkins controller and credentials, `platform-deploy` build node, image registry and its retention policy, watchdog (systemd), PCP and its database, deploy-time secrets, a separate notifier bot on Telegram, off-device backup, the dedicated host Claude config directory | Read-only Jenkins logs and its own build status. Read-only mount of the Claude credential |
| Agent | OpenClaw (with Claude Code inside), AstrBot, the dashboard and its panels, the coding CLIs' PCP hooks, workspace volumes, the `agent-stack` repo (code, Dockerfiles, OpenClaw config that reads keys from env vars, Jenkinsfiles, tests) | Read-write, push to git |
| Edge (untrusted input) | QQ, WeChat and Telegram messages, web pages, tool output, build logs | Treated as data only |

On one machine, the zones are enforced by:

- **Unix users:** `platform` owns the platform zone, `agent` runs the agent zone.
- **Rootless Podman** for every agent container.
- **Localhost-only binds** for every service.
- **Server-side checks** in Forgejo and Jenkins. Client-side hooks don't count, because the agent controls its own clients.

## Rules the agent can't break

1. **History is append-only.** Forgejo enforces it server-side: no force push, no branch or tag deletion, and protected `lkg-*` tags. The agent signs its commits with its own key, so its commits are distinguishable from the owner's.
2. **An LKG image always exists.** Images are referenced by immutable digest. Only the platform deploy job moves `lkg`, and only after a soak period. The registry keeps the last 5 LKG images.
3. **Rollback is outside the agent's write scope.** The watchdog doesn't depend on Jenkins or on the agent stack.
4. **The health gate is defined in `platform-infra`.** The agent can add tests but can't remove these three checks:
   - A canary chat message gets a reply.
   - A PCP write and read succeed.
   - The agent can push to the `scratch` branch. This proves the agent can still repair itself.
5. **No credential can mint new credentials.** The agent's Forgejo token can't create tokens or deploy keys. Its Jenkins user can't create credentials. Its registry account can't create accounts.
6. **Secrets never enter git.** Append-only history makes any committed key permanent. The OpenClaw config is agent-writable, so model keys are injected as env vars at deploy time from Jenkins credentials. OpenClaw configs can reference secrets by env name (SecretRef with `source: "env"`). Forgejo also runs a gitleaks pre-receive hook.

## Jenkins split

Two requirements pull against each other: "the agent may change Jenkins config" and "Jenkins is independent of the agent". The config is split into two repos to satisfy both.

| Item | Lives in | Who can change it |
|---|---|---|
| Jenkinsfiles and job definitions for the agent's own folder | `agent-stack` | Agent |
| Controller config (Configuration as Code), credentials, plugin list | `platform-infra` | Owner only |
| Deploy job, health gate script, LKG promotion, rollback job | `platform-infra` | Owner only |

Supporting settings:

- **Permissions:** the agent's Jenkins user has no Overall/Administer and no Script Console access. Script Console runs arbitrary Groovy on the controller.
- **Executors:** the controller has 0 executors.
- **Build nodes:** agent builds run on `agent-build` and deploys run on `platform-deploy`. Job restrictions keep agent jobs off `platform-deploy`.
- **Webhook:** the Forgejo-to-Jenkins webhook uses an HMAC secret.

## Deploy flow

1. The agent commits in its workspace volume and pushes to `agent-stack`.
2. Forgejo sends a signed webhook to Jenkins.
3. The agent's Jenkinsfile builds and tests on `agent-build`, then pushes the image to the registry by digest.
4. For builds of `main`, the platform deploy job (from `platform-infra`) deploys the digest on `platform-deploy`. It injects secrets as env vars from Jenkins credentials and snapshots agent-stack state first.
5. The platform health gate runs its three checks plus any tests the agent added.
6. The soak period starts (for example 10 minutes of passing health polls).
7. The deploy job moves `lkg` to the new digest, adds an immutable `lkg-<build>` tag in the registry and in git, and prunes LKG images beyond the last 5.

If the gate or soak fails, the deploy job redeploys the current `lkg`.

The watchdog is a systemd service running as `platform`. It polls health independently. After N consecutive failures it pulls and runs the `lkg` digest directly with Podman, so it works with Jenkins down. It alerts through the platform notifier bot, which is separate from the agent's Telegram bot.

The owner has a manual kill switch: one command that stops all agent containers and pauses the watchdog.

## Data rollback

Rolling code back doesn't roll data back. An old image may not start against a schema a newer image migrated.

- PCP stays in the platform zone, and the agent can't evolve it.
- The agent stack may make only additive schema changes (new tables or columns, never drops or renames).
- The deploy job snapshots agent-stack state volumes before each deploy. Rollback restores the matching snapshot only when the owner asks, because restoring loses data written since the snapshot.
- The agent workspace volume is a cache. Recovery means re-cloning `agent-stack`.

## Context sync with PCP

### Identity and structure

- One owner principal is linked to the owner's QQ, WeChat and Telegram IDs and SSH key.
- Each channel conversation is a PCP session. Topics group sessions across channels, so one project can hold both a Telegram thread and an SSH coding session.
- Cross-channel handoff serves a summary plus the last N events, never raw transcripts.

### Per channel

| Source | How it reaches PCP | Notes |
|---|---|---|
| Telegram, WeChat (OpenClaw) | OpenClaw writes each turn to the PCP session for that conversation. It does this through a PCP tool or hook, whichever needs the least code. | OpenClaw's `session.dmScope` setting controls how DMs map to sessions. |
| QQ, WeChat (AstrBot) | AstrBot forwards each message to OpenClaw, so OpenClaw records it the same way. AstrBot itself doesn't write to PCP. | Bridge details are below. |
| Claude Code | A SessionStart hook injects the topic summary through `additionalContext`, which is capped at 10,000 characters. A Stop hook appends the turn through PCP's redaction path. | Install the hooks as managed settings owned by `platform`, so the agent can't edit them (path unverified). |
| Codex (not in v0) | The same SessionStart and Stop hooks, configured in `hooks.json` or `config.toml`. | Codex skips new or changed hooks until they are reviewed and trusted by hash. Managed hooks from system or `requirements.toml` sources are trusted by policy. Use managed hooks. |
| Reads, all coding CLIs | A PCP MCP server exposes `memory.search` and session reads. | Claude Code and Codex both support MCP clients. |

### AstrBot to OpenClaw bridge

OpenClaw's Gateway can serve an OpenAI-compatible `/v1/chat/completions` endpoint. The endpoint is disabled by default. AstrBot supports "OpenAI and compatible services" as a provider, so this bridge needs configuration only, no code.

Constraints from the OpenClaw docs:

- **Owner-level token:** a bearer token for this endpoint equals an owner/operator credential. It restores the full operator scope set, and chat turns are treated as owner turns.
- **Stateless by default:** the endpoint opens a new session per request. A stable `user` value keeps one agent session per conversation.
- **Routing:** `model: "openclaw/<agentId>"` selects the agent, and the `x-openclaw-message-channel` header sets the channel context.

Design choice:

- AstrBot targets a dedicated agent, `openclaw/relay`, whose tool policy allows PCP reads and appends but no shell, file or deploy tools.
- AstrBot sets `user` to `astrbot:<platform>:<conversation>`.
- AstrBot bridge sessions never trigger tool use.

The trade-off is that the owner can't run tools from QQ. To allow it later, put OpenClaw in trusted-proxy auth mode with a small proxy that narrows `x-openclaw-scopes` per sender. It's unverified whether AstrBot passes sender IDs in a form the proxy can use.

Keep the endpoint on loopback only.

### PCP features to add if missing

- A source label on every message: channel, principal, and trusted or untrusted.
- Read scopes separate from append scopes.
- Idempotency keys. Chat channels retry, and OpenClaw's QQ inbound path is at-least-once.
- A redaction pass before append.
- Content labeled untrusted is wrapped as data when served back to agents.
- Derived summaries go through dashboard review before other channels can retrieve them.

The PCP agent schema path `/api/v1/agent/schema/` returned 404 on 2026-11-03, so the check scripts use placeholder PCP endpoints.

## Claude Code in the OpenClaw container

The agent workspaces live in Claude Code, so Claude Code runs inside the OpenClaw container. OpenClaw drives it either through ACP or as a CLI backend (see `agent-comparison.md`).

### Credential: read-only bind of a host Claude config

Facts from the Claude Code docs:

- On Linux, Claude Code stores its login in `.credentials.json` (mode 0600) inside the config directory. The default directory is `~/.claude`, and `CLAUDE_CONFIG_DIR` overrides it.
- The config directory also holds settings and session history.
- A `/login` sign-in refreshes itself automatically. When a refresh fails, requests fail with "Login expired" until someone signs in again.

Layout:

| Path | Where | Mode | Contents |
|---|---|---|---|
| `/srv/platform/claude-agent/` | Host, owned by `platform` | Read-only to the container | A dedicated config directory signed in once with `CLAUDE_CONFIG_DIR=/srv/platform/claude-agent claude auth login`. It holds the credential only. |
| `/claude-cred/` | Container | Bind of the host directory above, `:ro` | Source of `.credentials.json` |
| `/claude/` | Container, named volume `claude-state` | Writable | `CLAUDE_CONFIG_DIR`. Session history and project state. `/claude/.credentials.json` is a symlink to `/claude-cred/.credentials.json`. |
| `/etc/claude-code/` | Container, bind from the host, `:ro` | Read-only | Managed settings with the PCP hooks, so the agent can't remove them. The exact Linux managed-settings path is unverified. |

Rules for the bind:

- **Don't mount the owner's personal `~/.claude`.** It holds every host session transcript and the owner's settings. Read-only stops the agent from changing those files but not from reading them.
- **Bind the directory, not the single file.** A single-file bind mount pins the file's inode. If the host replaces the file by rename when it refreshes the token, the container keeps reading the old one. The symlink in `/claude/` reads through the directory bind each time. Whether Claude Code writes the credential in place or by rename is unverified.
- **Keep the host login fresh.** The container can't write a refreshed token to a read-only mount. So the host must refresh it, for example with a daily `platform` timer that runs a trivial `claude -p` with the same `CLAUDE_CONFIG_DIR`. What Claude Code does when its own refresh write fails is unverified. `checks/09-cli.sh` tests it.
- **Fallback if the read-only refresh misbehaves:** generate a long-lived token with `claude setup-token`, store it as a Jenkins credential, and inject it at deploy time as `CLAUDE_CODE_OAUTH_TOKEN`. This matches rule 6 and needs no mount.

Read-only protects the credential from tampering, not from reading. The agent can still read and leak it. Use a subscription or account you can revoke without losing anything else, and rely on the outbound allowlist from Task 7.

### Other constraints

- **Hooks:** the PCP hooks come from the read-only managed settings. Settings in the writable `/claude/` volume are agent-writable and can't be relied on.
- **Sandbox:** whether Claude Code's bubblewrap sandbox works inside a rootless container is unverified. The container is the boundary either way.
- **Redaction:** transcripts in `claude-state` contain tool output. Everything sent to PCP passes through the redaction step.

## Dashboard

The dashboard is one service in the agent zone. It hosts hot-pluggable manager panels.

It doesn't run on dsh. dsh is a developer preview that promises breaking changes. Its local RPC has more than 60 methods behind only a Host-header check, and it blocks non-loopback binds because remote auth isn't built (third-party). The panels that manage OpenClaw config and model backends are the most sensitive UI here, so they shouldn't sit on that RPC or inside an agent harness process.

It reuses the registry contract of `plugin-manager` in this repo (`opencode/README.md`):

- Panels self-describe their settings (`boolean`, `string`, `number`, `select`), so adding a panel never changes the dashboard core.
- Disabling a panel is a soft toggle (`Registry.isEnabled`). A disabled panel gates its own routes and actions with no restart.
- Server-side resolvers (`children`, `run`) are stripped from the snapshot sent to the browser.
- The config editor refuses to save invalid JSON.
- Binding the port acts as the lock, so only one instance runs.

Panels and zones:

| Panel | Hosted in | How it changes things |
|---|---|---|
| OpenClaw config manager | Dashboard (agent zone) | Commits to a branch of `agent-stack`. The pipeline deploys the change, so history, the gate and rollback all apply. It never edits live files. |
| OpenClaw backend manager | Dashboard (agent zone) | Lists providers and the env var names they read. Key values stay in Jenkins credentials, and the dashboard never holds them. |
| Plugin, build and LKG status | Dashboard (agent zone) | Read-only. Build status uses the agent's read-only Jenkins token. |
| PCP session import and export | PCP's own dashboard (platform zone) | Needs an owner token. PCP's design gives export and cleanup to the human dashboard. |

With this split, the dashboard holds no owner credential, so the agent can build and rewrite it under full autonomy. Additional rules:

- Bind to `127.0.0.1`.
- Mutating endpoints require a token, because any local process can reach localhost.

## Threats

| # | Threat | Why it matters here | Mitigation |
|---|---|---|---|
| 1 | Prompt injection into an agent that can push to its own infra | Chat messages, web pages and Jenkins log lines all reach a model that can commit and deploy. The PCP landing page's "For AI agents" paragraph is a benign example of the same mechanism: text addressed to whatever agent reads it. | Only the owner principal can trigger tool use. AstrBot sessions go to the no-tools `relay` agent. Every infra change still passes the platform gate, and the agent can't change the gate. |
| 2 | Memory poisoning | Injected text written to PCP gets replayed into every channel and coding session. | Source labels on every message, untrusted content wrapped as data, and owner review of derived memories. |
| 3 | Group chats leaking context | Anyone in a QQ group can ask the bot to recite a coding session. | Group chats get no personal memory, or a restricted topic only. OpenClaw's WeChat plugin declares direct chats only. |
| 4 | Container escape or Docker socket | A mounted `/var/run/docker.sock` or Podman socket gives the agent root, or the `platform` user, and with it control of Jenkins and git. | Rootless Podman, never mount a container socket, deploy only through Jenkins, and an outbound allowlist. OpenClaw runs tools on the host for the main session unless sandboxing is configured, so enable `agents.defaults.sandbox`. Running its Podman sandbox backend inside a rootless container is unverified. If it doesn't work, the OpenClaw container itself is the boundary. |
| 5 | Secrets and cost | Keys committed to append-only history are permanent. A self-evolving loop can run up a large bill. | Keys only as env vars or SecretRefs, the gitleaks pre-receive hook, and a spend cap in each provider's console. No gateway sits in front of OpenClaw. A LiteLLM-style gateway with per-key budgets could be added later: it gives one budget and one audit point, at the cost of one more service in the platform zone and another hop that can fail. |
| 6 | Network exposure | Jenkins has a long history of remote-code-execution CVEs. OpenClaw's chat-completions endpoint is an owner credential. | Bind everything to `127.0.0.1`, and use Tailscale or WireGuard for remote access. Telegram long polling, QQ Bot WebSocket and the WeChat plugin all connect outbound, so no inbound ports are needed. Never expose Jenkins. |
| 7 | Single device | Unix users and containers enforce the zones, but a host compromise defeats both. | The nightly pull mirror and snapshots go to an off-device target the host can't delete, such as object-lock storage or a drive rotated offline. Only that copy survives a host compromise. |
| 8 | Unofficial QQ and WeChat clients | AstrBot reaches personal QQ through OneBot v11 bridges such as NapCat. Unofficial clients risk account bans. | Use secondary accounts. Alternatives are OpenClaw's QQ Bot plugin (official QQ Bot API) and Tencent's `openclaw-weixin` plugin, but both are plugins. |
| 9 | WeChat plugin access control | OpenClaw docs say `openclaw-weixin` 2.4.8 doesn't enforce OpenClaw pairing. If its legacy allowlist file is empty and no QR scanner ID is saved, it admits any sender. | Use a dedicated WeChat account and confirm the scanner ID is saved. Treat every WeChat sender as non-owner until the plugin supports pairing. |
| 10 | Claude credential readable by the agent | The read-only bind stops tampering, not reading. A prompt-injected agent can paste the token into chat or a commit. | A dedicated config directory holding the credential only, never the owner's `~/.claude`. A revocable subscription. The outbound allowlist and gitleaks hook. Revoke and re-login if it leaks. |

## Open items

- **PCP API schema:** the check scripts use placeholder endpoints until the schema is published.
- **Nested sandbox:** it's unverified whether the OpenClaw Podman sandbox works inside a rootless container.
- **Managed hook paths:** the exact paths for Claude Code managed settings and Codex managed hooks on Linux are unverified.
- **Read-only credential refresh:** it's unverified how Claude Code behaves when it can't write a refreshed token, and whether it rewrites `.credentials.json` in place or by rename.
- **Claude Code sandbox in a container:** it's unverified whether bubblewrap works inside a rootless container.
- **Tool use from QQ:** it's unverified whether AstrBot can pass a per-sender identity that a trusted proxy could use.
