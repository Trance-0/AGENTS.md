# OpenCode coding harness for OpenClaw

OpenClaw delegates long coding/debugging tasks through its ACP runtime to one
authenticated OpenCode HTTP server. The desktop and terminal UI connect to that
same server, so the owner sees its prompts, tool calls, permission requests, and
results. Existing personal desktop sessions remain on the local server.

The standard `opencode acp` command starts its own HTTP server per process.
`opencode/openclaw-plugin/` supplies the `opencode-server` ACP backend to keep
one server and one session store shared with the UI. It supports create/resume,
build/plan mode, model/variant/timeout changes, progress, cancel, and close.
Closing retains the OpenCode transcript. It does not support per-session
environment injection or overriding approval policies; use the UI for approvals.

## Runtime and storage

- OpenCode 1.19.5, matching the installed desktop. The Linux ARM64 npm binary
  archive was checked against its published SHA-512 integrity value.
- User service `openclaw-opencode.service`, with user lingering enabled so
  it runs after logout. The template is `opencode/server/openclaw-opencode.service`.
- HTTP binds only `127.0.0.1:4096`, with Basic authentication. There is no
  public tunnel or extra exposed network listener for the coding server.
- Private root: `$HOME/Documents/DockerVolumes/openclaw-opencode/`.
  `runtime/` holds the binary; `config/`, `data/`, `cache/`, and `state/`
  are the server's separate XDG directories. `data/opencode/opencode.db`
  checkpoints conversation history. `logs/` holds server and plugin logs.
- `server.env` contains XDG paths and HTTP credentials, mode 600. Provider
  credentials are in `config/opencode/opencode.json`, mode 600. Never commit
  either file or print its contents.
- Gateway credentials and session mappings use its existing persistent
  OpenClaw state mount: `credentials/opencode-server.json` and
  `opencode-sessions/`. `pathMap` translates container workspace paths into
  the matching host paths; explicitly supplied host project paths also work.

The six repository plugins are installed in the server's config directory:
`plugin-manager`, `bark-notify`, `cpa-usage`, `task-queue`, `session-manager`,
and `session-rename`. Their `lib/` and `versions.json` ship with them.
Dependencies are `@opencode-ai/plugin@1.19.5` and `msgpackr`.
No old task queue or personal session database was copied into the new server.
Task summaries use the parser; session renaming uses the configured model.
Bark is installed with no subscribers; no notification test was sent.

## Model and loop behavior

The verified default is `openai/gpt-6-astra` with `reasoningEffort: high`,
using the existing OpenClaw OpenAI credential and the native `@ai-sdk/openai`
provider. That provider uses Responses. GPT-6 Astra rejects reasoning plus
function tools on Chat Completions; see the official
[reasoning guide](https://developers.openai.com/api/docs/guides/reasoning).

CPA remains available for explicit selection. During installation, its Astra
route reported cooldown, Sol reported quota exhaustion, and the configured
Opus alias returned 404. These are upstream failures, not missing plugins.
The native OpenClaw model priority was preserved.

There is no fixed small tool-iteration cap in the bridge. A turn has a six-hour
default timeout, editable with `/acp timeout`. Polling emits progress at least
every 20 seconds. The server saves turns as they run; a reconnect with the same
request ID attaches to the saved message instead of resubmitting it. Resume
later with the server session ID. A provider outage or process interruption
can still require a retry; installing a harness does not guarantee completion.

## Usage

Ask OpenClaw to use OpenCode for a complex task, or start explicitly:

```text
/acp doctor
/acp spawn opencode --mode persistent --thread off
/acp model openai/gpt-6-astra
/acp set variant high
/acp timeout 21600
```

Use the returned session key when steering an unbound session. Agents delegate
with `sessions_spawn` using `runtime: "acp"`, `agentId: "opencode"`, and
`streamTo: "parent"`. They must pass the relevant task/context and wait for
completion. Thread creation still follows the existing channel policies.

Desktop: **Settings → Servers → OpenClaw OpenCode** is saved as default.
**Home → OpenClaw OpenCode → workspace** shows delegated sessions. Restored
tabs from the personal local server remain available. The connection's
credentials are in the desktop's private store. Its previous settings are
backed up under the private root's `backups/` directory.

Terminal UI:

```bash
python3 opencode/scripts/attach-server.py
```

The launcher passes the password through the environment, never an argument.
Two clients should not submit turns concurrently to the same session.

## Operations and reconstruction

```bash
systemctl --user status openclaw-opencode
systemctl --user restart openclaw-opencode
node --test opencode/openclaw-plugin/runtime.test.js
```

Install the pinned npm platform binary under `runtime/package/bin/`; verify
the registry integrity before running it. Populate the private config and
credentials from the existing deployment backups, preserving mode 600.
Copy `opencode/plugin/`, `opencode/lib/`, and `opencode/versions.json` into
`config/opencode/`; install the two dependencies there. Copy the service
template into `~/.config/systemd/user/`, reload the daemon, and enable it.
Check loopback port availability before starting on a new host.

Copy `opencode/openclaw-plugin/` into the gateway's persistent
`extensions/opencode-server/`, allow it explicitly, and record its local
installation in OpenClaw. Its manifest documents required configuration.
Enable ACP with backend `opencode-server`, default/allowed agent `opencode`,
and the deployment's existing concurrency and channel policy. Restart the
gateway after validation. Back up the live config before modifying it.

The deployment also requires the OpenClaw ACP webchat delivery repair:
`src/auto-reply/reply/dispatch-acp-delivery.ts` sends webchat ACP blocks through
the final-reply collector. Without it, the server completes the task but
webchat emits an empty final event and does not save the answer.

Rollback: restore the backed-up gateway config and prior gateway image, then
stop/disable the user service. Restore the desktop settings backup to revert
its default connection. Keep all state directories and transcripts intact.

## Runtime state relocation

OpenClaw state now lives in `DockerVolumes/openclaw/state`, with the workspace
under its `workspace/` directory. The ACP `pathMap` points to this host root.
The former checkout path is a compatibility symlink; the original pre-migration
tree is retained under `DockerVolumes/openclaw/rollback`. A stopped-write rsync
checksum and metadata comparison verified the complete tree before recreation.
