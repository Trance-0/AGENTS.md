# LLM_CHECK.md — Canonical End-of-Round Checklist

## Session archive verification round

- Directory-sync correction: four source-selection modes, immutable session folders,
  repeat-import/update tests and six-plugin release promotion requested by owner.

- Added version 2 complete-record archive transfer and isolated A/B/C database tests.
- Added generated-browser-script syntax verification and widget-local collapsible status.
- Preserved pre-existing working-tree changes; no live-session test records were created.
- See `docs/development/session-archives.md` for format scope and verification commands.

This file is the **reference template** for the `docs/LLM_CHECK.md` that every
project in this owner's workspace should ship. Copy it into a target repo's
`docs/` directory and adapt the project-specific items. The agent reads this
at the end of a modification round **before** declaring the round done.

This file lives at `docs/LLM_CHECK.md`. Do not keep a second copy at repo
root — the root-directory hygiene rule in `AGENTS.md` §1.6 forbids it. If
you find `LLM_CHECK.md` at repo root, the migration step in `AGENTS.md` §2.4
(point 4) applies: move it here and update every reference in the same
commit.

If you are an agent reading this inside the `AGENTS.md` repo itself: there is
no project to verify here; use this as the shape, not as the live checklist.

---

## 1. Common mistakes seen in prior rounds

These are real footguns seen across this owner's repos. Scan this list before
you start a round, and again before you claim it's done.

### 1.1 Reporting

1. Claiming a test or command passed when it was never run in the current
   environment.
2. Reporting partial success as success. Separate verified work from
   unverified work explicitly.
3. Ending a round without preparing a commit message and push command.

### 1.2 Docs and handoff drift

4. Editing code without updating `docs/readme.md` / `docs/index.md` when the
   change affects architecture, deployment, or the project recipe.
5. Leaving `AGENTS.md` claiming a layout that the repo no longer matches
   (e.g. describing a monolith after a three-app split).
6. Documentation that references paths, scripts, or env var names that no
   longer exist.
7. Dropping an agent-authored doc at repo root. Everything except
   `README.md`, `AGENTS.md`, `CLAUDE.md` (single-line `@AGENTS.md` only),
   `CODEX.md`, `VERSION`, `LICENSE`, `.gitignore`, and required build /
   config files belongs under `docs/`. `LLM_CHECK.md` lives at
   `docs/LLM_CHECK.md`, not at root.
8. Renaming a task file without updating its references. If you rename
   `TASK.md` / `tasks.md` to `docs/TODO.md`, every mention in other docs,
   CI scripts, in-code comments, and commit templates must change in the
   same commit.
9. `CLAUDE.md` with content other than `@AGENTS.md`. This file is a pointer,
   not a place to cache notes.

### 1.3 Cleanup

10. Leaving dead links after removing a feature.
11. Removing UI code but forgetting the related settings import/export,
    config schema, or type definitions.
12. Leaving unused dependencies in `package.json` / `pubspec.yaml` /
    `requirements.txt` / `pyproject.toml`.
13. Editing `.gitignore` with OS- or editor-specific noise the project does
    not need, or inadvertently ignoring tracked source.

### 1.4 Infra, deploy, and repository hygiene

14. Assuming a host port (`80`, `443`, `8080`, `5432`, …) is free without
    confirming it on the target machine. You do not know host-machine state
    until you check.
15. Hard-coding `localhost` or `host.docker.internal` for container-to-container
    traffic; in Compose, use the service name.
16. Volume-mounting over a directory that contains baked-in code; this
    produces "random missing package" bugs that look like dependency drift.
17. Wait loops in container scripts with no timeout, or waiting on a tool
    that isn't installed in the image (`nc` in `entrypoint.sh` without
    `netcat` in the build).
18. Parsing `.env` files with naive `source` when values can contain spaces.
19. GitHub project-site Pages deploys that forget the `/<repo>/` base path
    (Next.js `basePath`, mkdocs `site_url`, Flutter `--base-href`).
20. **Staging a real `.env` / `.env.local` / `.env.production` for commit.**
    This is a critical security issue, not a style nit. Only
    `.env.example` / `sample.env` with obvious placeholder values may ship.
21. Staging a file larger than 300 MB without the owner's explicit ask and
    Git LFS (or equivalent) configured. Big blobs pollute history and are
    hard to remove.
22. `.gitignore` missing the project's language caches — `__pycache__/`,
    `node_modules/`, `.venv/`, `.dart_tool/`, `target/`, `.next/`, `.turbo/`,
    `dist/`, `build/`, `coverage/`. Also missing platform-mismatched
    binaries (`.so`, `.dylib`, `.dll`, `.exe`) that aren't a deliberate
    distribution artifact.
23. Committing a cache / build directory from another architecture (e.g.
    Linux `node_modules` shipped from a dev's laptop, Windows
    `__pycache__`). These produce "works on my machine" bugs that only show
    up in CI.

### 1.5 Code shape

24. Module-import-time initialization of vendor SDK clients (OpenAI, Stripe,
    etc.); do it lazily at call time so missing env vars don't break unrelated
    tests or URL imports.
25. Mixing `await import("x")` with static `import ... from "x"` for the
    same module in the same production code path.
26. Using prototype mutation or `Object.defineProperty` on `.prototype` to
    share behavior instead of explicit inheritance / composition.
27. Leaving UI strings with mojibake or placeholder artifacts in shipped
    copy.

### 1.6 Long-running process visibility

28. Adding or changing work that can run longer than 1 minute without a
    progress bar, heartbeat, or other visible progress message. Use a
    native progress UI (`tqdm` etc.) where possible; otherwise emit
    structured heartbeats at fine enough cadence that the run never
    appears hung.
29. Adding or changing work that can run longer than 1 hour without a
    durable checkpoint / resume path. Model training, tokenisation,
    dataset processing, and large artifact generation must not lose all
    progress on interruption.
30. Leaving any code path silent for 5 minutes. Across the owner's
    projects such runs may be terminated as hung.
31. Bare `print` / `console.log` calls during a long-running stage that
    interleave with an active progress bar and shred its rendering. Use
    the language's structured logger (Python `logging`, etc.) and let
    the file own the verbose record while the terminal owns the
    progress UI.
32. Letting a per-run log grow without bound. INFO+ records persist for
    the lifetime of the run; DEBUG records may be aged out (e.g. drop
    older than 3 hours) so a multi-hour run leaves a sparse, readable
    log instead of a multi-GB blob. WARNING / ERROR are reserved for
    actionable conditions and must not be aged out automatically.
33. Logging secrets — API keys, push tokens, raw user PII, or any line
    from `.env` / `*.bark.env` / similar config files. Log the basename
    at most.
34. Repos with a long-running pipeline that *do not* probe for a
    `*.bark.env` (or equivalent) push-channel config and fire silent
    milestone notifications when one is present. The config is gated
    by `*.env` already being in `.gitignore`; verify before staging
    anything that adds a notification channel.
35. Echoing a URL template, device key, or any line of a `*.bark.env`
    file to logs, terminal output, commit messages, PR descriptions, or
    agent reasoning summaries. The basename of the config file is the
    most that should ever appear.

### 1.7 Multi-agent safety

36. Touching another agent's in-progress work — unrecognized files, stashes,
    worktrees, branches — in a shared checkout.
37. Auto-stashing (`git pull --rebase --autostash`) without being explicitly
    asked; silently mutating global git state.
38. Scope creep: expanding a bug-fix round into a refactor without checking
    whether the owner wanted that.

---

## 2. Round-end checklist

Run these **in order**. Do not mark the round done until every applicable
item is either confirmed or explicitly called out as skipped-with-reason.

### 2.1 Truthfulness

- [ ] Every command or test I reported as passing was actually executed in
      this environment, and I can name the terminal it ran in.
- [ ] Every command or test I did **not** run is called out explicitly, with
      the reason (environment limitation, missing toolchain, blocked by
      sandbox, etc.).
- [ ] For any bug fix, I can point at the root-cause line in code, not just
      the symptom that disappeared.

### 2.2 Docs and handoff

- [ ] `README.md` still matches reality (quick start, prerequisites, what
      the project is).
- [ ] `docs/readme.md` still describes how the project works, including any
      deployment topology I just changed.
- [ ] `docs/index.md` and `AGENTS.md` reflect any architectural change
      material enough that a new agent would need it next round.
- [ ] If the repo has per-version docs (`docs/versions/<semver>.md`), the
      current round's user-facing changes are captured there.
- [ ] If I created new deploy steps, a matching `docs/deployment/<target>.md`
      exists and names the exact commands.
- [ ] Every agent-authored doc created this round lives under `docs/`
      (unless the owner explicitly asked otherwise). Root contains only the
      files listed in `AGENTS.md` §1.6.
- [ ] `docs/LLM_CHECK.md` exists here; there is no root-level `LLM_CHECK.md`
      copy lingering.
- [ ] `CLAUDE.md` at root contains only `@AGENTS.md` (no other content).
- [ ] If I renamed `TASK.md` / `tasks.md` to `docs/TODO.md` this round,
      every reference in docs, in-code comments, CI scripts, and commit
      templates has been updated in the same commit.
- [ ] If this round is a material change (runtime / deploy target / env var
      / CI step / entry-point script / agent recipe), `README.md`,
      `docs/readme.md`, and the relevant `docs/<area>/` file are updated in
      the **same commit** as the code.

### 2.3 Code hygiene

- [ ] Searched for references to any feature I removed (`rg`), and all
      dangling imports / routes / settings fields are gone.
- [ ] Unused deps removed from the relevant manifest and its lockfile.
- [ ] `.gitignore` ignores only local junk; no tracked source is hidden.
- [ ] `.gitignore` covers the project's language caches and build output
      for every toolchain it uses (Python, Node, Dart, JVM, etc. — see
      `AGENTS.md` §1.4).
- [ ] No `.env` / `.env.local` / `.env.production` / `.env.*` with real
      values is staged. Only `.env.example` / `sample.env` with obvious
      placeholders may ship. Checked with `git diff --cached --name-only`.
- [ ] No single staged file exceeds 300 MB. Checked with
      `git diff --cached --stat` (or `git ls-files -s` + sort) before
      pushing.
- [ ] No platform-mismatched binaries or cross-architecture cache dirs are
      staged.
- [ ] UI strings are plain, intentional, free of mojibake and placeholder
      artifacts.
- [ ] Any new comment explains a non-obvious **why**, not a **what**.

### 2.4 Build / test / lint

Adapt to the repo's stack. Default bar:

- [ ] Type-check / analyze: `npm run typecheck` or `pnpm tsgo` or
      `dart analyze` (mark skipped-with-reason if the toolchain cannot run
      here).
- [ ] Lint / format: `npm run lint`, `pnpm check`, `ruff`, `flake8`,
      `dart format --set-exit-if-changed`.
- [ ] Unit tests: `npm test`, `pnpm test`, `pytest`, `python manage.py
      test`, `flutter test`.
- [ ] Build: `npm run build`, `pnpm build`, `flutter build web
      --no-web-resources-cdn`, `docker compose build --pull --no-cache`
      (only when debugging dependency drift).
- [ ] Integration / smoke: whatever the repo's smoke command is (e.g.
      Notechondria's `pnpm test:parallels:*`, index's `npm run build` +
      visual check).

### 2.5 Infra and deploy sanity

- [ ] Every host port I assigned was explicitly verified for the target
      machine — no assumed-free ports.
- [ ] Container-to-container traffic uses service names, not `localhost`.
- [ ] CI scripts and Dockerfiles agree on invocation syntax, env var names,
      and mounted paths.
- [ ] Pages deploys for project sites use `/<repo>/` as the base path, and
      the built bootstrap was inspected to confirm it.
- [ ] Secrets / tokens / personal data are not committed. Placeholder values
      are obviously fake.

### 2.6 Multi-agent safety

- [ ] No unrelated user changes were reverted, stashed, or force-pushed.
- [ ] No `git worktree` / branch / stash state was created, dropped, or
      switched without explicit approval.
- [ ] Unrecognized files and in-progress branches were left alone.

### 2.7 Handoff

- [ ] Commit message drafted (action-oriented, scoped, Conventional-Commit-ish).
- [ ] Push command prepared (or noted that the round should not be pushed
      yet).
- [ ] `AGENTS.md` / `docs/index.md` updated if any rule or architectural
      invariant changed during the round.
- [ ] If the round materially changes the "how to rebuild this project with
      an LLM" recipe, the relevant section (§2 of the template) is updated.
- [ ] `docs/TODO.md` reflects closed / opened items if the project tracks
      them there.

---

## 3. Current round log

Append, do not rewrite. One bullet per concrete change or decision. Keep
bullets specific: filenames, command names, outcomes.

> _This is the template's own log. Project repos replace this section with
> their real per-round entries._

- 2026-04-13: Initialized the canonical `AGENTS.md` / `LLM_CHECK.md`
  template in the `AGENTS.md` repo, derived from patterns already in use
  across `openclaw`, `Notechondria`, `Leetcode_Checker`, `TestLover`,
  `Sheaf`, and `index`.
- 2026-04-13: Added root-directory hygiene rule (`AGENTS.md` §1.6), secrets
  / 300 MB / cache `.gitignore` rules (§1.4), `docs/TODO.md` rename policy
  (§2.5), material-change docs sync rule (§2.6). Moved `LLM_CHECK.md` from
  repo root to `docs/LLM_CHECK.md`, added `CLAUDE.md` at root as the
  `@AGENTS.md` include, and updated every in-repo path reference.
- 2026-09-21: task-queue (1.0.6). A pending task whose session is gone is now
  dropped by `reconcile` instead of being dispatched into "Session not found";
  dispatch falls back to the session's directory when the task has none; task
  directories are stored with forward slashes. `task_create` gained
  `nextAttemptAt` and fills in the session's project/directory. Verified with
  `tsc --noEmit` over `lib/*.ts plugin/*.ts` plus two sandboxed scheduler tests
  (`restart-sim.mjs`, `fix-verify2.mjs`).
- 2026-09-21: task-queue (1.0.8). A task may omit `sessionID`: it carries a
  unique `new:` placeholder and creates a real session on first dispatch, with
  `bypassPermissions` auto-answering `permission.updated`. Added
  `task-queue-seed.json`, merged once at startup, so work can be queued while
  opencode is down (the store is rewritten by whichever process is up, so a
  task placed there by an older build is dropped or stripped). Verified with
  `tsc --noEmit` over `lib/*.ts plugin/*.ts` and four sandboxed scheduler tests
  (`restart-sim`, `fix-verify2`, `new-session-test`, `seed-test`).
- 2026-11-03: Added `ai-platform-design/` at repo root on branch `ai-infra-v0`
  (root placement requested by the owner). It holds `design.md`,
  `build-plan.md` (Tasks 1-11), `agent-comparison.md` and `checks/*.sh` stubs.
  No code paths changed. Verified with `bash -n` on every check script and a
  publish-safety scan of the branch diff. The check scripts themselves were not
  run: they target the owner's platform host, which doesn't exist yet.
- 2026-11-03: Deployed dashboard version 0.1.0 using
  `dashboard/compose.yaml` on loopback port 14143 and the existing local frpc
  container's remote TCP port 6018, serving `https://live.trance-0.com`.
  Verified the port before assignment. Backed up the FRP config privately and
  preserved existing proxies; the private FRP config remains a local change in
  its separate checkout because it contains authentication material.
- 2026-11-03: Created a distinct Casdoor dashboard OIDC application based on
  Gitea's claim/signing setup, plus application and administrator groups.
  Assigned both groups to the requested existing administrator, preserving
  original memberships and verifying the Gitea application was unchanged.
  Creating groups with `users` alone did not update the existing user's
  `groups`; explicitly updating that membership fixed access.
- 2026-11-03: Fixed missing login-state rejection and userinfo subject binding
  in `dashboard/server/oidc.js:37`, HTTPS cookie/proxy configuration and JSON
  toggle parsing in `dashboard/server/index.js:49`, and session regeneration
  at `dashboard/server/index.js:74`. Added an administrator group gate for
  mutations, bounded expiring sessions, durable panel state, and structured
  logs. Fixed the false AstrBot outage from probing an absent `/api/health`
  route in `dashboard/server/panels/astrbot.js:34`; probe the verified web root.
  Added `X-Accel-Buffering: no` for SSE after public streaming timed out behind
  the remote proxy's response buffering.
- 2026-11-03: Passed `npm test --prefix dashboard`, the same signed-token OIDC
  integration test under the production image's Node 22 runtime, JavaScript
  syntax checks, Docker image build, Compose configuration validation, FRP
  validation, `git diff --check`, and public HTTPS/remote-port health checks.
  Live Casdoor checks confirmed admin access, viewer mutation denial, denial
  without the application group, logout, bearer-token enforcement, panel
  toggles, immediate SSE delivery, and all three upstream availability probes.
  The temporary auth-check account was removed, panel state restored, and
  temporary credential snapshots deleted. Evidence is retained in the ignored
  `logs/dashboard-verification-20261104T033049Z.log`.
- 2026-11-03: Updated `README.md`, `docs/readme.md`, `dashboard/README.md`, and
  `docs/deployment/dashboard.md`. Checked ignored environment/log files,
  staged sizes/secrets, changed-file line limits, and unrelated changes.
  No lint/typecheck scripts are configured for this JavaScript service; those
  checks were skipped. Jenkins was not run because this deployment uses local
  Compose; its earlier scaffold needs alignment before use. No browser UI
  automation was run because no browser tool is available; public HTTP,
  authentication, panel APIs, and streaming were exercised directly. Work is
  committed locally on the existing feature branch; no push was requested.

- 2026-11-04: Shipped dashboard 0.1.1 public viewing, timed recording playback,
  hover previews, three display modes, fetched Casdoor avatars, side chat,
  OpenClaw host replies in the main log player, and admin Start/End plus
  recording visibility/recommendation scores. Detailed root causes and dev
  evidence are in `docs/development/dashboard-log.md`. Public broadcast data
  is separate from private operational logs; panel APIs stay authenticated.
- 2026-11-04: Passed server/storage/preview tests locally and in the Node 22
  production image; passed Playwright Chromium guest/admin/mobile, hover,
  replay, avatar, screen mode, chat, and moderation checks. Built the Docker
  image, validated Compose and OpenClaw config, checked JavaScript syntax and
  `git diff --check`. Live Casdoor/FRP/HTTPS checks and a real OpenClaw reply
  passed. Test account/cookies were removed; test recording is hidden for
  admin review. Evidence is under ignored `logs/dashboard-v0.1.1-*` paths.
- 2026-11-04: Deployed to the existing loopback port 14143 and remote port
  6018, preserving `dashboard_dashboard-state` and the FRP config. Backed up
  prior state/config and retained the 0.1.0 image. The isolated OpenClaw host
  uses a separate workspace, no tools, and no memory search. No gateway
  restart or changes to other agents/bindings were required. Private gateway
  token is only in ignored `.env`; no operational snapshots are staged.
- 2026-11-04: Reopened and synchronized `README.md`, `docs/readme.md`, dashboard
  README, and the deployment runbook. Checked changed-file line limits, sizes,
  ignored secrets/state/logs, doc links, version/config consistency, and
  unrelated changes. Lint/typecheck and Jenkins were skipped because no
  corresponding service scripts or configured pipeline exist. Work is
  committed locally on the feature branch; no push was requested.

- 2026-11-04: Added dashboard 0.1.2 OpenClaw integration: scoped machine
  start/status/end API and owner-only `dashboard_stream` plugin tool, plus six
  agent/model/tool lifecycle hooks. Events preserve the existing recording
  schema, exclude private payloads, and bind to recording/session references.
  Provider-error hooks emit warning metadata without raw errors. Detailed
  implementation and dev evidence are in `docs/development/dashboard-log.md`.
- 2026-11-04: Passed four server tests locally and under Node 22, Chromium
  regression checks, Docker build, Compose/gateway config validation, installed
  plugin/tool/hook inspection, syntax checks, public health/event checks, and
  `git diff --check`. A real owner-agent tool call started OpenClaw Live. A real
  logged-in viewer chat recorded one host reply plus native lifecycle events.
  Stream is left live; temporary test identity removed. The main provider's
  post-tool thinking-signature error remains an external limitation, recorded
  in the development log; chat host and control tool both worked.
- 2026-11-04: Backed up gateway config and dashboard state, retained the old
  image, preserved mount/port/FRP state, and kept machine tokens out of Git.
  Plugin config required gateway reload; clean exit under its existing
  on-failure policy required `docker start`. Installed plugin path is pinned.
  Updated README, docs/readme, dashboard README, runbook, and dev log. Audited
  staged secrets/sizes, line limits, versions, doc links, and unrelated edits.
  Lint/typecheck and Jenkins remain skipped because this service has no such
  scripts or configured pipeline. Commit stays local; no push requested.

- 2026-11-04: Configured the `agent-dashboard` Pipeline-from-SCM Jenkins job
  for GitHub `ai-infra-v0`, script `dashboard/Jenkinsfile`, `local-docker`, and
  `githubPush()`. Runtime env is private on the agent; source is remote-only.
  Replaced the unused scaffold with versioned builds, Node 22 tests, isolated
  smoke checks, backup, rollout/rollback, public health, and plugin updates.
- 2026-11-04: Dashboard 0.1.3 uses SVG Play/Pause icons, signed browser-session
  viewer identity across tabs/reconnects, owner-scoped live summary updates,
  and durable same-recording recovery across deployment. Added tests for
  audience identity, malformed-cookie handling, summary ownership/persistence,
  and truncation/recovery. Chromium checks cover distinct browser contexts,
  shared-cookie tabs, and live pause state. `npm test`, browser checks, Python
  syntax, and Jenkins declarative validation passed locally. Remote build and
  webhook evidence will be appended after pushing the authorized changes.

- 2026-11-04: GitHub push `30d8ff1` triggered Jenkins dashboard build #1 with
  `GitHubPushCause`; SUCCESS, exact remote SHA, all five Node 22 tests, smoke,
  backup, rollout, public health, and plugin update verified. Live recording
  ID stayed unchanged. Public Chromium audience/icon/summary checks passed.
  Installed OpenClaw summary action persisted and displayed the description.
  No DB migration needed; existing recording volume and backups retained.
  Container checkout is prepared; owner deferred its GitHub write permission.
  Final summary-scope correction and these results are pushed for another
  webhook build. No local-source snapshot or manual build was used.

- 2026-11-04: Fixed missing live OpenClaw file activity. The dashboard had no
  shared log mount and HTTP lifecycle events omitted tool paths. Added a
  daily JSONL writer, bounded reader with durable cursors, and read-only
  dashboard mount. Only file-tool target paths and lifecycle metadata enter
  the feed; contents, commands, credentials, and private assistant text do not.
- 2026-11-04: All seven Node 22 server tests passed, including partial UTF-8
  records, rotation, truncation, restart cursors, and sensitive-field exclusion.
  An isolated container emitted read start/completion events and rejected a
  shared-directory write with EROFS. Production health, mounts, preserved live
  recording ID, and Chromium rendering of a real Claude file-read turn passed.
  A second real CPA Claude turn with stored reasoning history also completed.
- 2026-11-04: Applied a local runtime repair with prior container, image, config,
  plugin, and recording backups retained. Jenkins deployment source now includes
  the same read-only mount, but no GitHub push or Jenkins build was requested.
  Python syntax, Compose validation, diff checks, and changed-file size audit
  passed. Updated README, architecture overview, env example, and runbook.
