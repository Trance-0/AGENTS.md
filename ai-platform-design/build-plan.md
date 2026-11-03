# Build plan

Every task ships `checks/NN-name.sh`, which exits non-zero on failure. Later tasks re-run earlier checks with `checks/run-all.sh NN`, which runs checks 01 through NN in order and stops at the first failure. Each task lists an Objective, Guidance, Check and Demo. See `design.md` for the reasoning behind each rule.

Names used throughout:

- **Repos:** `platform-infra` (owner only) and `agent-stack` (agent writable).
- **Build nodes:** `agent-build` and `platform-deploy`.
- **Registry tags:** `lkg` is a moving tag. `lkg-<build>` tags are immutable.
- **Branches:** `scratch` is the agent's always-pushable branch.

v0 stack: AstrBot, OpenClaw, PCP and Claude Code. Codex isn't in v0.

Checks 05 and 10 stop and restart services. They refuse to run unless `CONFIRM_DISRUPTIVE=yes` is set.

## Task 1: Host baseline and zone separation

- **Objective:** separate the platform and agent zones on one host.
- **Guidance:**
  - Create the `platform` and `agent` Unix users. Set up rootless Podman for `agent`, with subuid and subgid ranges.
  - Give each user its own data directory with mode 700.
  - Bind every service to `127.0.0.1`.
  - Choose the off-device backup target now (object-lock bucket, NAS snapshot, or a drive rotated offline).
  - Add Tailscale or WireGuard only if you need remote access.
- **Check (`01-host.sh`):**
  - `agent` can't read the platform directories.
  - `ss -ltn` shows only loopback listeners.
  - No container mounts `docker.sock` or `podman.sock`.
  - Data directories are mode 700.
- **Demo:** the check passes on a clean host.

## Task 2: Forgejo with history protection

- **Objective:** set up git hosting that the agent can't use to rewrite or delete history.
- **Guidance:**
  - Create the `platform-infra` repo. Only the owner can push.
  - Create the `agent-stack` repo. The agent can push, but force pushes and branch deletion are blocked on all branches, and `lkg-*` tags are protected.
  - Give the agent its own Forgejo account and a commit signing key.
  - Install a gitleaks pre-receive hook.
  - Run a nightly pull mirror, with snapshots to the off-device target.
- **Check (`02-git.sh`):** the following are all rejected when attempted with the agent's credentials:
  - a force push
  - a branch delete
  - a tag delete
  - a push to `platform-infra`
  - a commit containing a fake API key

  The mirror has the latest `main` commit.
- **Demo:** a normal push to `scratch` works and each protected operation fails.

## Task 3: Jenkins controller and webhook

- **Objective:** run a Jenkins controller that only the owner can configure, triggered by pushes to Forgejo.
- **Guidance:**
  - Load the controller config with Configuration as Code from `platform-infra`.
  - Set the controller to 0 executors.
  - Create the `agent-build` and `platform-deploy` nodes, with job restrictions between them.
  - Scope the agent's Jenkins user to its own folder, plus log read access.
  - Authenticate the Forgejo webhook with an HMAC secret.
- **Check (`03-jenkins.sh`):**
  - A push to `scratch` triggers a build.
  - The agent token gets 403 on `/script`, `/configure` and the platform jobs.
  - An unsigned webhook is rejected.
  - The controller has 0 executors.
- **Demo:** a "hello" Jenkinsfile goes green and the agent can read its log.

## Task 4: Image build, platform deploy and LKG tagging

- **Objective:** get the full path from build to deploy, health gate, soak and `lkg` working, using a placeholder container.
- **Guidance:**
  - Use a local registry.
  - Deploy by digest only.
  - Keep the health gate script in `platform-infra`.
  - Inject secrets from Jenkins credentials as env vars.
  - The agent build publishes `image-digest.txt` as a build artifact so the deploy job and the checks can find the digest.
- **Check (`04-deploy.sh`):**
  - After the soak period, `lkg` points to the latest green `main` digest.
  - At least 5 `lkg-*` tags are retained, once 5 deploys have happened.
  - The agent's registry credentials can't move or delete `lkg`.
- **Demo:** change the placeholder's response text, and a new LKG image is produced automatically.

## Task 5: Watchdog and automatic rollback

- **Objective:** roll back to the LKG image automatically when health fails, even with Jenkins down.
- **Guidance:**
  - Run the watchdog as a systemd service under the `platform` user.
  - Run Podman pull and run of the `lkg` digest under a lock file.
  - Send alerts through the platform notifier bot.
  - Provide a manual kill switch command (`ai-killswitch`) that stops agent containers and pauses the watchdog.
- **Check (`05-rollback.sh`):**
  - A deliberately broken image rolls back within N minutes.
  - The same happens with Jenkins stopped.
  - The watchdog logged an alert.
  - The kill switch exists.
- **Demo:** break the placeholder, watch it recover, and receive the alert.

## Task 6: PCP in the platform zone, plus new features

- **Objective:** run PCP as a backed-up platform service and add the features this design needs.
- **Guidance:**
  - Run PCP as a platform service and snapshot its data before every deploy.
  - Add source labels, read scopes, idempotency keys and redaction.
  - Wrap untrusted content as data when it's served back.
  - Send derived summaries to dashboard review.
- **Check (`06-pcp.sh`):**
  - Appending twice with the same idempotency key creates one record.
  - A session token can't read another topic.
  - A fake key in an appended message is redacted.
  - The source label survives export.
- **Demo:** a message appended with curl shows up labeled in the dashboard.

## Task 7: OpenClaw executor with Telegram, connected to PCP

- **Objective:** run OpenClaw from the pipeline, with Telegram conversations recorded in PCP.
- **Guidance:**
  - Deploy OpenClaw from `agent-stack` through the pipeline.
  - The model config references keys only as env vars or env SecretRefs.
  - Set an outbound firewall allowlist: model providers, PCP, Forgejo and Telegram.
  - Only the owner can trigger tool use. Approve only the owner's Telegram ID through OpenClaw pairing.
  - Set a spend cap in each provider's console.
  - Enable `agents.defaults.sandbox`.
  - Add the canary chat check to the platform health gate.
- **Check (`07-openclaw.sh`):**
  - The owner's message gets a reply and appears in PCP labeled `telegram`.
  - A non-owner message triggers no tools.
  - gitleaks finds no keys in the repo or the image.
  - The container can't reach a host outside the allowlist.
- **Demo:** chat on Telegram and see the session appear in PCP.

## Task 8: AstrBot as the QQ/WeChat adapter

- **Objective:** AstrBot forwards QQ and WeChat messages to OpenClaw, and its built-in agent goes unused.
- **Guidance:**
  - Enable OpenClaw's `/v1/chat/completions` endpoint on loopback.
  - Configure it in AstrBot as an OpenAI-compatible provider, with `model: openclaw/relay` and base URL `http://127.0.0.1:18789/v1`. No code needed.
  - Give the `relay` agent PCP read/append tools only, because the bearer token is an owner credential.
  - Map `user` to `astrbot:<platform>:<conversation>`.
  - Use secondary QQ and WeChat accounts.
  - Group chats get a restricted topic only.
- **Check (`08-astrbot.sh`):**
  - A QQ DM can recall a phrase set on Telegram, so the topic continues across channels.
  - A group chat asked for the same phrase doesn't reveal it.
- **Demo:** start a topic on Telegram and continue it from QQ.

## Task 9: Claude Code over SSH and in the OpenClaw container

- **Objective:** run Claude Code inside the OpenClaw container, with a read-only credential, and record its sessions in PCP so they're searchable. Codex is not in v0.
- **Guidance:**
  - Create the dedicated host config directory `/srv/platform/claude-agent/`, owned by `platform`, and sign it in once with `CLAUDE_CONFIG_DIR=/srv/platform/claude-agent claude auth login`. Never mount the owner's personal `~/.claude`.
  - In the container:
    - Bind that directory read-only at `/claude-cred/`.
    - Set `CLAUDE_CONFIG_DIR=/claude` on a writable `claude-state` volume.
    - Make `/claude/.credentials.json` a symlink to `/claude-cred/.credentials.json`. A directory bind is used rather than a single-file bind, so host refreshes stay visible (see `design.md`).
  - Add a daily `platform` timer that runs a trivial `claude -p` against the host directory, so the host keeps the login fresh.
  - Keep the fallback ready: a `claude setup-token` token, stored as a Jenkins credential and injected as `CLAUDE_CODE_OAUTH_TOKEN`.
  - Hooks: a SessionStart hook injects the topic summary (at most 10,000 characters), and a Stop hook appends the turn through the redaction path. Ship them in managed settings, bound read-only from the host.
  - Run a PCP MCP server for reads.
  - Codex, if added later, uses the same events in `hooks.json`, installed as managed hooks so they're trusted by policy.
- **Check (`09-cli.sh`):**
  - Writing to the credential mount from inside the container fails.
  - The owner's personal `~/.claude` (session `projects/`) isn't visible in the container.
  - A `claude -p` run inside the container succeeds.
  - A scripted `claude -p` session appears in PCP with the secret redacted.
  - MCP `memory.search` returns it.
- **Demo:** code over SSH, then ask on Telegram "what did I just change?" and get a summary.

## Task 10: End-to-end self-evolution loop and chaos tests

- **Objective:** the agent edits `agent-stack` in its workspace volume and pushes, and the pipeline deploys or rolls back without the owner.
- **Guidance:**
  - Treat the workspace volume as a cache. Recovery means re-cloning.
  - Add the `scratch` push check to the health gate.
- **Check (`10-chaos.sh`):**
  - A change that breaks Telegram rolls back.
  - Removing the agent's own tests doesn't skip the platform gate.
  - Edits to `platform-infra` and use of the Jenkins Script Console are denied.
  - A prompt injection hidden in a build log changes neither `platform-infra` nor `lkg`.
- **Demo:**
  - Ask the agent on Telegram for a feature. It commits, builds and deploys, and the build becomes the new LKG image.
  - Ask it for a broken change and watch the rollback.

## Task 11: Dashboard host and manager panels

- **Objective:** one dashboard in the agent zone with hot-pluggable panels: OpenClaw config manager, OpenClaw backend manager, and plugin, build and LKG status. PCP session import and export stay in PCP's own dashboard. The agent builds this task under full autonomy.
- **Guidance:**
  - Don't build on dsh. Port the `plugin-manager` registry contract from this repo's `opencode/lib` and `opencode/README.md`:
    - self-described settings fields
    - the `Registry.isEnabled` soft toggle
    - server-side `children` and `run` resolvers stripped from the snapshot
    - invalid JSON blocks a save
    - the port bind is the lock
  - Panels are modules discovered from one directory. Disabling a panel gates its routes with no restart.
  - The config manager commits to an `agent-stack` branch and never edits live files. The pipeline deploys the change.
  - The backend manager shows provider names and env var names only. Key values stay in Jenkins credentials.
  - Bind to `127.0.0.1`. Mutating endpoints require a dashboard token. Reach the dashboard over an SSH tunnel or Tailscale.
  - No owner credential (PCP owner token, OpenClaw gateway token, Jenkins admin) is in the dashboard's environment.
  - Deploy the dashboard through the pipeline like any other `agent-stack` component.
- **Check (`11-dashboard.sh`):**
  - The dashboard listens only on loopback.
  - A mutating call without the token is rejected.
  - A config change creates a commit on an `agent-stack` branch, and the live OpenClaw config is unchanged.
  - A disabled panel's API stops answering without a restart.
  - The snapshot leaks no resolver code and no secret values.
  - An invalid JSON save is rejected.
  - No owner token is in the dashboard container's environment.
- **Demo:** add a new panel module, see it appear on reload, toggle it off, and change an OpenClaw setting that ships through the pipeline.
