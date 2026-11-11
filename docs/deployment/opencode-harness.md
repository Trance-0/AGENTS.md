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

The six original repository plugins are installed in the server's config directory:
`plugin-manager`, `bark-notify`, `cpa-usage`, `task-queue`, `session-manager`,
and `session-rename`. Their `lib/` and `versions.json` ship with them.
The additional `model-fallback` plugin provides local inference failover.
Dependencies are `@opencode-ai/plugin@1.19.5` and `msgpackr`.
No old task queue or personal session database was copied into the new server.
Task summaries use the parser; session renaming uses the configured model.
Bark is installed with no subscribers; no notification test was sent.

## Model and loop behavior

The primary and auxiliary models are `cpa/gpt-6-astra`. The native OpenAI
provider remains available for explicit selection. The local fallback is
`local-vllm/nvidia/Qwen3.8-27B-NVFP4`, served by the existing vLLM container.
The desktop and ACP backend share this server-side configuration.

OpenCode 1.19.5 has no native fallback chain. The `model-fallback` plugin adds a
fetch hook to the configured CPA provider when `local-vllm` is also configured.
It retries Chat Completions requests locally on transport failures, a 45-second
response-header timeout, HTTP 401/403/404/408/429, or server errors. Local requests
retain messages and tool calls, replace the model ID, and omit CPA credentials
and provider-specific reasoning options. Caller cancellation, malformed requests,
and errors after a stream starts do not replay the request. Explicitly selected
non-CPA providers are unaffected. A large context can still exceed local limits.

The composer retains the selected CPA model name during fallback; actual routing
is recorded in the `model-fallback` plugin log under the shared server data root.
It does not silently change the user's persistent model selection. Both the
primary provider and a forced CPA-503-to-local-Qwen Python tool and final response round
were verified. Ten routing tests and the focused TypeScript check passed.

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
/acp model cpa/gpt-6-astra
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


## AstrBot delegation incident and verification (2026-11-11)

The Bilibili coding request reached OpenCode. Its parent could not call
`sessions_yield` because the PCP execution-policy vocabulary omitted that tool.
The child then failed on exhausted provider credit, but its final error was
routed only to the transient HTTP parent. The original QQ conversation never
received that blocker. A separate earlier coding run waited on an external-path
permission after using gateway container paths in the host coding server.

The ACP bridge now reports sanitized provider/permission blockers and includes
host/container path mappings. The deployed coding default uses the existing CPA
provider; text and real Python tool execution passed. `sessions_yield` is
available to the owner execution agent. Group allowlists remain empty.

PCP 0.4.3 observes accepted ACP streams with a persistent per-run cursor and
routes started/progress/completed/blocked updates through signed ingress polls.
Initial registration binds the original turn, child, run, and channel credential;
updates continue after the parent grant closes. The terminal summary is appended
to PCP history. Retries can duplicate a platform message if a crash occurs after
sending but before saving the cursor. A missing terminal result reaches the
six-hour monitoring deadline and is reported as blocked, never as success.

Live verification used a separate, expiring ingress credential with no platform
adapter. A delegated Python tool ran after `sessions_yield`; the parent closed,
then PCP recorded and returned `LOCAL_DELEGATION_VERIFIED 12345` through signed
polling. A subsequent explicitly authorized QQ private-chat test delivered
started, running, and completed messages after the parent yielded. All three
were found in QQ history and verified through `get_msg`; the final message
contained `QQ_STATUS_DELIVERY_VERIFIED 12345`. The temporary read-only observer
was removed and private verification evidence retained.

Dashboard 0.4.2 was deployed by successful GitHub-webhook Jenkins build 31.
Its task editor sends only changed fields, avoiding legacy stored
`failureAlert.delivery` fields rejected by current gateway write validation.
A temporary future task passed enable, disable, and Undo against the live
gateway and was removed; the seven original task configurations were unchanged.
Browser checks cover the top save notification, Undo, and five-second expiry.
