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
  container's a private FRP remote TCP port, serving `https://live.trance-0.com`.
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
- 2026-11-04: Deployed to the existing loopback port 14143 and a private FRP remote
  port, preserving `dashboard_dashboard-state` and the FRP config. Backed up
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

- 2026-11-04: Dashboard 0.1.4 corrects gateway HTTP-200 error-completion handling
  and duplicate legacy start hooks. File and HTTP events retain provider/model
  and run IDs; private payloads remain excluded. Verified ten server tests,
  config validation, the real local gateway/token connection, two persistent
  CPA GPT-6 Astra fallback turns, and an official OpenAI GPT-6 Astra API probe.
  Configured CPA Opus 5.5 → CPA GPT-6 Astra → official OpenAI GPT-6 Astra for
  defaults and dashboard-host; removed CPA Gemini definitions/aliases and
  checked cron/session overrides. CPA Opus currently returns auth_unavailable.
  Private config backups and detailed dev evidence are retained. Jenkins push
  deployment will restart gateway/dashboard and verify the preserved recording.

- 2026-11-04: Jenkins #4 completed SUCCESS from actual GitHub push `6f95ef2`.
  Gateway and dashboard restarted with the final three-model order and no CPA
  Gemini definitions. Two public-chat turns using the original live recording
  and saved history matched their reply run IDs to successful CPA GPT-6 Astra
  model-output events. Public Chromium rendering passed; temporary test user
  removed. Model config, secret exclusion, docs links/line limits, and recording
  preservation were verified. CPA Opus 5.5 remains upstream-auth unavailable;
  official OpenAI GPT-6 Astra direct probe succeeded. Final evidence added to
  the development log; no unrelated runtime data or source was changed.

- 2026-11-04: Added administrator-only CPA quota and OpenClaw usage plugins.
  Reviewed CC Switch's UsageDashboard, UsageTrendChart, UsageHero/model tables,
  and SQLite schema/rollup sources at ca58c031; exact links and design decisions
  are in docs/development/dashboard-metrics.md. No upstream code was copied.
- 2026-11-04: CPA management credentials use AES-256-GCM with a separately
  mounted 32-byte key. Quota windows remain per account and unknown values are
  preserved. OpenClaw exports attempt totals by route/model to private usage
  JSONL, independently of broadcast state. SQLite commits events/cursors
  atomically, deduplicates replay, and stores editable token-category prices.
  Metrics and ciphertext use host-backed storage; the master key stays separate.
- 2026-11-04: Passed all 20 Node 22 server tests, existing Chromium player
  regressions, new admin/viewer/guest metrics tests, token/price filters,
  quota/unknown displays, mobile layout checks, and encrypted credential save,
  reload, and removal. The image builds; isolated production startup and guest
  API denial pass. Key/log mount writes fail with EROFS. Python syntax,
  Compose validation, diff checks, changed-file line limits, and secret/size
  audits passed. No lint/typecheck scripts are configured for this JS service.
- 2026-11-04: Updated README, dashboard README, architecture overview, env
  example, deployment runbook, and reference notes. Runtime version unchanged.
  No live CPA management key was imported: the administrator enters it after
  deployment. Actual remaining quota is unverified until that setup. Jenkins
  deployment changes are prepared; this round's push needs owner approval.

- 2026-11-05: Diagnosed missing parent reply after a successful worker result.
  OpenClaw queued announcements accepted acknowledgments as completion and
  lacked model deadlines. Added final-result checks and bounded attempts,
  split the oversized delivery module, and passed 28 focused tests, full
  type-check, lint, and build. Recovered the saved result in local parent chat.
- 2026-11-05: Fixed colon-containing announcement IDs, added public reply
  generation metadata and one-time pending warnings, and used ASCII activity
  separators. All 28 dashboard Node 22 tests and real gateway reply/run-ID
  verification passed. Preserved concurrent UI changes, runtime mounts,
  environment, model order, recordings, and private payload boundaries.
  Runtime backups remain local.
- 2026-11-05: Finished the announcement rollout. Pending warnings no longer
  repeat when a fallback retry re-emits `model_start` for the same run ID;
  the pending-warning test covers the retry. Ran the Jenkins-equivalent
  `node --test server/*.test.js` in the dashboard image, committed as
  Nesbitt-bot, and pushed `ai-infra-v0` with owner authorization so Jenkins
  deploys it. Docs touched this round contain no server IPs or tunnel ports.

## 2026-11-06 — OpenClaw settings and scheduled tasks (0.2.9)

- Replaced the JSON-only config editor with grouped controls and synchronized
  UI/JSON tabs; added scheduled-task CRUD through a signed gateway device.
- Added prompt/model/schedule/time-zone/execution/delivery forms, paused jobs,
  conflict checks, responsive light/dark styling, and canvas URL rows.
- Verified 77 Node 22 tests and all Chromium suites, including new settings
  coverage. Live temporary disabled-task CRUD and stale-edit rejection passed;
  all nine original task configurations remained unchanged.
- Built and deployed the local 0.2.9 image with the standard helper; local and
  public health passed, unauthenticated task access returned 401. Existing
  host-backed state and the 0.2.8 rollback container were preserved.
- Fixed host backup-directory ownership after the prior root-created directory
  blocked deployment. No new dependencies, environment variables, or ports.
- Compose validation and diff whitespace checks passed. No secrets, generated
  binaries, or unrelated work staged; README and deployment docs match runtime.
- Local deployment only; no GitHub push or Jenkins build claimed.

## 2026-11-06 — Shared OpenCode coding harness

- Installed OpenCode 1.19.5 as a persistent user service with authenticated
  loopback HTTP and state under DockerVolumes. Verified npm archive SHA-512.
- Installed all six repository plugins with their shared libraries; configured
  the desktop default connection and opened the actual OpenClaw ACP session.
- Added the native ACP HTTP backend with persistent session mapping, progress,
  model/mode controls, resume, cancellation, and transcript-preserving close.
- Verified 11 backend tests, systemd unit validation, Python compilation, and
  live multi-tool turns using the existing OpenAI account through Responses.
  CPA routes were unavailable during setup; native OpenClaw model order stays
  unchanged. Optional Bark subscribers remain empty; no notifications sent.
- Live OpenClaw spawn and follow-up retained the same OpenCode session and
  recalled its previous verification token. The desktop showed both turns.
- Found and repaired OpenClaw webchat dropping ACP reply blocks in the sibling
  source checkout; its 14 focused tests, full type check, and app build passed.
- README, docs/readme, and deployment guide describe actual runtime and
  rollback. Credentials, personal state, generated binaries, and screenshots
  remain outside Git. No unrelated source or personal session history staged.
- The deployed webchat fix returned OPENCODE_DELIVERY_VERIFIED in both the
  gateway final event and chat.history. Gateway environment and mount identity
  checks passed; the prior container is retained. All nine schedules remain.
- Diff whitespace, changed-source line/size checks, and secret-path audit
  passed. No public push was requested.

## 2026-11-06 — Adapter execution access (0.3.0)

- Added `/adapters` with an administrator list editor for AstrBot group/sender
  execution access and an owner-DM toggle. The initial group list is empty.
- A shared private policy directory persists outside the checkout; PCP reads
  it read-only and reauthorizes execution per tool. Saves retain backups,
  reject stale edits and require distinct isolated group executors.
- All 79 server tests and the Chromium settings/adapter checks passed, including
  administrator/CSRF gates, group/member editing and mobile layout.
- Compose and the deployment helper carry the shared policy mount.
- Earlier settings/scheduler and OpenCode bridge commits remain preserved.
  GitHub publishing is blocked by unavailable credentials; no remote release
  or webhook deployment is claimed. Local rollout verification follows.

- Local rollout verified: dashboard 0.3.0 public/local health and anonymous
  adapter API 401; shared adapter-policy bind is writable only in the dashboard.
  PCP 0.4.0 app/broker and both channel plugins passed runtime checks.
  A local signed owner request executed `python3 -c "print(7*8)"` and correctly
  identified the attached blue image after multiple provider failures. No
  outbound channel message was sent. The group execution allowlist remains empty.

## 2026-11-08 — voice/action integration follow-up

- Adapter group saves now create restricted PCP-tool agents; group commands run
  in isolated per-chat containers and the live group list remains empty.
- Replaced the LKG placeholder with the safe read-only watchdog status record.
- 80 dashboard tests and Chromium adapter/settings checks passed.
- Session-manager module split and project-aware ID sync passed strict TypeScript,
  contract loading, stable-message replay and redaction checks.
- Restored the missing live avatar/cat/Circtime widgets on the existing recording
  through the authenticated controller API; public Chromium verified both canvases
  and the sandboxed embed with no page errors.
- Container recovery tests passed, and clean remote OpenClaw main was built,
  deployed, soaked and promoted. All evidence stays under DockerVolumes.

## 2026-11-08 — Canvas, avatar library, quota and Circtime

- Added separate Canvas panel, pointer move/resize/draw in the draft preview,
  avatar pack/state/blink controls, ZIP upload/remote import/download and immutable
  pack-state editing. Public agent scene discovery includes resource state names.
- Usage/CPA load checks share the bounded quota refresher; snapshots retain
  last-updated information on upstream failure. Metric widgets check immediately.
- Circtime checkout was clean before work; fetched and checked remote main.
  Fixed transparent embed backgrounds and added the 48-hour status palette.
- Server tests and focused new-feature Chromium checks passed; complete existing
  Canvas regression suite and final rollout verification are recorded below.
- Data, credentials, current live recording and existing state bind preserved.
  New packs live inside the backed-up state directory.

- Final verification: all 84 server tests passed. All Chromium suites passed
  (guest/admin playback, metrics, navigation, scene editing, live control,
  Canvas layouts, new pointer/avatar/quota features and scheduled-task settings).
  Production Node 22 Alpine image built successfully with normalized avatar
  imports. Circtime public embed checks confirmed black/white backgrounds.

- Production rollout: GitHub-triggered Jenkins #28 succeeded on main revision
  14c1f396a80ee86fc447dc0da8e6929988265b70. Public/local health and the
  installed stream-plugin/source comparison passed. The original live recording
  a6dc9887-8088-4989-ba23-89752fe15926 still contains avatar, cat and backdrop.
- Live CPA refresh succeeded and produced a current timestamped snapshot.
  Public browser checks found both visible canvases and the sandboxed Circtime
  iframe, no page errors, black dark-theme and white light-theme backgrounds.
- Added an adapter compatibility gate: selected group access cannot be enabled
  before PCP >=0.4.1 and the isolated executor are healthy. The live group list
  is unchanged. Focused adapter authorization/readiness tests passed.

## 2026-11-09 — Monochrome toggle and canvas focus (0.4.1)

- Fast-forwarded the clean Circtime checkout to merged upstream main 0048de9.
  Its running monitor still serves the same checked-out source and durable data.
- Root cause of the nonresponsive monochrome toggle: renderer iframe cache keys
  included path/theme but omitted monochrome. Include the mode so both enabling
  and disabling it update the existing iframe immediately.
- Preview pointer actions now take focus without scrolling before rebuilding
  the selected property/list views. Widget-list selection activates properties
  without focusing the first editor input; restored list focus prevents scroll.
- Added browser regressions for changing monochrome without changing theme,
  mobile selection/drag scroll stability, and active avatar properties. The old
  renderer failed the new monochrome check; patched checks and all 84 server
  tests passed. Existing layout data and live recording were left intact.

- Existing Canvas regression suite also passed (save/apply, keyboard controls,
  dark/light and 390 px). The Node 22 production image built successfully.
