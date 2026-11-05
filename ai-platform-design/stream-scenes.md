# Design: stream scenes, widgets, and avatar events

As of 2026-11-05. Status: owner decisions recorded in section 8; phase A
implemented in dashboard 0.2.0 (section 10 records how it differs from the
proposal). Builds on dashboard
0.1.5 (`dashboard/`) and assumes the in-flight player fixes land first: a
correct play/pause icon, control icons, auto-hiding controls with a thin
progress bar, and a playback-rate control. "Current" below means what the code
on `ai-infra-v0` does today. Assumptions and unverified claims are marked.

## 1. Goals, non-goals, constraints

Goals:

- A stream can show **scenes** (layouts and backgrounds), **overlay widgets**
  (bongo-cat, CPA quota, next reset, total tokens), a **Live2D avatar** with
  triggered motions and expressions, **presents/gift effects**, and **media**.
- These are recorded **only as log events** in the existing NDJSON recording
  and drawn in the browser. Live and replay use one renderer. Replay supports
  seeking, every playback rate, and hover previews.
- Old recordings play exactly as they do now.

Non-goals:

- No server-side rendering, video encoding, or storage of video, audio, or
  frame captures.
- No arbitrary HTML, JS, CSS, or URLs taken from events. No user-uploaded assets.
- No general-purpose scene editor. Scenes are a small fixed catalog in the repo.
- No new real-time transport. The existing SSE `/api/stream` and paginated
  `/api/recordings/:id/events` stay as they are.

Constraints:

- **Storage.** Event bytes per hour must stay in the low-MB range (section 4).
- **Public audience.** Guests can watch the live stream and any visible
  recording without signing in (`broadcast-routes.js`: `/api/stream`,
  `/api/recordings`). So **every recorded event is public, permanently**, unless
  an admin hides the recording. Hiding does not redact single events.
- **Roles** (from `docs/deployment/dashboard.md` and `server/index.js`):
  - Guests watch.
  - Signed-in `app-agent` members can also chat.
  - `admin-agent` users start and end streams and moderate recordings.
  - Machine producers (the OpenClaw plugin) use the separate stream bearer token.
- **Privacy.** Today the metrics docs say "Metrics never enter the public stream
  feed", and the CPA and usage APIs are admin-only (`server/metrics/routes.js`).
  Public metric widgets therefore change policy. They show only aggregates the
  owner approves, rounded, with no account labels, file names, emails, keys, or
  costs unless approved. Admin-only information never goes into an event.
- **Platform rules** (`AGENTS.md`, `ai-platform-design/design.md`):
  - Minimal dependencies.
  - Files stay under about 500 lines, with a hard limit of 1000.
  - Error messages state the consequence, module and process, and cause.
  - No secrets or network details in the public repo.
  - Schema changes are additive only, so an older image can still run on newer data.

## 2. Event model

### 2.1 Current envelope (fact)

`BroadcastStore.publish` (`server/broadcast.js`) writes
`{ ...payload, id, recordingId, ts, t, kind, source, level, msg }`. The
envelope fields come last, so a payload cannot override them.

- `id` is the per-recording sequence number (`eventCount`), assigned by the server.
- `t` is seconds since `startedAt`.
- `kind` defaults to `"log"`. Chat uses `"chat"`.
- Each event is appended and fsynced, then the metadata JSON is rewritten and
  fsynced, before the event is broadcast. That is two fsyncs per event.

The player treats every event that is not chat as a log line (`player.js`
`render`, `previewAt`). Progress-bar marks are drawn only for `warn` and worse.
Recording metadata already has `schemaVersion: 1`.

### 2.2 Scene-class envelope (proposal)

New kinds: `scene`, `widget`, `avatar`, `effect`, `media`. They reuse the
envelope and add:

| Field | Type | Rule |
|---|---|---|
| `sv` | int | Scene schema version, starting at `1`. The renderer ignores a `sv` it does not know. |
| `op` | enum per kind | Only allowlisted operations (below). |
| `target` | string `^[a-z0-9_-]{1,32}(:[a-z0-9_-]{1,32})?$` | Slot or instance, e.g. `cpa`, `bongo`, `main`. |
| `data` | object | Validated per (`kind`, `op`) against a closed field list. Unknown fields are rejected. |
| `eventRef` | string | Idempotency key from the producer. It already exists on OpenClaw events. |
| `msg` | string, max 200 | Required human-readable caption, so log, hover, and old players still show something meaningful. |

Limits:

- The whole serialized event must be at most **2 KiB**. The current JSON body
  limit is 16 KiB (`express.json({ limit: "16kb" })`).
- `data` is at most 2 levels deep.
- Strings have per-field maximum lengths.
- Numbers must be finite and within a range.
- Assets, media, motions, and expressions are referenced **by ID from the
  manifest**, never by URL.

Old players render these events as log lines showing `msg`. That is acceptable
for compatibility. The new player hides `widget` ticks from the log and shows
the other kinds as compact captions.

### 2.3 Operations and examples

**scene**: `set` (layout plus background), `snapshot` (keyframe written by the server).

```json
{"kind":"scene","sv":1,"op":"set","target":"main","data":{"layout":"focus-log","background":"bg-night@3f9c"},"eventRef":"admin-7d1e","source":"admin","level":"info","msg":"Scene changed: focus log over night background."}
```

```json
{"kind":"scene","sv":1,"op":"snapshot","target":"main","data":{"upTo":4120,"state":{"layout":"focus-log","background":"bg-night@3f9c","widgets":{"cpa":{"visible":true,"value":{"label":"Claude 5h","remainingPercent":62,"resetsAt":1762318800000}}},"avatar":{"model":"host@a1b2","expression":"smile"}}},"eventRef":"snap-4120","source":"dashboard","level":"info","msg":"Scene checkpoint."}
```

**widget**: `show`, `hide`, and `set` (latest value wins).

```json
{"kind":"widget","sv":1,"op":"set","target":"cpa","data":{"label":"Claude 5h","remainingPercent":62,"resetsAt":1762318800000},"eventRef":"cpa-1762300000","source":"dashboard","level":"info","msg":"Quota widget: Claude 5h 62% remaining, resets 14:00 UTC."}
```

```json
{"kind":"widget","sv":1,"op":"set","target":"tokens","data":{"scope":"stream","tokens":1840000},"eventRef":"tok-1762300060","source":"dashboard","level":"info","msg":"Token widget: 1.84M tokens this stream."}
```

```json
{"kind":"widget","sv":1,"op":"show","target":"bongo","data":{"corner":"bottom-right","skin":"bongo@9e0a"},"eventRef":"admin-81aa","source":"admin","level":"info","msg":"Bongo-cat widget shown."}
```

**avatar**: `load`, `expression` (persistent), `motion` (transient), `unload`.

```json
{"kind":"avatar","sv":1,"op":"motion","target":"host","data":{"motion":"wave","durationMs":2400},"eventRef":"oc-5f2c","source":"openclaw","level":"info","msg":"Host waves."}
```

**effect**: `gift` and `burst` (both transient). `seed` makes particle layouts deterministic.

```json
{"kind":"effect","sv":1,"op":"gift","target":"stage","data":{"gift":"star-shower@c41d","from":"Viewer","durationMs":3000,"seed":40961},"eventRef":"gift-2e90","source":"viewer","level":"info","msg":"Viewer sent a star shower."}
```

**media**: `play`, `pause`, `stop`. `offsetMs` is the position in the media
when the event happens.

```json
{"kind":"media","sv":1,"op":"play","target":"main","data":{"media":"intro-clip@77ab","offsetMs":0,"volume":0.6},"eventRef":"admin-02cd","source":"admin","level":"info","msg":"Playing intro clip."}
```

### 2.4 Deterministic state

`state(t) = fold(reduce, initialState, events where t_e <= t, in id order)`.

- `reduce(state, event)` is a pure ES module with no DOM, clock, or randomness.
  It lives at `public/scene/reduce.js` and the server imports it too, so
  validation, snapshots, and the browser share one implementation. That needs
  no build step, because the server already runs ES modules.
- **Ordering key is `id`, not `ts`.** `t` comes from `Date.now()`, which can
  step backwards. Proposal: clamp `t` at publish so it never decreases
  (`t = max(lastT, now - startedAt)`). Then binary search on `t` is valid.
- State holds **persistent** facts (layout, widget values, visibility, avatar
  model, expression, current media) and a bounded list of **transient**
  instances `{id, kind, t0, durationMs, ...}` (motions, gifts, bursts). The
  reducer drops a transient once `t > t0 + duration`, and keeps at most 8
  active effects (oldest dropped).
- **Rendering is a pure function of `(state, t)`.**
  - Effect progress is `(t - t0) / duration`.
  - Media position is `offsetMs + (t - t_play) * 1000`.
  - Randomness comes from a PRNG seeded with `data.seed` or the event `id`.
  - So playing at rate r, seeking, and live viewing all show the same picture
    for the same `t`.
- **Derived projections.** The reducer may also read existing log events.
  `openclawEvent: tool_start/tool_end/model_start/model_output` from
  `openclaw-activity.js` and `openclaw-routes.js` drive bongo-cat states
  (idle, typing, thinking, done). Bongo-cat therefore needs **no new recorded
  events**, and it works on recordings made before this feature.

### 2.5 Keyframes and seeking

- **Client checkpoints (Phase A).** The client already downloads the whole
  recording before playback (`app.js` `loadRecording` pages through every
  event). On load, the client folds the events once and keeps a state
  checkpoint every 250 events. A seek restores the nearest checkpoint at or
  before the target and folds forward. Costs: O(n) once per load and O(250)
  per seek.
- **Server snapshots (Phase A, cheap).**
  - The server publishes `scene/snapshot` at stream start, after crash-recovery
    resume (where `BroadcastStore` already publishes a "Stream resumed" event),
    and every 5 minutes if the state changed.
  - The reducer replaces state with a snapshot only if its `upTo` matches its
    own position. Otherwise it treats the snapshot as a cross-check.
  - Snapshots let a later change fetch only a time window, which is not
    possible today. They also let a live joiner render immediately.
- **Golden rule:** `fold(all events) == fold from any snapshot`. Tests enforce it.

### 2.6 Idempotency and schema evolution

- Producers send `eventRef`. The server deduplicates on
  `(recordingId, kind, eventRef)` using a window seeded from the last 2000
  events on startup, the same approach `server/index.js` uses for activity
  `eventRef`s. Today `openclaw-routes.js` keeps its `seen` set only in memory,
  with no limit within a recording, and it is lost on restart. Scene ingestion
  should use the persisted-window approach.
- Evolution is additive.
  - New `op`, new optional `data` fields, or new kinds bump the reducer's
    supported `sv` set.
  - The renderer treats unknown `sv`, `kind`, or `op` as log-only, never as an error.
  - Changing an existing field's meaning requires `sv: 2` and a reducer branch
    for v1 events, so old recordings stay replayable.
  - Recording metadata `schemaVersion` stays 1, because the envelope does not change.

## 3. Rendering architecture

| Option | Pros | Cons |
|---|---|---|
| DOM/CSS overlay layers | Crisp text, accessible (screen readers, zoom), easy layout. No dependencies. Respects `prefers-reduced-motion` with CSS. | Poor at many particles or sprite animation. Layout and reflow cost if updated every frame. |
| Canvas2D | No dependencies, cheap sprite atlases and particles, fully deterministic draws, works everywhere. | Text is not accessible. Rescaling for DPR is manual. No Live2D. |
| WebGL (PixiJS plus a Live2D runtime) | Needed for Live2D. Fast effects. | Heavy: PixiJS is roughly 100s of KB (unverified). Cubism Core is proprietary. GPU and battery cost on phones. Context loss must be handled. |
| **Hybrid (recommended)** | Each layer uses the cheapest suitable technology. Heavy parts load only when a scene needs them. | Three layers must be composited and kept in sync with one clock. |

Recommended stack inside `#player`, from back to front:

1. **Background layer.** A CSS background image from the manifest.
2. **Avatar layer (Phase B).** A lazily created `<canvas>` with a WebGL Live2D
   renderer. It loads only when `state.avatar` is set and the capability
   check passes.
3. **Existing log layer.** `#stream-log` and `#captions`, unchanged. Scene
   `layout` toggles CSS classes that move or shrink it.
4. **Effects and sprites layer.** One Canvas2D `<canvas>` for bongo-cat
   frames, gifts, and bursts.
5. **Widget layer.** DOM cards (`aria-live="off"`, with text that updates).
   Position comes from the slot, e.g. bongo-cat at bottom-right and info
   cards at top-right.

One clock, one renderer:

- `Player` stays the single owner of `time` and `rate` (the rate comes from
  the concurrent fix).
- A new `SceneRenderer` exposes `update(state, t, rate, mode)`, where `mode`
  is `"live" | "play" | "paused" | "scrub"`.
- Live mode simply means `t = duration()`. SSE events go into the same reducer
  through `player.add`.
- The existing 200 ms `setInterval` tick keeps driving the log and chat.
- One `requestAnimationFrame` loop draws the canvas layers. It runs only while
  the player is visible (`document.visibilityState`, IntersectionObserver) and
  only while an animation is active. When idle it sleeps.
- `render()` currently filters the full event array on every tick, which is
  O(n). Replace that with a binary-search cursor on `t`, since scene events
  increase the event count.

Playback rate and seeking:

- At any rate, transients play in recording time, so they run faster at rate > 1.
- During `scrub`, and at rate > 4, transients are skipped and only persistent
  state is drawn. Sounds play only at rate 1 in `play` or `live` mode.
- On seek, media resyncs `currentTime`. The media layer is paused and shows
  its poster when the rate is above 2 (the HTML media limit varies by browser).

Performance budgets (targets, to be measured in Phase A):

- At most 4 ms main-thread work per frame on a mid-range phone.
- Canvas layers capped at 30 fps, with backing store at most 2x CSS pixels.
- At most 8 concurrent effects.
- Phase A JS added at most 25 KB uncompressed. Sprite atlases at most 300 KB per scene.
- Live2D assets are fetched only on demand.

Mobile, reduced motion, weak devices:

- `prefers-reduced-motion`: bongo-cat shows static pose changes, effects
  become a one-line caption, and avatar motions are replaced by expression
  changes only.
- **Lite mode** for guests and weak devices. It turns on automatically when
  `navigator.deviceMemory < 4` or `hardwareConcurrency <= 2`, when WebGL is
  unavailable, or after 3 consecutive frames over 50 ms. It can also be
  toggled manually in player settings.
  - Lite mode keeps the DOM widgets and a static avatar portrait.
  - The full state is still computed, so turning lite mode off redraws at the
    current `t` with no gap.
- Hover preview stays text. It shows the last 5 captions, as today, plus the
  scene and widget values at the hover time, computed from the nearest
  checkpoint. Rendering canvas thumbnails is out of scope.
- New progress-bar marks for `scene/set` and gifts, styled differently from
  the `warn`+ marks.

## 4. Assets and storage

- **Manifest.** `public/assets/manifest.json` maps `id@hash`, using the first 4
  to 8 hex characters of SHA-256, to a type, file path, size, and licence tag.
  Files are named `name.<hash>.ext` and served with
  `Cache-Control: public, max-age=31536000, immutable`. `express.static`
  serves `public/` with default headers today, so this needs a small header
  rule for `/assets/`.
- **Pinned versions.** Events reference `id@hash`, so a recording keeps
  rendering with the asset version it was made with. Old hashes stay in the
  manifest because asset files are small. Recording metadata gains an
  additive `assetsVersion` (the manifest hash at start) for diagnostics.
- **Asset types:**
  - Bongo-cat: one sprite atlas plus frame JSON.
  - Gift effects: atlas plus parameters.
  - Sounds: short Opus or OGG files, muted by default. The viewer must opt in,
    because browsers block autoplay with sound.
  - Live2D: `.moc3`, textures, motions, and expressions.
- **Licensed assets stay out of public git.** Live2D models, Cubism Core, and
  any commercially licensed art live in a private asset directory, mounted
  read-only into the container and published into the same manifest
  namespace. The public repo carries only the owner's own or permissively
  licensed sprites.
- **Media is referenced, not embedded.** An allowlisted media catalog (an
  admin-maintained manifest entry) holds either self-hosted files or approved
  external IDs. Events carry only a catalog ID.

Storage comparison (event sizes measured from representative JSON. Rates are assumptions):

| Item | Size | Rate | Per hour |
|---|---|---|---|
| Existing activity log event | ~450 B (up to 12 KB for model text) | ~1/s busy | ~1.6 MB |
| Widget `set` (coalesced) | ~350 B | 3 widgets x 1/min | ~63 KB |
| Avatar, effect, scene ops | ~350 B | ~200/h | ~70 KB |
| Server snapshot | ~1-2 KB | 12/h | ~24 KB |
| Bongo-cat | 0 B (derived) | n/a | 0 |
| **Scene overhead total** | | | **~0.15 MB/h** |
| 720p30 video at ~3 Mbps (for comparison) | | | ~1.35 GB/h |
| 1080p30 video at ~6 Mbps | | | ~2.7 GB/h |

Scene events add about 10% to an active log stream. That is roughly 4 orders
of magnitude less than video. Shared assets are a one-time cost of roughly
0.5 to 10 MB, depending on the Live2D model (unverified until a model is chosen).

## 5. Producers, auth, validation

| Producer | Emits | Auth | Rate limit |
|---|---|---|---|
| Dashboard server, metrics bridge (new, in-process) | `widget set` for `cpa` and `tokens`, plus `scene snapshot` | In-process only, no route. Uses `MetricsStore.report` and the stored CPA snapshot. | At most 1 event per widget per 60 s, and only when the value changes after rounding |
| Client reducer (derived) | Bongo-cat state from existing OpenClaw activity events | None, because nothing new is recorded | n/a |
| OpenClaw `dashboard_stream` tool, new actions `scene` and `avatar` | `scene set`, `widget show/hide`, `avatar expression/motion`, `effect burst` | Existing stream bearer token plus the existing tool gate (agent `main`, `senderIsOwner`). Server-side `agentId === "main"`, the same check as `/summary`. New route `POST /api/openclaw/stream/scene`. | Token bucket 2/s, burst 10 |
| Admin browser controls (new compact "Scene" panel under the broadcast controls) | All ops, including `media` | `requireAuth` + `requireAdmin` + `requireCsrf` (the `X-Dashboard-Request` header). New route `POST /api/broadcast/scene`. | 5/s |
| Signed-in viewers, Phase C only, if approved | `effect gift` from an allowlisted gift catalog | `requireAuth` + `requireCsrf`. Display name as in chat. Live only. | 1 per user per 10 s (chat cooldown is 5 s), 1/s overall |
| `dashboard-host` chat agent | Nothing directly | Stays tool-denied | n/a |

Notes:

- **The `dashboard-host` reply path stays tool-free.** Avatar "talking" can be
  derived on the client from `source: "openclaw"` log events, the same way
  bongo-cat is.
- **The CPA widget needs a refresh policy.** Today CPA quota refreshes only
  when an admin asks (`POST /api/admin/metrics/cpa/refresh`, at most once per
  30 s). The bridge would either reuse the last snapshot and show its age, or
  run an optional background refresh every 10 to 15 minutes while live. That
  is an owner decision, because it calls upstream services.
- **Public CPA values follow the existing "accounts stay separate" rule.**
  The widget shows the one owner-designated provider window (for example
  "Claude 5h") or the lowest remaining percentage among approved windows. It
  never shows account labels or the per-account list. Percentages are rounded
  to 5%, and reset times to the minute.
- **Tokens:** the total since stream start (`summary.tokens` over
  `[startedAt, now]`), rounded to 3 significant figures. Cost stays out of the
  widget unless the owner approves it.

Validation and sanitization:

- A single `validateSceneEvent(kind, op, data)` lives in
  `public/scene/schema.js` and is shared with the server.
  - It uses closed allowlists of kinds, ops, targets, and `data` keys, with
    type and range checks.
  - Asset, gift, and media IDs must exist in the manifest.
  - `msg` is produced by the server from a template for each op. A producer
    never supplies it, except the optional `from` display name, which comes
    from the session, as chat does.
  - Rejections use the AGENTS 1.8 message shape, e.g. `Scene event not
    recorded: dashboard/scene ingestion — op "explode" is not allowed for
    kind "effect".`
- **The client never interprets event strings as markup.** It sets values with
  `textContent` and canvas `fillText`. Images come only from manifest paths.
  `app.js` still has `innerHTML` sites with `esc()` for catalog cards. New
  scene code must not add any.
- **Global back-pressure.** Each event costs two fsyncs and a metadata
  rewrite, so all scene-class events share a cap of 10/s. Excess events are
  dropped with a `warn` log event, never queued without limit.

CSP:

- No `Content-Security-Policy` header is set in `server/index.js` today.
  Whether the reverse proxy adds one is unknown (assumption: it does not).
- `index.html` has no inline scripts or styles, so a strict policy is feasible
  now and should ship in Phase A:
  `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`.
- Setting `el.style.left` from JS, as the progress bar does, is allowed
  without `unsafe-inline`.
- Phase B may need `'wasm-unsafe-eval'` if the Cubism Core build uses
  WebAssembly (unverified).
- Phase C external media would need an explicit `frame-src` entry, for example
  for privacy-enhanced YouTube embeds. That is an owner decision.
- The browser check should fail on any `securitypolicyviolation` event.

## 6. Licensing and dependency risk

- **Live2D Cubism SDK for Web (verify against the current licence text before
  Phase B).**
  - Cubism Core is under the Live2D Proprietary Software License.
  - The TypeScript Framework is under the Live2D Open Software License.
  - Publishing content made with the SDK may require a Cubism SDK Release
    License. Small-scale individuals and businesses below a revenue threshold
    have been exempt in the past (unverified).
  - Whether Core may be redistributed in a public git repo is unclear. Keep
    Core in the private asset mount.
- **Models.** Live2D sample models have their own terms (Free Material License,
  with restrictions by user type; unverified). Third-party VTuber models
  usually forbid redistribution. Use an owner-owned or commissioned model
  whose licence explicitly allows web display.
- **Bongo-cat art.** The well-known meme art belongs to its original creator
  (attribution unverified). Use owner-drawn or explicitly licensed frames.
- **Wrappers.** `pixi-live2d-display` (MIT) brings in PixiJS, and its support
  for current Cubism versions is uncertain (unverified). It would add a
  multi-dependency tree that the owner dislikes.
- **Dependency plan:**
  - Phase A: zero new npm packages. Vanilla JS, Canvas2D, and DOM.
  - Phase B: vendor one pinned, prebuilt bundle of the official Cubism
    Framework, compiled once and recorded with its source commit and SHA-256,
    plus Core from the private mount. No PixiJS, no runtime npm dependency.
  - Phase C: no new dependencies. Self-hosted media uses native
    `<video>`/`<audio>`. External players are an open question.
- **Fallback without Live2D.** A layered-sprite avatar (PNG-tuber style) using
  the same `avatar` events, with expressions mapped to sprite sets. It
  needs no licence and also serves as the lite-mode avatar.

## 7. Phased plan

### Phase A: schema, renderer core, bongo-cat, metric widgets

Scope:

- `public/scene/schema.js`, `reduce.js`, and `renderer.js`, each under 300 lines.
- Wire them into `Player`, with a binary-search cursor and checkpoints.
- Clamp `t` so it never decreases.
- Scene-event dedup window.
- Metrics bridge for `cpa` and `tokens`, off by default, controlled by an
  admin "public widgets" setting.
- Scene panel with show/hide and layout.
- Bongo-cat derived from activity events.
- CSP header and `immutable` headers for `/assets/`.
- Doc updates in `docs/deployment/dashboard.md` and
  `docs/development/dashboard-metrics.md`, which must replace the "never enter
  the public feed" statement with the approved-aggregate policy.

Acceptance:

- Old recordings render identically, including the log, chat, and marks.
- Bongo-cat reacts on a live stream and on an old recording containing
  `tool_start` events.
- Widgets show rounded values. Guests see no account labels.
- Seeking to any `t` gives the same widget state as playing up to `t`.
- No CSP violations.
- No new npm packages (the `package.json` diff contains no new dependencies).

Tests:

- `node --test` reducer unit tests: every op, unknown `sv`/`kind`/`op`,
  transient expiry, effect cap, seeded PRNG.
- Schema rejection tests for every route.
- Auth tests: guest, member, and wrong bearer token get 401/403.
- Rate limit and dedup tests across a restart.
- **Golden replay:** fixture NDJSON files, plus expected state JSON at fixed
  times.
- Property checks, all producing equal state:
  - folding from 0 vs folding from each checkpoint or snapshot;
  - incremental ticks at rates 0.5, 1, 2, and 8 vs a direct seek.
- Browser check, extending the existing opt-in Playwright script:
  - widget text at seek times;
  - bongo-cat canvas present in the bottom-right;
  - reduced-motion and lite-mode paths;
  - guest view;
  - CSP violation listener.

### Phase B: Live2D avatar and triggers

Scope:

- Lazy WebGL avatar layer with the vendored Cubism bundle.
- `avatar load/expression/motion/unload`.
- OpenClaw tool action `avatar` with an allowlisted motion and expression
  list per model, taken from the manifest.
- Client-derived "talking" and "thinking" states from activity events.
- Sprite-avatar fallback.
- WebGL context-loss recovery.

Acceptance:

- The avatar appears within 2 s on desktop after the scene loads.
- Motions replay at the same times at every rate, and are skipped while scrubbing.
- Lite mode shows the sprite portrait.
- No Live2D files exist in the public repo.
- The licence review is recorded in the docs.

Tests:

- Reducer tests for avatar ops.
- Golden replay including avatar state.
- Browser check that the canvas exists, with WebGL unavailable forcing the
  fallback.
- A frame-time sample under CPU throttling, kept within budget.

### Phase C: media, presents, and effects

Scope:

- Gift catalog and the viewer gift route, if approved.
- `effect gift/burst` drawn on Canvas2D with seeded particles.
- Self-hosted media catalog and `media play/pause/stop`, with seek resync and
  a rate cap.
- Opt-in sound with a viewer mute toggle that is remembered locally.
- Progress-bar marks for gifts and scene changes.

Acceptance:

- A gift sent live appears for all viewers and replays at the same `t`.
- Gift spam is limited (per user and globally).
- Media position after a seek is within 250 ms.
- No sound without opt-in.
- No external frames unless an approved `frame-src` entry exists.

Tests:

- Rate limit tests.
- Gift validation, with an unknown gift rejected.
- Media position math tests.
- Browser checks for autoplay-muted behaviour and seek resync.

## 8. Owner decisions (2026-11-05)

These override any conflicting proposal above.

1. **CPA widget (public).** Use every available Codex account with equal weights.
   - **5-hour window:** the mean remaining percentage, plus the time to the next
     reset, shown as `y h z m`.
   - **Weekly window:** the mean remaining percentage, plus the time to the next
     reset, shown as `x d y h z m`.
   - Classify windows by their length (about 5 h and about 7 d), not by the
     `primary_window` / `secondary_window` label.
   - "Next reset" is the earliest reset among the accounts in that window.
   - Accounts with an unknown window are excluded from the mean, and the widget
     shows "n of m accounts".
   - No account labels, emails or raw responses are published.
   - The public widget deliberately pools accounts. The admin CPA panel keeps
     its per-account view.
2. **Refresh:** a background CPA quota refresh every 5 minutes while a stream is
   live. It reuses the existing single-flight refresh, and a failed refresh
   keeps the last snapshot and shows its age.
3. **Recording:** metric widget updates are recorded as log events, so replay
   matches what viewers saw. At most one event per widget per refresh.
4. **Avatar:** ship a licence-free avatar first. Live2D is deferred. The owner
   picks from a local option list; the recommendation is a canvas-drawn avatar
   we own.
5. **Bongo-cat:** frames are drawn on the canvas in our own style, never the
   original meme art. OpenClaw sends the update events: activity events drive the
   paws, and explicit `widget` or `avatar` events are allowed.
6. **Gifts:** none for now. Phase C presents are dropped.
7. **Media:** deferred. When added, external embedding is limited to images and
   media files on an allowlist; no third-party players or scripts.
8. **Control:** OpenClaw makes scene, avatar and widget changes. Admins only do
   setup: enabling widgets, the asset registry, allowlists and limits.
9. **Snapshots:** client-side only. No server snapshots. **All rendering is
   client-side**; the server only validates, stores and relays events.
10. **Sleepy avatar state:** the avatar shows a `sleepy` expression while the
    stream host is running on the paid fallback — i.e. the latest relevant
    `model_output` activity came from provider `openai` instead of `cpa`, or
    the public CPA Codex widget's pooled remaining percentage is 0 — and
    returns to normal when CPA serves again. Derived client-side from recorded
    events; no extra stored state.
11. **Avatar renderer is pluggable:** phase A draws the owner-approved chubby
    grey witch on canvas from layered parts; a later Live2D renderer replaces
    only the avatar layer behind the same expression events (idle, blink,
    talk, think, sleepy). The bongo-cat is a separate lightweight canvas widget
    and stays canvas-drawn.

## 10. Phase A as implemented (dashboard 0.2.0)

Owner requests after section 8 added an **admin canvas widget editor** and
**admin-placed widgets** on top of decision 8 ("admins do setup"). Where the
implementation differs from sections 2–7, this section wins.

- **Widget model.** Widgets are free-positioned instances
  `{ id, type, x, y, w, h, z, props }` instead of a fixed slot catalog.
  Geometry is normalized to a 16:9 stage (0–1) that the renderer letterboxes
  inside the player, so layouts match in normal, theater, web full screen, and
  full display. Types v1: `text`, `metric`, `avatar` (1:1 default box),
  `cat` (lower-right default), `clock` (stream uptime or UTC wall clock),
  `image` (URL must start with an admin-allowlisted HTTPS prefix). Media,
  gifts, and Live2D remain out of scope.
- **One validator** (`public/scene/schema.js`) is used by the admin routes, the
  OpenClaw routes, the saved layout, and the editor form. Unknown types,
  fields, and props (including prototype keys) are rejected; strings have
  length limits and no control or bidi-override characters; at most 24 widgets
  and 1.5 KiB per widget; events at most 2 KiB.
- **Events.** `kind: "widget"`, `sv: 1`, `op` one of `create` / `update` /
  `delete` (data `{ widget }`, the full widget after the change, target = widget
  ID) and `metrics` (data `{ values }`, target `metrics`). `msg` is a
  server-side template that never contains producer text. Metric ticks are
  hidden from the log; other widget events keep their caption.
- **Reducer** (`public/scene/reduce.js`) is shared by the browser and the
  server's live-scene tracking. Event time is the running maximum of `t`
  (the server now also clamps `t` at publish), so the visible set is always a
  prefix. Client checkpoints every 250 events; no server snapshots
  (decision 9). Tests assert seek-from-checkpoint == fold-from-zero and
  identical state at every playback rate.
- **Derived pictures** (`public/scene/derive.js`): avatar `think` from
  `model_start` until output or while tools run, `talk` for about 18
  characters per second after a host `model_output` (1.5–10 s), a seeded
  periodic `blink`, `idle`, and `sleepy` while the latest host `model_output`
  provider is `openai` or a pooled Codex window is 0% (decision 10). The cat
  taps on `tool_start` / `tool_end` / `model_output`, drums while busy, and
  sleeps after 5 minutes without activity. Only `source: "openclaw"` activity
  counts; AstrBot relay traffic does not move the avatar.
- **Avatar layer** (`public/scene/avatar.js`) is pluggable: a renderer gets
  `{ expression, frame, t, reduced, mirror }` and draws on its canvas. Phase A
  draws the owner's witch frames (vendored under `public/scene/assets/` with
  content-hashed names, cached immutable); Live2D would replace only this
  renderer. The cat (`public/scene/cat.js`) is our own canvas drawing in the
  witch's navy-line, flat-fill, hard-shadow style.
- **Persistence.** A saved default layout (`/app/data/scene/scene-layout.json`,
  validated, `version` incremented on every save, stale `baseVersion`
  rejected) is replayed as opening `create` events when a stream starts. Until
  the first save the built-in layout (avatar + cat) is used. Admin edits always
  update the saved layout and, while a stream is live, are also recorded.
  OpenClaw edits change only the live recording its session owns.
- **APIs.** Admin: `GET/PUT /api/scene/layout` (PUT replaces the saved
  layout only, never the live recording), `POST /api/scene/widgets`,
  `PATCH/DELETE /api/scene/widgets/:id`, `GET/PUT /api/scene/settings`
  (image allowlist). OpenClaw: `GET /api/openclaw/scene/layout`,
  `POST /api/openclaw/scene/widgets`, `PATCH/DELETE
  /api/openclaw/scene/widgets/:id`. A bulk OpenClaw layout replace was **not**
  implemented: it would emit up to 48 events at once against the 2/s cap and
  could wipe a public scene in one call; widget operations cover the need.
  The OpenClaw plugin/tool is unchanged; see `docs/deployment/dashboard.md`.
- **Rate limits.** Admin 5/s (burst 10), OpenClaw 2/s (burst 10), and a shared
  10/s cap (burst 40) for scene events; opening layouts and metric ticks are
  server-generated and bounded by the 24-widget limit and one event per refresh.
- **CSP** ships as proposed, with `img-src` extended only by the allowlisted
  image origins; the browser check fails on any violation.
- **Metric widgets** follow decisions 1–3; details in
  `docs/development/dashboard-metrics.md`. Metrics are published only while a
  metric widget is on the live scene, and the 5-minute CPA refresh runs only
  then (a narrower reading of decision 2 that avoids upstream calls nobody sees).

## 9. Original open questions (answered in section 8)

1. Which metric aggregates may be public?
   - The CPA widget could show one designated provider window or the lowest
     remaining percentage across windows.
   - Should token totals cover this stream, today, or 7 days?
   - Should estimated cost ever be shown?
2. May the dashboard refresh CPA quota in the background while live (every
   10 to 15 minutes, using upstream calls), or should the widget show only the
   last admin-triggered snapshot and its age?
3. Should metric values remain in public recordings forever, or should
   widgets be live-only overlays that are not recorded? Recording them is
   required for faithful replay.
4. Live2D: do you have, or will you commission, a model licensed for web
   display? Which Cubism SDK release-licence tier applies to this site?
   Should the licence-free sprite avatar ship first instead?
5. Bongo-cat art: will you draw or commission the frames, or is there an
   asset you hold rights to?
6. Gifts: may signed-in members send presents, or only you and the agent?
   Are there any guest interactions at all (currently none)?
7. Media: self-hosted files only, or also YouTube or other embeds? Embeds
   bring third-party scripts and cookies to guests and require relaxing the CSP.
8. Should the OpenClaw agent control scenes and avatars on streams started by
   an administrator (as `summary` does today), or only on streams its session
   started?
9. Is a server snapshot every 5 minutes acceptable, or should snapshots be
   client-only until windowed fetching is needed?
