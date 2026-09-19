# opencode plugins

The personal dsh / Codex plugins, rewritten as native opencode plugins. Each is
a TypeScript module under `plugin/` exporting a `Plugin` function; shared logic
lives in `lib/`.

| Plugin | Ports | Tools |
| --- | --- | --- |
| `session-manager` | dsh `session-sync`, codex `session-importer` | `session_scan`, `session_list`, `session_read`, `session_import`, `session_sync_all`, `session_projects`, `session_register_projects`, `session_status` |
| `bark-notify` | dsh `dsh-bark-notify` | `bark_send`, `bark_state`, `bark_set_mode`, `bark_set_type`, `bark_profile`, `bark_preview`, `bark_device`, `bark_flush` — plus an `event` hook |
| `cpa-usage` | dsh `cliproxy-quota` | `cpa_quota`, `cpa_models`, `cpa_config` |
| `task-queue` | dsh `task-runner` | `task_create`, `task_list`, `task_update`, `task_run`, `task_retry`, `task_resume`, `task_sync` — plus `session.created` / `session.idle` / `session.error` hooks |
| `session-rename` | — | `session_rename`, `session_rename_preview`, `session_rename_state` — plus a `session.idle` hook |
| `plugin-manager` | codex `persistent-plugin-manager` | `plugins_status`, `plugins_dashboard`, `plugins_set`, `plugins_toggle`, `plugins_action`, `plugins_versions` |

## Install

opencode auto-discovers any `*.ts` in `~/.config/opencode/plugin/`. This repo is
linked in rather than copied, so edits here are live:

```powershell
cmd /c mklink /J "$env:USERPROFILE\.config\opencode\plugin" "<repo>\opencode\plugin"
cmd /c mklink /J "$env:USERPROFILE\.config\opencode\lib"    "<repo>\opencode\lib"
cmd /c mklink /J "<repo>\opencode\node_modules" "$env:USERPROFILE\.config\opencode\node_modules"
```

The third junction lets the plugins resolve `@opencode-ai/plugin`, which opencode
installs into its config directory. Junctions are used instead of symlinks
because they need no administrator rights.

## Where to see and control them

opencode has **no plugin settings panel and no web UI**. Settings only has
Agents, Commands, MCP, Models, Permissions, Providers and Shortcuts — plugins
are deliberately not configurable from the interface.

**To see them:** the status indicator in the session footer opens a popover with
a **Plugins** tab. It lists `config.plugin` from `opencode.json` and nothing
else — auto-discovered files in `plugin/` never appear there, which is why the
tab reads "Plugins configured in opencode.json" when the key is absent. Listing
the files explicitly makes them show up:

```json
{ "plugin": ["file:///C:/Users/<you>/.config/opencode/plugin/bark-notify.ts"] }
```

This is display-only and does not double-load them: the config loader requires a
`default` export carrying an `id`, and these plugins use named exports, so it
skips them while the directory scanner still loads them once.

Because that surface is so thin, `plugin-manager` supplies its own — see below.

## plugin-manager: settings dashboard and soft hot-plug

Ports the codex `persistent-plugin-manager` panel. Two surfaces over one
registry:

- **Dashboard** — `plugins_dashboard` returns a `http://127.0.0.1:141xx` URL.
  Every plugin's settings, status and actions, with toggles.
- **Tools** — `plugins_status`, `plugins_set`, `plugins_toggle`,
  `plugins_action`, so the same control is reachable from GUI chat.

### Enable / disable without restarting

opencode never unloads a plugin, so disabling is cooperative: a disabled plugin
stays resident but gates its own hooks and actions on `Registry.isEnabled`.
Toggling takes effect immediately and persists in `plugin-manager.json`.

This is genuine suppression, not cosmetic — a disabled `bark-notify` sends no
push, and a disabled `cpa-usage` performs no network probe.

### Adding settings to a plugin

Plugins self-describe, so the dashboard never needs changing:

```ts
Registry.register({
  id: "my-plugin",
  title: "My Plugin",
  description: "…",
  settings: async () => [{ key: "mode", label: "Mode", type: "select", value, options }],
  update: async (key, value) => { /* validate + persist */ },
  status:  async () => [{ label: "queued", value: 3, tone: "warn" }],
  actions: { test: { label: "Send test", run: async () => "sent" } },
})
```

Field types are `boolean`, `string`, `number` and `select`. A new field appears
in both the dashboard and `plugins_set` with no other edits.

### Dashboard layout

A sidebar lists **Home**, every plugin, and every config file. Below 860px —
including when the window is docked beside the opencode GUI — it collapses to an
off-canvas drawer behind a hamburger button.

**Home** shows the plugin-manager's own attributes plus a list of the config
files. **Plugin** pages carry four tabs — **Info**, **Logging**, **Settings**
and **Version**. **Config** pages open the editor.

### URLs

Every page has its own address, so it can be bookmarked, reloaded, opened in a
second tab, or reached with back/forward:

| Route | Page |
| --- | --- |
| `/` | the plugin manager |
| `/plugin/<id>` | that plugin's Info tab |
| `/plugin/<id>/<tab>` | `info`, `logging`, `settings` or `version` |
| `/config/<file>` | the config editor for one file |

The server answers every non-`/api/` path with the same shell, which then
routes on the URL — that is what lets a deep link survive a direct load rather
than 404ing. Sidebar entries are real anchors, so middle-click and "open in new
tab" behave normally; a plain click stays a soft navigation.

Navigation renders from the already-loaded plugin list first and refreshes only
what the open page needs, instead of re-fetching every endpoint on each move.
The marketplace is only contacted when the Version tab is actually opened.

## Versioning

Every plugin declares its version in [`versions.json`](versions.json), the one
place a version is written. `lib/versions.ts` reads it, so the dashboard, the
release workflow and the marketplace all agree on one number.

Versions are `va.b.c`:

| Part | Meaning |
| --- | --- |
| `a` | Major. Only ever set by a human. |
| `b` | The stable line. `x.y.0` is a release. |
| `c` | Beta counter. Any `c > 0` is a local, unverified build. |

So `1.2.0` is stable and `1.2.1` is a beta on top of it. Promoting a verified
beta bumps `b` and resets `c`: `1.2.1` becomes `1.3.0`. **Only `x.y.0` is ever
published** — a beta is a local build, which is what lets the release workflow
decide what to ship from the version alone.

The **Version** tab shows the installed version, its channel, the newest
published release, and the release tag. A local beta is reported as *not
published* rather than as out of date, because it is ahead of the marketplace by
construction. `plugins_versions` reports the same from a session.

### Releases

[`opencode-plugins-release.yml`](../.github/workflows/opencode-plugins-release.yml)
runs on a push to master that touches `opencode/`. `scripts/plan-release.mjs`
compares the manifest against existing `opencode-*` tags and releases every
plugin that is stable and untagged; betas and already-released versions are
skipped, so a push that changes nothing publishes nothing.

Each release is tagged `opencode-<plugin>-v<a.b.c>` and carries
`<plugin>-<a.b.c>.zip` containing that plugin, the whole of `lib/`, and the
manifest — the plugins import `lib/` directly, so a single-file asset would not
install.

The planner also validates the manifest: a plugin file that is not listed, a
manifest entry with no file, or a malformed version fails the build rather than
publishing something unversioned.

### Marketplace

The manifest's `repository` is the default update source. `plugin-manager`
reads its releases and reports which plugins have a newer stable version, from
the Version tab's **Check for updates** button or `plugins_versions`.

Any repository following the same tag and asset convention works, so the source
is configurable from the manager's own settings:

| Setting | Meaning |
| --- | --- |
| `marketplace.repository` | `owner/name` whose releases are offered |
| `marketplace.apiBase` | GitHub API root, for an Enterprise host |
| `marketplace.enabled` | When off, the manager never contacts the network |

The result is cached in `marketplace-cache.json`, so the dashboard renders the
last known state without polling GitHub. Checking is always an explicit action.

### Config editor

Edits `opencode.json`, `opencode.jsonc` and the plugins' own state files.
Saving is two-step: *Review & save* diffs the draft against disk and shows the
change before anything is written.

- Invalid JSON **blocks the save** — the Save button stays disabled — so a typo
  cannot leave opencode unable to start. JSONC comments and trailing commas are
  tolerated in `.jsonc`.
- Every overwrite keeps a timestamped `.bak-<iso>` copy, and writes go through a
  temp file so an interrupted save cannot truncate the config.
- Files opencode reads at startup are labelled **restart**; the diff dialog
  repeats the warning, since the change only applies on the next launch.

### Why it is in-process, not a daemon

The codex original spawned a detached server. opencode instantiates plugins
**once per project directory** — 40+ times on this device — so a daemon would be
spawned 40+ times. Instead the dashboard lives in the opencode process and the
port bind *is* the lock: `listen` is atomic, so exactly one instance wins and
the rest defer to it. Verified with 40 concurrent instances: one port, one
shared registry (on `globalThis`), no leaked processes. It exits with opencode.

## bark-notify: templates and subscribers

Each notification type owns a **message template** and its Bark presentation,
and every subscriber can override any type independently.

Titles and bodies are templates. A known `<placeholder>` with no value renders
empty and its line is dropped; an unknown one is left verbatim so a typo stays
visible.

| Placeholder | Value |
| --- | --- |
| `<session_title>` | The session's title |
| `<complete_summary>` | The final assistant message of the turn |
| `<request_error>` | Error text when the turn failed |
| `<permission_title>` | What needs approving, e.g. `Run: git push origin master` |
| `<permission_type>` | Permission kind, e.g. `bash` |
| `<permission_pattern>` | The matched pattern, e.g. `git push*` |
| `<directory>` | The session's working directory |
| `<session_id>` | opencode session id |
| `<event>` | The opencode event that fired |
| `<time>` | Local time the notification was built |

The approval placeholders come from the `permission.updated` payload, which is
the only thing that says *what* is being approved — a session title alone
cannot tell two pending approvals apart.

`session.idle` carries only a `sessionID`, so the title and summary are fetched
from `session.get` and `session.messages` when the event fires. A failed lookup
leaves the placeholder empty rather than dropping the push.

Each type also carries `level`, `sound`, `icon` and `group`. Levels are
`passive`, `active`, `timeSensitive` and `critical`; `passive` pushes silently.

| Type | Default level | Fires on |
| --- | --- | --- |
| `taskDone` | `active` | `session.idle` |
| `question` | `timeSensitive` | (reserved) |
| `approval` | `timeSensitive` | `permission.updated` |
| `error` | `timeSensitive` | `session.error` |
| `start` | `passive` | `server.connected` |
| `quit` | `passive` | (reserved) |

Every field is editable from the dashboard's **Settings** tab; the **Info** tab
renders each template with sample data. A per-subscriber override is set with
`bark_profile` (the dashboard renders a flat field list, which a per-device
matrix would not fit), and `bark_preview` renders a type without sending it.

**Send test push** pushes every enabled type through its own template, so the
test shows exactly what each notification will look like rather than one fixed
string. The test, the preview tool and the Info panel share one sample context.

Plugins load at startup, so edits here only take effect after opencode is
restarted; until then the previous build keeps sending its own messages.

Pre-template configs — a `devices` list with boolean `types` — are upgraded on
read, so an existing device and its toggles survive. In `away` mode the event
*context* is queued rather than the rendered text, so a template edited while
away applies when the queue is flushed.

## session-manager

Indexes every coding-agent transcript on the device and imports it into
opencode's own database, so past Claude Code / Codex / dsh work shows up in the
session picker.

### Sources

| Source | Location | Format |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` | JSONL |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | JSONL |
| dsh | `~/.dsh/sessions/**/session.v2.jsonl.zstd` | concatenated zstd frames of JSONL |

dsh appends each write as its own zstd frame, so the file is a sequence of
frames rather than one stream and has to be decoded frame by frame.

### The index

`~/.config/opencode/session-index.json` records one entry per transcript with
its fingerprint (`size:mtime`) and, once imported, the opencode session it
became. `session_scan` diffs the stores against it and classifies each entry:

- **added** — new transcript, not yet imported
- **grown** — appended to since import; the new tail is *merged* into the
  existing session
- **rewritten** — shrank or was replaced under the same id; *branches* into a
  new session rather than overwriting
- **missing** — the source file is gone

Importing is lazy: scanning only records state, and rows are written when
`session_import` or `session_sync_all` asks for them.

### Devices

The index is designed to be shared between machines, so every entry records the
device that observed it (`~/.config/opencode/device.json`). A scan therefore
only marks its *own* device's entries as missing — another machine's sessions
are absent by design, not lost.

### Project merging

A directory path is not stable across devices, so projects are keyed in this
order:

1. **Git remote URL**, normalised to `host/owner/repo` and hashed the same way
   opencode hashes it. This is the only globally stable key: the same repository
   cloned to different paths on different machines collapses into one project.
   Codex records the remote in `session_meta.git.repository_url`, which is what
   makes transcripts from a machine you are not on resolvable at all.
2. **Root commit**, for a repository with no remote.
3. **Directory basename**, lower-cased and namespaced under `name:` so it can
   never collide with a real repository id.

Because only Codex records a remote, sessions that ran in the same directory
would otherwise split between a remote-keyed project and a name-keyed one. The
resolver avoids that by learning every remote it can — from transcripts and from
git — before resolving anything, and sharing what it learns across all sessions
in that directory and all directories with that basename. Resolution is
therefore order-independent.

On this device that merges 23 `.codex/worktrees/*/Notechondria` checkouts into
the single `Notechondria` project.

### Making projects visible in the desktop app

Importing into the database is **not** enough for a project to appear in the
desktop app. The desktop does not derive its project list from the `project`
table — it keeps its own list of worktrees in `opencode.global.dat` under the
Electron user-data directory, and only spawns a server instance for those:

```json
"server": { "projects": { "local": [ { "worktree": "…", "expanded": true } ] } }
```

`session_register_projects` adds every project that owns imported sessions to
that list. It preserves existing entries and every unrelated key, skips
worktrees that no longer exist on this device, and writes atomically via a temp
file. **Restart the desktop app afterwards** — the list is read once at startup.

### Safety

Rows are only ever inserted, never updated or deleted, and each import runs in
its own transaction. The generated `session`/`message`/`part` rows are
field-identical to the ones opencode writes itself, including the 26-character
timestamp-ordered ids and the `parentID` linking every assistant message to the
user message it answers. Each imported session carries its provenance in
`session.metadata.imported`.

## task-queue: concurrency, retry and restart

The queue is also the scheduler. Every session becomes a task, so the store is
the record of what is running — which is what lets it bound concurrency, retry
failures, and pick work back up after a restart.

### Where task state comes from

Events alone are not a sound basis for tracking. A plugin only receives them
once it is loaded, so every session that already existed at startup is
invisible to it, and any event fired while the process was down is lost. That
is why the queue could read `active=0/3` with sessions plainly running, and why
there was nothing to resume after a restart.

Two sources are consulted, because neither alone is sufficient:

- **The database** (`opencode.db`, read-only) decides whether a session exists,
  and supplies its title and usage. The HTTP API is **directory-scoped** — a
  client answers only for the project it was created for — so asking this
  process's single client about a session in another project reports it as
  missing. That is what dropped a live 21-message session as *"session no
  longer exists"*.
- **`session.status()`** decides whether a session is busy, which is not
  persisted anywhere. It is queried once per directory that tracked tasks
  actually live in, and the answers merged.

The store is reconciled against both on every tick, whenever the dashboard
polls, and on demand via `task_sync`:

- a **busy** session that is not tracked is adopted as a running task — this is
  what picks up work that predates the plugin loading;
- a tracked task whose session is **idle** is completed, recovering the slot
  when the idle event was missed;
- a task whose session **no longer exists** is dropped rather than held forever.

Events still drive the fast path; reconciliation only repairs what they missed.
It is deliberately conservative: a failed probe changes nothing (rather than
reading as "every session vanished"), an unreadable database never causes a
drop, a task dispatched within the last ten seconds is left alone (it may not
have registered as busy yet), and tasks owned by another live process are never
touched.

### Titles, summaries and stats

A task called `New session - 2026-09-19T02:42:59.433Z` says nothing about what
it is, which makes the queue unreadable exactly when it matters. Each task
therefore carries a title, a one-line summary, and the session's usage.

Titles come from the session itself once opencode names it — a real name always
replaces a placeholder. Summaries are produced two ways:

1. **A model**, selected by the `summaryModel` setting. Summarising is small and
   self-contained, so a cheap local model suits it; the default offers
   `freetoken/Qwen3.8-27B-NVFP4`. It runs in a scratch session that is deleted
   afterwards, so nothing touches the transcript being summarised. This is also
   the seam the planned auto-distribution work will reuse.

   That scratch session is titled `task-queue summary`, and both session-wrapping
   paths skip it by that title. Without the guard the queue feeds itself:
   wrapping the scratch session queues a task, whose own summary opens another
   scratch session, and so on until the queue is full of them.
2. **The built-in parser** otherwise — and whenever the model is absent,
   misconfigured, slow, failing or answers unusably. Set the model to *none* to
   use it exclusively. It never leaves the process, so the queue works with no
   model configured at all.

Each card shows how long the session has been active, its context tokens
(cache reads counted separately, since they are billed differently), cost when
the provider reports one, and its message count. The status line totals tokens
and cost across everything still live.

### Concurrency

Each session occupies one of `maxConcurrent` slots (default 3, editable). Past
the limit new work sits as `pending` and starts when a slot frees, which
`session.idle` reports immediately — the poll timer is only a backstop.

A session the user starts by hand counts exactly like a queued task; otherwise
the limit would constrain the queue while the editor ran unbounded beside it.
Subagent sessions (those with a `parentID`) run inside their parent's turn and
take no slot of their own.

### Restart resume

A task marked `running` belongs to a process that no longer exists, so on
startup those return to the queue and are resumed — restarting opencode
mid-turn is routine while developing a plugin, and the work in flight would
otherwise be lost. A session with nothing of its own to replay is resumed with
a continuation prompt.

Recovery runs *before* the first reconcile, so an orphaned task is re-queued
for resumption rather than adopted as though it were still running.

Ownership is tracked by PID rather than assumed, because every opencode process
on the device shares one store: reclaiming *every* running task would let a
second instance seize sessions the first is still driving. Only tasks whose
owning process is gone are reclaimed. Turn it off with `resumeOnRestart`.

### Rate limits

A `429` waits for the model's own reset time, read from cpa-usage's management
API — the provider knows exactly when the window refills, so retrying earlier
only burns requests and retrying later wastes budget. `retryIntervalSeconds`
(default 300) is the fallback for a model CPA does not report, and the whole
policy when `rateLimitMode` is `interval`.

### Automatic retry

opencode calls the model with `maxRetries: input.retries ?? 0` and exposes **no
config key** for it, so a dropped TLS socket ends the turn outright:

```
TypeError: terminated
  at Fetch.onAborted (undici)
  at TLSSocket.onHttpSocketClose (undici)
```

That is a transport failure, not a refusal. The plugin's `session.error` hook
catches it and queues a retry.

That is a transport failure, not a refusal.

| Kind | Examples | Action |
| --- | --- | --- |
| `transport` | `terminated`, `ECONNRESET`, `socket hang up`, `fetch failed` | retry with backoff |
| `quota` | `429`, `rate limit`, `insufficient credit` | retry at the model's reset time |
| `permanent` | `does not support this model`, `unauthorized`, `context length exceeded` | never retried |
| `unknown` | anything else | not retried — better to surface it than to loop |

The governing rule is that **anything that ends other than by completing falls
back to the queue** with a `nextAttemptAt`, so no work is silently dropped:

- Retries are **queued, never fired mid-turn**, so they stay visible in
  `task_list` and on the dashboard, and quota-gated like everything else.
- Transport backoff is exponential with jitter — 6s, 11s, 23s, 43s … capped at
  5 min. Jitter matters because one proxy outage tends to fail several sessions
  at once; without it they would all retry on the same beat.
- A session already tracked as a task is rescheduled **in place** rather than
  spawning a second entry for the same work.
- Attempts are capped (default 10) so a broken endpoint cannot loop forever.
- `requireQuota` skips a transport retry when the quota probe says exhausted. A
  *quota* failure is exempt — waiting is the entire point.
- `task_retry` runs the same path manually; `task_resume` forces a restart sweep.

Every knob is editable from the dashboard and persists in
`task-queue-retry.json`.

### The queue panel

The panel opens on **active** — what holds a slot right now — rather than on
everything, since a long-lived queue accumulates finished tasks that are no
longer actionable. The `active` and `waiting` chips are derived rather than
stored: `waiting` is pending work whose retry delay has not yet elapsed, shown
with a live countdown. `task_list` applies the same default and takes the same
filters.

## session-rename: titles that track the work

opencode names a session from its first prompt and never revisits it, so the
picker fills with titles describing the question that *opened* a session rather
than the work it turned into. The title is the only thing the picker shows, so a
stale one is the difference between finding old work again and not.

When a turn completes, the recent transcript is handed to a small model under a
prompt you own, and the reply becomes the new title. The model is deliberately
not the one driving the session: naming is a one-line job that a cheap model does
well and an expensive one should not be paying for.

### No model means off

With no model configured there is nothing to do the work, so the plugin disables
itself — the dashboard toggle flips to off and the `session.idle` hook stops
acting. Choosing a model from the **Rename model** dropdown re-enables it, so
that one setting is all it takes to start or stop using the feature. Deriving a
title by string-munging instead would be no better than the one opencode already
wrote, which is why there is no parser fallback here (unlike `task-queue`, whose
summaries are a convenience on top of a working queue).

### The prompt is yours

The prompt owns the title format — length, mood, language, whatever convention
you want — and is edited from the Settings tab. Placeholders:

| Placeholder | Value |
| --- | --- |
| `<transcript>` | Recent turns, speaker-labelled, oldest first |
| `<current_title>` | The title being replaced |
| `<directory>` | The session's working directory |
| `<session_id>` | opencode session id |
| `<max_length>` | The configured length limit, so the rules stay in one place |

A known placeholder with no value renders empty; an unknown one is left verbatim
so a typo stays visible. The **Info** tab renders the prompt with sample values,
and `session_rename_preview` renders it for a real session without calling the
model or touching the title.

### What is skipped, and why

| Setting | Effect |
| --- | --- |
| `mode` | `always` keeps the title current; `placeholder` only names sessions opencode never titled |
| `minMessages` | Sessions shorter than this are not worth a model call |
| `cooldownSeconds` | Minimum gap between two renames of the same session |
| `recentTurns` | How much of the tail the model is shown |
| `maxLength` | Titles longer than this are clipped at a word boundary |

Subagent sessions are skipped — they never appear in the picker, so naming them
serves nobody — as are the plugin's own scratch sessions, which would otherwise
rename themselves in a loop. `session_rename` ignores the threshold and the
cooldown, since asking for a rename by hand should not be refused by gates that
exist only to keep the automatic path cheap.

The rename runs in a throwaway session that is deleted afterwards, so the
transcript being renamed is never perturbed by having been read. A model that
times out, fails, or answers with prose rather than a title leaves the existing
title alone: a wrong title is worse than a stale one. Every decision, including
each skip, is listed on the **Info** tab.

## Configuration

All state lives under `~/.config/opencode/`:

| File | Owner |
| --- | --- |
| `device.json` | this device's identity |
| `session-index.json` | session-manager |
| `bark-notify.json`, `bark-notify-queue.json` | bark-notify |
| `cpa-usage.json` | cpa-usage |
| `task-queue.json`, `task-queue-retry.json` | task-queue |
| `session-rename.json` | session-rename |
| `plugin-manager.json` | which plugins are enabled |
| `marketplace.json`, `marketplace-cache.json` | marketplace source and the last update check |

`bark-notify` migrates `~/.dsh/bark-notify.json` and `~/.codex/bark-notify.json`
on first read. `cpa-usage` reads its API key from the `cpa` provider block in
`opencode.json`, then Codex's `config.toml`, then `CPA_API_KEY`; it never writes
the key back.
