# Dashboard development log

## 2026-11-04 — Public streams, playback, chat, and administration

Requested changes: reliable hover previews, guest viewing, selectable
recommendations, three screen modes, Casdoor avatars, OpenClaw live chat,
admin start/end controls, recordings, visibility, and recommendation scores.

### Root causes and implementation

- `public/app.js` originally hid the hover tooltip unless an event existed
  within two seconds of the cursor. Sparse logs left nearly the entire bar
  without previews. `public/player.js` now reconstructs the latest log frame
  at the selected time, with an explicit empty state before the first event.
- Guest initialization requested authenticated panel APIs in the same batch
  as player state; the first 401 redirected guests to sign-in. Guest playback
  now uses public broadcast/recording APIs; panel APIs remain protected.
- Avatar rendering only used the first character of the user's name; the
  OIDC callback discarded the identity provider's avatar. The callback now
  retains the avatar URL, and an authenticated server route fetches a bounded
  image from the configured issuer. Browser rendering uses that image with an
  initials fallback on an unavailable image.
- Removed the Download control. Added theater layout, viewport full screen,
  and the browser Fullscreen API, with visible exit controls and Escape.
- Replaced recommendation placeholders with selectable saved recordings.
  Admins can hide recordings or assign scores; visible recordings sort by
  descending score, then newest first. Private recordings remain readable by
  admins and absent from public catalog and direct playback access.
- Added a public stream store separate from private operational diagnostics.
  Administrators explicitly start/end a stream. Timed log and viewer-chat
  events append to durable NDJSON, while metadata persists atomically. Ended
  streams replay using the same `id`, `ts`, `t`, `source`, `level`, and `msg`
  envelope. `kind` distinguishes log/chat events and allows future canvas
  events without changing the recording envelope. Restarted live sessions
  are finalized as interrupted recordings.
- Added authenticated same-origin chat submissions. Viewer messages appear
  in side chat; the dedicated OpenClaw host speaks only through recorded main
  player log events. Responses are bound to the original stream, so late
  replies cannot enter a later recording. Chat is closed while offline.

### Verification

- Passed `npm test --prefix dashboard`: signed-token OIDC, protected admin
  mutations, public stream access, avatar fetching, authenticated chat,
  response placement, visibility, and recommendation metadata. Storage tests
  cover interrupted recording recovery, Unicode records crossing read blocks,
  pagination, ranking, and rejection of replies for an old stream.
- Passed the optional Playwright/Chromium check on an isolated fixture:
  guest player without a sidebar, mobile recommendations, sparse-timeline
  previews, log/chat replay, theater/viewport/display full screen, avatar
  image loading, admin Start/End, live chat, hiding, and recommendation score.
  The browser runner is `dashboard/scripts/browser-check.mjs`; Playwright was
  installed under `/tmp/agent-dashboard-browser`, outside production deps.
- Passed the same server tests inside the version 0.1.1 Node 22 image, Docker
  build, Compose config validation, JavaScript syntax checks, and
  `git diff --check`. No lint/typecheck scripts exist for this JS service.
- Configured an isolated OpenClaw `dashboard-host` with tools denied and
  memory search disabled. Validated the gateway configuration and observed
  dynamic reload without restarting other agents. A direct gateway request
  and the deployed live-chat route both produced a real assistant reply.
- Live verification on `https://live.trance-0.com` used a temporary Casdoor
  administrator. Start/End saved a 5.8-second recording containing the viewer
  message and real host reply. Guest SSE worked through the private FRP remote port.
  Chromium checked public guest playback, hover content, chat history, the
  real Casdoor avatar, and administrator controls. The avatar was fetched
  server-side from the issuer, then rendered through `/auth/avatar`.
- The verification recording was hidden with score 0 and retained for admin
  review. Its public event URL returns 404. The temporary account was deleted,
  its group memberships removed by Casdoor, and browser cookie snapshots were
  deleted. The stream was left offline for the owner's explicit Start action.
- Backed up the existing state volume and prior OpenClaw configuration under
  the private `~/.local/state/agent-dashboard/` directory. Retained the old
  versioned Docker image. Deployed `agent-dashboard-v0.1.1` using Compose,
  preserving the state volume and existing FRP mapping.
- Local evidence: `logs/dashboard-v0.1.1-live-20261104T155856Z.log`,
  `logs/dashboard-v0.1.1-guest-desktop.png`, and
  `logs/dashboard-v0.1.1-admin-desktop.png`. These are ignored operational
  artifacts and are not committed.

### Current limits

The player renders log text and timed chat; it does not render Live2D or canvas
commands yet. Recommendations use admin scores and viewer selection. Host
responses are serialized, have a five-second viewer cooldown, and time out
after 90 seconds. Sessions reset on service restart. Avatars are fetched from
the configured identity issuer only; external images use the initials fallback.
Large recordings are downloaded in pages before playback. The Jenkins
scaffold remains unused; this deployment uses local Docker Compose.


## 2026-11-04 — OpenClaw stream control and activity recording (0.1.2)

The 0.1.1 integration only recorded the public chat host's final HTTP response.
`server/broadcast-routes.js` required browser-admin sessions to start streams;
OpenClaw had no control tool and no lifecycle hook bridge.

Added an optional `dashboard_stream` tool in `openclaw-plugin/index.js` for the
trusted owner on the main agent. Its start/status/end requests use a separate
machine token and bind control to a hashed session reference. `server/openclaw-routes.js`
authenticates that token and records validated public lifecycle events. Session
ownership and recording IDs prevent takeover and late events entering a newer
stream. Duplicate event references are ignored.

Native agent/model/tool hooks now publish status, names, and durations without
private prompts or tool payloads. Only the session that starts a broadcast can
publish its assistant output as text. The public chat host remains tool-denied.
Existing chat replies retain their existing path and appear once.

Installed the plugin in the gateway's persistent configuration mount and pinned
its explicit load path. Plugin configuration caused the gateway to respawn;
the existing Docker `on-failure` policy left its clean exit stopped. Recovered
with the normal `docker start` operation while preserving mounts and policies.

Verification:

- Passed all four server tests locally and inside the Node 22 image, including
  `server/openclaw.test.js`: owner-only tool exposure, start/status/end,
  session ownership, recording attribution, deduplication, stale recording
  rejection, lifecycle recording, provider-error classification, and exclusion
  of private prompts/tool parameters/results/errors. Chromium guest/admin
  regression checks also passed.
- Installed plugin reports `status: loaded`, `hookCount: 6`, and tool
  `dashboard_stream`. Gateway config validation passed. The plugin has no
  external dependencies. Explicit plugin source and token paths are configured
  in the private gateway configuration.
- A real owner-agent request caused the model to invoke `dashboard_stream`
  and start **OpenClaw Live**. The persisted recording includes the
  stream-origin marker, tool completion, model milestones, and agent completion.
  Stream remained live through the plugin's subsequent gateway restart.
- A temporary ordinary Casdoor viewer sent a chat message into that stream.
  The archive contains one viewer chat, one host reply, and native agent start,
  model start/output, and agent-end events. The temporary account was removed.
  Evidence: ignored `logs/dashboard-v0.1.2-agent-start-20261104T161702Z.log`
  and `logs/dashboard-v0.1.2-chat-events.log`.
- The default main-agent provider returned an invalid thinking-block signature
  after its successful start-tool call. Its continuation could not produce a
  welcome; the separate public chat host responded normally. A temporary
  thinking override on the verification session did not resolve the provider
  history issue and was cleared. Global model/provider settings were preserved.
  Error-completed model hooks now render a warning without the raw provider
  error. The stream-control tool itself succeeded.
- Deployed `agent-dashboard-v0.1.2`, retaining the original volume, a private
  state backup, and the prior image. Public health and event playback passed;
  the service is left live at `https://live.trance-0.com`. Documentation and
  private config examples describe the new scoped token and plugin install.

The bridge records live lifecycle metadata from all agents while a stream is
active. Public assistant text is limited to the session explicitly starting
that stream; viewer-chat replies continue through the existing host response
path. It does not import private gateway history. Event delivery has a bounded
queue and timeout; disconnected events may be lost, with diagnostic warnings.


## 2026-11-04 — Jenkins webhook deployment, audience, and summaries (0.1.3)

- Root cause: no `agent-dashboard` job existed. `dashboard/Jenkinsfile` was an
  unused scaffold without `githubPush()`, used port 14141 instead of 14143,
  and its rollback lost runtime configuration. Replaced it with Pipeline-from-SCM,
  versioned images, Node 22 tests, isolated smoke check, cold state backup,
  checked deployment, rollback to the retained container, and installed-plugin
  synchronization. The job pulls the current feature branch from GitHub.
- Root cause: `server/broadcast-routes.js` used the SSE subscriber count as the
  watching count. `server/viewers.js` now deduplicates active connections by a
  signed HttpOnly browser-session cookie shared across tabs. Reconnects and
  multiple tabs count once, while independent browser sessions count separately.
- Root cause: `public/player.js` wrote Play/Pause text and considered a live
  following player paused. It now renders accessible SVG state icons and stops
  following immediately when Pause is pressed.
- Added owner-scoped `dashboard_stream` summary action and machine endpoint.
  Summary is persisted in live/recorded metadata, included in a timestamped log
  event, and displayed below the player. Public chat agents cannot modify it; trusted owner-facing main-agent sessions
  can summarize the current live stream without taking over its ownership.
- Live recording recovery now preserves the same recording across service
  deployment. Incomplete trailing writes are truncated before appending a
  recovery event; complete events, summary, start time, and session ownership
  remain intact. This avoids ending broadcasts on every Jenkins push.
- Existing named recording volume is retained; no database migration was
  needed. Private Jenkins env and backup files use the DockerVolumes layout.
- Prepared an isolated container checkout and a dedicated deploy key; its
  public key must be installed on GitHub to enable container-originated pushes.

Verification and deployment:

- Created `https://jenkins.trance-0.com/job/agent-dashboard/`, configured as
  `CpsScmFlowDefinition` for GitHub `ai-infra-v0`, script
  `dashboard/Jenkinsfile`, agent label `local-docker`, and GitHub push trigger.
  Jenkins declarative validation returned `Jenkinsfile successfully validated`.
- Pushed implementation commit `30d8ff1` to GitHub. The existing webhook
  delivered the real push event and Jenkins build **#1** completed **SUCCESS**
  with cause `Started by GitHub push by Trance-0`. Its checked-out revision
  exactly matched that commit. No manual build or synthetic webhook was used.
- Build #1 passed all five Node 22 tests and the isolated smoke container,
  backed up the recording volume, deployed
  `agent-dashboard:0.1.3-jenkins.1`, verified local/public health, and updated
  the installed OpenClaw plugin. Original stream ID
  `a6dc9887-8088-4989-ba23-89752fe15926` remained live across rollout.
- Live Chromium checks verified SVG Pause while live, SVG Play when paused,
  Go live, one audience member across two shared-cookie tabs plus a reload,
  a second audience member in an independent browser context, and disconnect
  cleanup back to the baseline. No browser errors were observed. Screenshot:
  ignored `logs/dashboard-v0.1.3-jenkins-live.png`.
- Invoked the installed OpenClaw `dashboard_stream` summary tool: description
  appeared on the public page and persisted with a summary-change log event.
  Tests also ensure a trusted owner can summarize an admin-started stream,
  without changing stream ownership or exposing controls to public chat.
- Retained durable NDJSON/metadata storage and rollback containers; a separate
  database container was unnecessary for these changes. Backups and private
  deploy env are outside SCM in the existing DockerVolumes layout.
- Prepared and fast-forwarded the container's isolated dashboard checkout from
  GitHub. A dedicated deploy key and pinned host key are configured locally.
  The owner explicitly deferred container GitHub write permission to a future
  test-account setup; no shared host private key was copied into the container.
- Evidence: ignored `logs/jenkins-agent-dashboard-1.log`. Final summary-scope
  correction and this verification record are pushed together for the next
  automatic webhook build, whose result will be checked before handoff.

## Shared file activity repair

The deployed dashboard had only its own data volume. OpenClaw's stream plugin
forwarded tool names over HTTP, omitting file arguments, so the player could
not show which file was being read. The plugin now writes allowlisted metadata
to daily shared JSONL files, and the dashboard tails those files through a
read-only bind mount. File paths are available at tool start and completion;
file contents, arbitrary arguments, and raw errors are excluded. Cursor state
lives outside the shared mount. Owner-session assistant text keeps the existing
HTTP authorization boundary.

Verified seven server tests, an isolated read-only container, the public HTTPS
feed, and Chromium rendering of real OpenClaw file-read events. The existing
live recording ID survived deployment. The gateway's CPA Claude signature bug
was fixed separately in its provider capability registry and checked with two
real turns, including a persisted-history follow-up. Current runtime is a
local repair; Jenkins retains its GitHub checkout workflow and needs a push of
this commit before its next rollout can retain the new integration.


## 2026-11-04 — Correct CPA models, fallback verification, and error replies (0.1.4)

- Verified the dashboard's actual runtime gateway address, host network, and
  bearer credential match the local `openclaw-openclaw-gateway-1` container.
  The stream was connected; the model configuration selected older Claude
  models and OpenAI/Codex GPT fallbacks rather than the requested CPA chain.
- Set both the gateway default and `dashboard-host` model order to
  `cpa/claude-opus-5-5-high` → `cpa/gpt-6-astra` → `openai/gpt-6-astra`.
  Removed all five CPA Gemini model definitions and their aliases; checked
  cron and explicit session overrides. Private pre-change configuration and
  generated registries were backed up. Existing transcripts remain intact.
- CPA's live catalog lists both requested models. Opus 5.5 returned HTTP 503
  `auth_unavailable`; CPA GPT-6 Astra returned a normal answer. Two real
  gateway turns in the same saved conversation failed over to CPA GPT-6 Astra.
  Its session metadata and gateway fallback decision log confirmed the actual
  provider/model. The official OpenAI GPT-6 Astra endpoint also returned a
  successful response. CPA upstream authentication remains required for Opus.
- `server/chat.js` trusted any nonempty HTTP 200 completion as a host reply.
  OpenClaw's compatibility endpoint can wrap `LLM request rejected` in such a
  response. `server/gateway-response.js` now rejects those failure completions,
  and the chat path records a clear warning without raw provider error details.
- The legacy `before_agent_start` hook runs during model selection and prompt
  preparation. Replaced it with `before_model_resolve` to avoid duplicate starts
  for one attempt. Both file and HTTP activity records now carry actual
  provider/model and gateway run IDs. Replies retain the completion ID so the
  selected fallback can be traced from the stream.
- All ten server tests passed, including regression tests for HTTP-200 failure
  handling, one start hook per attempt, provider/run metadata, shared activity
  file handling, and the existing stream/auth/storage checks. Native config
  validation passed. Deployment and post-restart live checks follow via Jenkins.
- Local probe evidence is retained in ignored `logs/cpa-model-probes.log` and
  `logs/openclaw-cpa-fallback-check.log`.


Post-restart verification:

- GitHub push `6f95ef2` triggered Jenkins build #4, which passed all ten Node 22
  tests, smoke checks, backup, deployment, and plugin update. Dashboard and
  gateway were both restarted after the final model configuration was saved.
- Resolved default and dashboard-host order matched CPA Opus 5.5 → CPA GPT-6
  Astra → official OpenAI GPT-6 Astra. CPA Gemini was absent from canonical
  definitions/aliases and all generated agent registries after restart.
- Two authenticated chat requests on the existing public recording and its
  original conversation history produced normal CPA GPT-6 Astra answers. Each
  answer's `runId` matched a successful `model_output` record for provider
  `cpa`, model `gpt-6-astra`. Neither turn used Gemini; repeated legacy start
  events were absent. The temporary Casdoor viewer was removed afterward.
- Chromium confirmed `cpa/gpt-6-astra` events render in the public live player.
  The original recording ID and prior history were preserved. Evidence is
  retained in ignored `logs/dashboard-v0.1.4-live-cpa.log`,
  `logs/dashboard-v0.1.4-model-verification.json`,
  `logs/dashboard-v0.1.4-cpa-visible.png`, and
  `logs/jenkins-agent-dashboard-4.log`.
- CPA Opus 5.5 remains unavailable with upstream HTTP 503 `auth_unavailable`.
  Its configured position is primary, but current successful answers use CPA
  GPT-6 Astra. Official OpenAI GPT-6 Astra was directly probed successfully and
  is the final configured fallback. No claim is made that unavailable Opus
  produced a reply.

## 2026-11-05 — Player controls: icons, play state, auto-hide, and speed (0.1.6)

### Root causes and implementation

- Play/pause never changed icon: `player.js` set `.hidden` on the two `<svg>`
  icons, but `hidden` is an `HTMLElement` property; on `SVGElement` it is only
  an expando and never reaches the attribute the `[hidden]` CSS rule matches.
  The pause icon kept its markup `hidden` attribute forever. Render now toggles
  the attribute, and play state comes from one `isPlaying()` (live following
  counts as playing) shared by click, the `k`/Space shortcut, end-of-replay,
  and live catch-up. The old browser check asserted the play icon after
  pausing, which was always true, so it never caught this.
- Missing icons: commit `2e0d8af` replaced the menu icon with the text "Menu"
  inside the 40 px round `icon-btn`, and the screen-mode controls were only
  ever text pills. All player controls are now inline-SVG icon buttons in the
  existing stroke style, with `aria-label` and tooltip (including shortcuts).
  Web full screen and full display swap to exit icons via `aria-pressed`;
  their labels describe the next action. They were already shown to guests;
  the menu button stays members-only because the sidebar it toggles is.
- Auto-hide: controls moved into an overlay (`#player-chrome`) at the bottom of
  the screen surface. While playing, they hide after 2.5 s without pointer or
  keyboard activity over the player, or 1 s after the pointer leaves, leaving
  a thin progress line (and no cursor in web/full display). Paused playback,
  an open speed menu, keyboard focus on a control, or scrubbing keep them up.
  The rule is the pure `controlsShouldHide()`; transitions are disabled under
  `prefers-reduced-motion`.
- Speed: a menu offers 0.25x–2x (`Shift+<`/`Shift+>` steps). Recorded time
  advances by `elapsed × rate` (`advanceTime()`), which drives both event
  replay and the progress bar. Live following is fixed at 1x and the control
  is disabled; rewinding a live stream may use any rate, and catching up with
  the live edge rejoins live at 1x. The choice persists in `localStorage`
  (`agent-dashboard.playbackRate`), with invalid values treated as 1x.
- Shortcuts `t`, `w`, and `f` toggle theater, web full screen, and full display
  while focus is inside the player. Server auth and APIs are unchanged.

### Verification

- `node --test server/*.test.js` in the Node 22 dashboard image: 23 tests
  passed, including the new `server/player.test.js` (rate normalization and
  stepping, `elapsed × rate` replay timing, auto-hide rules).
- The Playwright/Chromium check (`scripts/browser-check.mjs`, run inside the
  `mcr.microsoft.com/playwright:v1.58.2-noble` image because the host's Node 18
  stalls in the auth fixture) passed: icons and labels for guest and admin,
  play/pause icon on click, `k`, replay end, live pause, and live catch-up;
  speed menu, persistence across reload, 1x lock while live, and a 2x replay
  covering 3–5 s in 2 s; auto-hide while live, kept by keyboard focus,
  hidden after the pointer leaves, and never while paused. With the browser
  check enabled the auth test's timeout is 180 s instead of 60 s.

## 2026-11-05 — Theme, sidebar widgets, and in-browser admin toggles (0.1.7)

Owner report: "dashboard theme change is not working (no widget on sidebar,
and the admin option is not working as well)." Reproduced against the
isolated OIDC fixture as viewer and admin (desktop and 390 px).

### Root causes

- Theme: the Settings panel was a placeholder. `fieldInput()` rendered the
  theme select, autoplay checkbox, and volume field with no handlers, nothing
  read or stored them, and `styles.css` had only dark variables, so selecting
  "light" changed nothing. Its status card hard-coded "dark".
- Sidebar: `renderSidebar()` ignored each panel's self-described `icon` and gave
  every item the same three-line glyph (which also looks like the menu icon),
  and "Watch" had no icon at all. Collapsed by the menu button, the 72 px rail
  showed a column of identical glyphs with no labels or tooltips, so no panel
  was recognisable. The footer `#uptime-chip` was never populated (an empty
  pill), and there was no theme control anywhere in the chrome. The viewer
  menu also listed "OpenClaw config", whose routes are admin-only (the panel
  lacked `adminOnly`), and disabled panels stayed listed for members.
- Admin option: `POST /api/panels/:id/toggle` required an admin session and the
  `DASHBOARD_TOKEN` bearer. The browser has no way to hold that token (in the
  browser it returned 401), and there was no toggle control in the UI, so
  admins could not enable or disable panels at all. Start/end stream,
  recording moderation, the config editor, and the metrics panels worked.
- Fragility: `wireChrome()` ran only after the broadcast, recording, and
  catalog requests succeeded, so any of those failing left the menu button
  and screen-mode buttons dead.

### Changes

- `public/theme.js` (blocking classic script in `<head>`, before the
  stylesheets) applies the stored preference to `<html data-theme>` before
  first paint; `system` follows `prefers-color-scheme` live. Stored per
  browser in `localStorage` (`agent-dashboard.theme`); never sent to the
  server. A top-bar button (all users, including guests) cycles
  system -> light -> dark, and the Settings select stays in sync (also across
  tabs). `styles.css` gains light variables; the player surface, overlay
  controls, and timeline preview stay dark like a video. Hard-coded colours in
  the config editor and metrics styles now use theme variables.
- Settings: theme and "Autoplay recordings" are live browser-scope controls.
  Autoplay off opens recordings paused at the start; live streams always
  follow the live edge. The fake "Alert volume" field was removed (no alerts
  exist). Other panels' settings rows (endpoints, config path) render as
  read-only values with a note instead of editable-looking inputs.
- Sidebar: per-panel icons (bot, build, chart, config, claw, settings), a
  Watch icon, tooltips on every item for the rail, a populated uptime chip,
  `aria-expanded` on the menu button; on narrow screens the menu only slides
  the sidebar in/out and choosing a panel closes it. Chrome is wired before
  any data request. `openclaw-config` is `adminOnly`; members no longer see
  disabled panels (admins see them with an "off" badge).
- Admin toggles: the route now accepts admin session + same-origin
  `X-Dashboard-Request: 1` (as every other admin mutation), or admin session +
  `DASHBOARD_TOKEN` bearer for automation. A present but wrong bearer is still
  rejected with 401. `live-stream` cannot be disabled. Admins get a
  "Panel enabled" switch at the top of each panel; a disabled panel shows a
  notice instead of its data. No other auth changed.

### Verification

- `node --test server/*.test.js` in the Node 22 dashboard image: 26 tests
  passed (new `server/theme.test.js`: preference resolution, persistence, OS
  tracking, applied-on-load, autoplay default). `auth.test.js` now asserts the
  header toggle path, cross-origin and viewer denial, wrong-bearer rejection,
  `live-stream` refusal, member menu hiding of admin-only/disabled panels.
- Chromium (Playwright image, isolated fixture): existing `browser-check.mjs`
  and `metrics-browser-check.mjs` passed; new `ui-browser-check.mjs` passed —
  guest system theme for both OS schemes, top-bar cycling, theme on `<html>`
  before `<body>` parses after reload, dark player in light theme; viewer
  sidebar lists exactly Watch/AstrBot/Build & LKG/OpenClaw/Settings with
  distinct icons, uptime chip, 72 px rail with tooltips, mobile slide-in and
  close-on-select; settings select/top-bar sync, persistence, autoplay off;
  read-only deployment settings; admin sidebar lists all eight items and an
  in-browser toggle (no bearer) disables Build & LKG, removes it from a
  viewer's sidebar, and re-enables it; config editor loads.


## 2026-11-05 — Missing parent reply after worker completion

The worker represented by the reported elapsed-time events completed its tools
and wrote a final 703-character GPT-6 Astra result. The next agent/model start
belonged to its parent announcement, which retried unavailable CPA Opus and
stopped making visible progress. The gateway stayed alive and did not suffer
an OOM. The worker's saved result remained intact.

The parent announcement recovery path had two defects in OpenClaw:
`src/agents/subagent-announce.ts` submitted queued recovery without
`expectFinal`, allowing an accepted acknowledgment to remove the queue item;
and it sent no model timeout, inheriting a much longer agent execution budget
than its 90-second announcement RPC. Extracted the delivery functions into
`subagent-announce-delivery.ts` to keep both files below the source line cap.
Queued and direct paths now check final results and reserve bounded time for
the configured fallback models. A rejected or aborted result stays retryable.

The dashboard also dropped colon-containing announcement IDs through an
identifier regex. It now preserves validated long announcement IDs, records
reply-generation metadata without private text, warns once when an announcement
has no result after 90 seconds, and uses ASCII separators in new activity rows.
Persisted event text had valid UTF-8; the reported replacement characters were
not present in stored events. Raw logs and private session outputs remain private.

Recovered the worker result in the original local OpenClaw parent conversation,
with the unfinished scheduling step clearly marked. No task steps were invented
or marked complete. Preserved the original transcript and runtime snapshots.

Validation: 28 OpenClaw announcement tests, full TypeScript check, targeted
lint/format, and the application build passed. The queued-ack regression failed
before the fix and passed after it. All 28 dashboard Node 22 tests passed.
A real isolated parent announcement returned a final CPA GPT-6 Astra response
in 6.5 seconds. A second live check verified the same gateway run ID and
reply-generated metadata in the public stream. External message delivery was
disabled for these checks. Evidence is retained under ignored
`logs/announce-postfix-live.log`, `logs/announcement-final-live.log`, and
`logs/openclaw-announcement-regression.log`.

Applied this repair to the currently running services while preserving newer
concurrent dashboard releases, all mounts, environment, and model order. Prior
containers/images are retained.

Follow-up (same day): a fallback retry re-emits `model_start` with the same
announcement run ID, which reset the pending timer and could warn again. The
reader now keeps the first start per run ID, and the pending-warning test
covers a retry. The owner authorized the source rollout: the dashboard change
ships through the `agent-dashboard` Jenkins job on `ai-infra-v0`, and the
OpenClaw source commit was pushed to its private origin.
## 2026-11-05 — Grouped tabbed pages and a real Settings page (0.1.8)

Owner request: merge the manager panels into grouped sections with tabs and
replace the "terrible" settings UI with a proper Settings page.

### Changes

- Registry: `GROUPS` (`live`, `openclaw`, `usage`, `adapters`, `builds`,
  `settings`) plus per-panel `group`, `order`, and `tabs` metadata. Panel IDs,
  soft toggles, admin-only gates, and data routes are unchanged.
  `GET /api/panels` adds `groups`, listing only groups that contain a panel the
  viewer can see; guests still see only Live.
- Sidebar: one item per group (Live, OpenClaw, Usage, Adapters, Builds,
  Settings) with distinct icons. A group page has a keyboard-accessible tab bar
  (`role=tablist`, arrow/Home/End keys); pages are linkable as `#group/tab`
  and old `#panel-id` links open the owning group tab. Each tab keeps the
  admin "Panel enabled" switch of the panel that owns it.
- OpenClaw: Status (gateway health, agents with model order primary →
  fallbacks from the mounted `openclaw.json`, IDs and model IDs only), Backends
  (provider and env var names), Config (existing admin editor, now
  `public/config-editor.js`).
- Usage: new admin-only `usage-summary` panel and
  `GET /api/admin/metrics/summary` — pooled Codex 5-hour and weekly remaining
  percentages with reset countdowns (`y h z m`, `x d y h z m`), "n of m
  accounts", and token totals for today (UTC), 7 days, and 30 days. CPA quota
  and Token metrics are the existing panels with distinct icons. CPA window
  parsing now keeps `limit_window_seconds` so windows are classified by length
  (`server/metrics/pool.js`). The single-flight quota refresh moved to
  `server/metrics/quota-refresh.js` so it can be shared.
- Settings: cards for Appearance (theme, motion: system/reduce/full) and
  Playback (autoplay, playback speed), all per browser. Motion is resolved by
  `public/theme.js` into `<html data-motion>` before first paint; CSS now keys
  off that attribute instead of the media query, so the override wins. The
  speed select and the player's speed menu share `agent-dashboard.playbackRate`.
  Admins get a Panels card with every panel's switch (via `setPanelEnabled`);
  the Settings page stays reachable for admins even when disabled for members.
- `public/app.js` split: `api.js` (helpers), `nav.js` (groups/tabs),
  `settings-page.js`, `usage-summary.js`, `config-editor.js`; styles in
  `pages.css`.

### Verification

- `node --test server/*.test.js` in the 0.1.7 dashboard image with server,
  public, and openclaw-plugin bind-mounted (as the Jenkinsfile does): 33 tests
  passed (28 before this round). New tests: `registry.test.js` (grouping, ordering, tab
  defaults, invalid group/tab rejection), `pool.test.js` (window
  classification by length with swapped labels, equal-weight mean, earliest
  future reset, n of m, no labels, countdown/token formats), theme motion
  override, and `auth.test.js` group/tab lists for members and admins, the
  summary route's 401/403, and the agent table carrying no secrets or paths.
- Chromium (Playwright image, isolated fixture): `browser-check.mjs`,
  `metrics-browser-check.mjs`, `ui-browser-check.mjs` (updated for group
  navigation), and the new `pages-browser-check.mjs` passed.

## 2026-11-05 — Stream scenes phase A: renderer, widgets, admin editor (0.2.0)

Implements `ai-platform-design/stream-scenes.md` phase A with the owner's
section 8 decisions plus the requested admin canvas editor; section 10 of the
design records the implementation and where it deviates.

### Changes

- Shared pure modules in `public/scene/`: `schema.js` (one validator for
  every caller), `reduce.js` (deterministic fold and client checkpoints every
  250 events), `derive.js` (avatar expression and cat pose as functions of
  state and t), `format.js`.
- Renderer (`renderer.js`): a letterboxed 16:9 stage over the player; text,
  metric, clock, and image widgets in the DOM (textContent only); avatar and
  cat on canvases in one 30 fps requestAnimationFrame loop that runs only while
  visible. The witch frames are vendored as `public/scene/assets/witch-*.<sha256-8>.svg`
  (owner's v3.1 art; generator and notes stay local) and drawn by a pluggable
  avatar renderer (`avatar.js`). The cat (`cat.js`) is our own canvas drawing
  in the same navy-line, flat, hard-shadow style.
- Player: folds events into a `SceneTimeline` on load and on every live event;
  metric ticks are hidden from the log; `displayTime()` interpolates between
  ticks for animation. Old recordings have no widget events and render as before.
- Editor (`editor.js`, `editor-popups.js`), admin only, toggled by Edit scene:
  draw a rectangle then pick a type; left-click menu with Edit properties
  (form generated from the schema), Create new, Duplicate, Bring forward,
  Send back, Delete; drag, corner resize, arrow nudge (one change per burst),
  Delete, Esc, Ctrl/Cmd+Z undo. Player controls step aside while editing.
- Server: `server/scene/store.js` (versioned saved layout and image allowlist
  under `/app/data/scene/`), `service.js` (operations, live-scene tracking,
  opening layout on stream start, rate limits), `bridge.js` (pooled metric
  values, one event per refresh, 5-minute CPA refresh while a CPA widget is
  live, last value kept on failure), `routes.js` (admin and OpenClaw APIs,
  CSP). Recorded `t` is now clamped so it never decreases. `/scene/assets/`
  is served immutable. Settings gains Scene defaults (allowlist, reset).
- Safer choices: OpenClaw gets no bulk layout replace; metrics and CPA
  background refresh run only while a metric widget is live; admin
  `PUT /api/scene/layout` changes only the saved layout; the offline stage is
  empty (scenes come only from recorded events).

### Verification

- New tests: `scene-reduce.test.js` (no-mutation reducer, ignored unknown
  kind/op/sv, seek from checkpoints == fold from zero at random probes
  including a backwards clock step, identical state and pictures at 0.25x–2x,
  avatar think/talk/blink/sleepy, cat paws and sleep), `scene-schema.test.js`
  (unknown types/fields/prototype keys, ranges, bidi text, oversize, allowlist
  prefix matching, CSP, editor rectangles), `scene-routes.test.js` (admin
  401/403/cross-origin 403, offline layout edits and opening events, live
  recording and fold equality, OpenClaw wrong token 401, admin-started or other
  session 409, malformed 400, layout untouched, 429 rate limit, metric pooling
  and publishing), and `auth.test.js` scene gates, CSP header, and immutable
  asset caching through the real session pipeline.
- `scripts/scene-browser-check.mjs` passed alongside the four existing checks
  (results and counts in the round report).

### 0.2.1 follow-up

Production check after the 0.2.0 deploy found a stream that had been live
since before the upgrade. `SceneService` (`server/scene/service.js`) opened the
saved layout on any `status` notification for a live stream without widget
events, so the next summary update (`BroadcastStore.summarize` notifies
`status`) would have injected the avatar and cat mid-stream. The opening now
runs only when the active recording ID changes from what the service last saw;
a recovered or pre-existing stream is left alone. Regression test:
`scene-routes.test.js` "a stream recovered after a restart is not given an
opening scene later".

## 2026-11-05 — Scene embed widget for the circtime uptime radar (0.2.2)

Owner request: an `embed` widget for a same-origin HTML page, first the
circtime uptime radar for AI-infra health.

- `public/scene/schema.js`: type `embed` with `src` (must be one of the
  server's embed paths, passed to the validator as `embeds`) and `opacity`
  (0.05–1, default 0.3); default rect is the whole stage at z 0. The built-in
  layout includes it as `backdrop` when an embed is served.
- `server/index.js`: `/embed/circtime/` serves `CIRCTIME_EMBED_DIR` read-only
  (static, no dotfiles, own CSP with `frame-ancestors 'self'`); any other
  `/embed/` path is 404. The dashboard CSP now has `frame-src 'self'`.
  `scripts/deploy.py` mounts `CIRCTIME_EMBED_HOST_DIR` when it has `index.html`.
- Renderer: embeds go on a new back layer (`.scene-back`, z-index 0) below
  the log, in `<iframe sandbox="allow-scripts">` with `pointer-events: none`;
  the iframe is never re-appended (that would reload it). The theme rides on
  the URL and later changes arrive by `postMessage` without a reload. In the
  editor the embed joins the stage so it can be selected; dragging over an
  unselected full-stage backdrop still draws a new widget.
- Choice: no `allow-same-origin`. The page gets an opaque origin and cannot
  read dashboard cookies, storage, or APIs. If circtime needs same-origin JSON,
  that will be served as static files under `/embed/circtime/` and decided
  when its build contract is known (CORS-mode loads from an opaque origin do
  not pass today).
- Tests: validator allowlist (other paths, external and protocol-relative
  URLs, traversal, missing config), backdrop defaults, embed CSP; API create at
  z 0; real-pipeline route checks (200 with embed CSP, 301 to the trailing
  slash, other paths 404, traversal and dotfiles refused, `frame-src 'self'`);
  browser check: back layer below the log, full stage, opacity 0.3,
  `sandbox="allow-scripts"`, theme by URL and by postMessage without reload,
  log text over the embed selectable and copyable, no CSP violations.
- Fixed `package-lock.json`: the 0.2.1 version bump also rewrote the
  `forwarded` dependency's `version` field (0.2.0 to 0.2.1). Its `resolved`
  URL and integrity always pointed at 0.2.0, so installed images were correct;
  the field is restored.

## 2026-11-05 — circtime embed enabled (0.2.3)

- Contract from the circtime deployment: static Vite build at
  `/home/motuariki/Documents/DockerVolumes/circtime/dist`, entry
  `?embed=1&theme=`, relative JSON (`circtime-config.json`,
  `uptime-history.json` once, `uptime-latest.json` every 60 s),
  `circtime-theme` messages checked against `parent_origin`, module scripts.
- `server/scene/embed-static.js` replaces `express.static` for this path:
  CORS `*` for GET/HEAD only (405 otherwise), `no-cache` + ETag for JSON/HTML,
  immutable hashed assets, brotli/gzip via `node:zlib` cached by size and
  mtime, trailing-slash redirect, dotfile/traversal refusal. Kept the sandbox
  without `allow-same-origin`; the CORS route works for module scripts and
  fetches from the opaque origin (verified in Chromium with the real build).
- `embedPaths` requires `index.html` in the directory, so an empty mount point
  keeps the route off. `deploy.py` and `compose.yaml` mount the default host
  path read-only; a missing build skips the mount with a warning.
- Renderer: iframe src `?embed=1&theme=<resolved>&parent_origin=<origin>`;
  theme changes post `{ type: "circtime-theme", theme }`.
- circtime offers no frame-rate option (only React's internal scheduler
  knob), so it runs at full rate while visible; noted, not changed.
- Tests: `auth.test.js` fixture now follows the same contract (module script,
  relative JSON); route checks for CORS, credentials absence, br/gzip, cache
  headers, 304, 405, redirect, traversal, dotfiles. The scene browser check
  asserts embed mode, a rendered canvas, CORS loads of config/history/JS from
  origin `null`, theme by URL and by message without reload, selectable and
  copyable log text over the embed, and no CSP violations. On the host it also
  ran against the real circtime build (`DASHBOARD_CIRCTIME_DIR`).


## 2026-11-05 — CPA pooled quota: stale 5-hour windows (0.2.4)

Owner report: an account with no usage in its weekly window could still show a
stale 5-hour value in the pooled quota.

- Root cause: the pool, the Usage Summary, the public metric values, and the
  CPA tab all read the stored snapshot verbatim. Nothing ages a snapshot
  between refreshes, and nothing ties the 5-hour window to the weekly window
  (every 5-hour request also counts toward the week).
- Real data (stored snapshot read on the host, labels not printed): 3 Codex
  accounts and 1 Antigravity account with an error. The snapshot was 12 minutes
  old and **all three Codex 5-hour reset times had already passed** (8–9
  minutes earlier), reporting 72%, 0%, and 0% remaining. No account showed an
  unused week; one weekly window was exhausted (0% remaining) and two were at
  about 30%. So the case the real data shows is the passed reset; the unused-week
  case did not occur in that snapshot.
- Fix: `server/metrics/quota-normalize.js` (`normalizeQuota`) is the one shared
  read-time normalization: passed resets count as reset (100% remaining, reset
  unknown) until the next refresh, and an unused Codex week makes its 5-hour
  window unused. `poolCodex` and the refresher's `snapshot()` (the CPA tab and
  the metric bridge) both go through it. The CPA tab notes corrected windows
  and the value the snapshot reported. `windowClass` moved to
  `server/metrics/window-class.js` (re-exported by `pool.js`).
- Tests (`server/pool.test.js`): the unused-week rule on the normalized
  snapshot, the pool, the public `cpa.codex.5h` value, and the refresher's
  snapshot; the passed-reset rule on the real snapshot's shape; boundaries
  (reset exactly now, future reset, unknown remaining), idempotence, and
  the stored snapshot staying unchanged.
