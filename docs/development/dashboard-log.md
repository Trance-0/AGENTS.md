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
