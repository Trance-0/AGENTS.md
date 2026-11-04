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
  message and real host reply. Guest SSE worked through remote FRP port 6018.
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
