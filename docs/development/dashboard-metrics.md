# Dashboard usage metrics

The **Usage** group has three administrator-only tabs: **Summary**, **CPA
quota**, and **Token metrics** (panels `usage-summary`, `cpa-quota`,
`usage-metrics`). Both the panel registry and every metrics API check the
Casdoor administrator role.

**Public feed policy (changed in 0.2.0).** Raw metrics, per-account quota,
prices, and costs never enter the public stream feed. The only metric values
that do are the owner-approved pooled aggregates shown by scene **metric
widgets** (see "Public metric widgets" below), and only while such a widget is
on the live scene. Because every recorded event is public, those values stay in
the recording for replay.

## Usage summary (pooled)

`GET /api/admin/metrics/summary` (admin, `usage-summary` panel enabled) returns
token totals for today (UTC), the last 7 days, and the last 30 days, and the
pooled Codex quota from the last stored CPA snapshot
(`server/metrics/pool.js`):

- Every Codex account (`codex`/`openai` provider) has equal weight.
- Windows are classified by length (`limit_window_seconds` within an hour of
  5 hours, or within a day of 7 days), not by the provider's primary/secondary
  label. Snapshots taken before 0.1.8 lack the length and count as unknown
  until the next refresh.
- The value is the mean remaining percentage, rounded down (a nonzero mean
  below 1% shows 1%, so 0% always means every counted account is exhausted).
- "Next reset" is the earliest future reset among the counted accounts.
- Accounts without a known window of that length are excluded and reported
  as "n of m accounts".
- No labels, IDs, emails, or raw responses leave the pool. The CPA quota tab
  keeps its per-account view. Pooled CPA is hidden while that panel is disabled.

### Stale-window normalization (0.2.4)

A stored snapshot is a point-in-time copy and goes stale between refreshes.
Every reader (the CPA quota tab, the Usage Summary, the public `cpa.codex.*`
widget values) reads it through one shared function,
`normalizeQuota(snapshot, now)` in `server/metrics/quota-normalize.js`, so all
surfaces agree. Other features that show quota should call it too. It applies
two rules at read time and never rewrites the stored snapshot:

1. **Reset passed.** A window whose reported reset time is at or before `now`
   counts as reset: 100% remaining, reset time unknown (the next window starts
   on first use), until the next refresh.
2. **Unused week (Codex).** When an account's weekly window shows 0 usage
   (100% remaining), its 5-hour window also counts as 0 used. Rule 2 runs
   after rule 1, so a passed weekly reset clears the 5-hour window too.

A corrected window keeps the snapshot's value in `reported` and the reason in
`assumed` (`reset-passed` or `weekly-unused`); the CPA quota tab shows that
note under the window. Pooled values carry neither.

## CC Switch references

Reviewed [farion1231/cc-switch](https://github.com/farion1231/cc-switch) at
commit `ca58c0313360eae7c851fbd7553c1614c7af03e7` before implementation:

- [UsageDashboard.tsx](https://github.com/farion1231/cc-switch/blob/ca58c0313360eae7c851fbd7553c1614c7af03e7/src/components/usage/UsageDashboard.tsx): range, provider/model filters, metric switching.
- [UsageTrendChart.tsx](https://github.com/farion1231/cc-switch/blob/ca58c0313360eae7c851fbd7553c1614c7af03e7/src/components/usage/UsageTrendChart.tsx): token/cost trends, separate cache tokens, stable time buckets, accessible detail labels.
- [UsageHero.tsx](https://github.com/farion1231/cc-switch/blob/ca58c0313360eae7c851fbd7553c1614c7af03e7/src/components/usage/UsageHero.tsx) and [ModelStatsTable.tsx](https://github.com/farion1231/cc-switch/blob/ca58c0313360eae7c851fbd7553c1614c7af03e7/src/components/usage/ModelStatsTable.tsx): summary cards and model decomposition.
- [database/schema.rs](https://github.com/farion1231/cc-switch/blob/ca58c0313360eae7c851fbd7553c1614c7af03e7/src-tauri/src/database/schema.rs) and [dao/usage_rollup.rs](https://github.com/farion1231/cc-switch/blob/ca58c0313360eae7c851fbd7553c1614c7af03e7/src-tauri/src/database/dao/usage_rollup.rs): indexed SQLite events, deduplication, separate pricing, transaction boundaries.

This dashboard implements those patterns in its existing vanilla JavaScript
and SVG UI. It does not copy CC Switch source or add its React/Tauri runtime.
The first release retains detailed events rather than deleting them into
rollups, so pricing corrections can still recalculate historical estimates.

## OpenClaw collection

`openclaw-plugin/usage-log.js` consumes `llm_output` from the installed
`dashboard-stream` plugin, independently of whether a stream is live. It writes
`usage-YYYY-MM-DD.jsonl` beside existing activity files. The dashboard mounts
that shared directory read-only. The public activity reader only accepts
`activity-*.jsonl`; usage files are consumed separately by the metrics reader.

The hook supplies aggregate input/output/cache counts for a model attempt,
including tool continuations. One record is an attempt, not one API request.
Zero-token errors without usage are excluded, so attempt counts are not a
complete error/request counter. No prompts, responses, session keys, API
keys, commands, or file contents are written to usage files.

Routes retain their actual provider identifier, such as `cpa`, `openai`, and
`openai-codex`. Models are kept separately. Retries that report usage retain
their actual route/model. The stable event ID prevents replay from adding
usage twice. Collection starts when the plugin is installed; old transcripts
are not imported.

The Node 22 built-in SQLite module stores events, indexes, ingest cursors,
prices, and the last quota snapshot. Events and cursors commit atomically;
restart, truncation, rotation, and partial writes are safe to replay. Metrics
persist under `METRICS_DATA_DIR`, a host-backed bind mount. No new npm
dependencies or native SQLite add-ons are required.

## Tokens and estimated price

The panel has 24-hour, 7-day, 30-day, and 90-day ranges, route/model filters,
stacked trend bars with tooltips, summary cards, and route/model tables.
Token totals equal fresh input + output + cache read + cache write. Daily
buckets use UTC and the browser displays local labels.

Prices are USD per million tokens, separately for each route/model and token
category. A nonzero OpenClaw configured rate can supply the initial estimate.
Zero-filled model templates are treated as unknown, not free. Administrator
rates override estimates at query time, including historical events. Explicit
zero rates are supported. Unknown prices remain visible as unpriced attempts
and are excluded from the known subtotal. These are estimates, not provider
invoices; OAuth/subscription traffic may have no per-token invoice.

## CPA quota and credential encryption

The administrator enters the remote CPA dashboard URL and its **management
key**, distinct from an inference API key. The key is encrypted with
AES-256-GCM using a fresh nonce and authenticated context. Only ciphertext is
saved on the dashboard side. The independent 32-byte master key is stored in
the host secrets directory and mounted read-only into the dashboard; it is
never mounted into OpenClaw. The UI only receives connection status and the
endpoint, never the saved management key.

Quota collection uses CPA `/v0/management/auth-files` and `/api-call` to read
upstream account quota windows. Supported account types include Claude,
Codex, and Antigravity. Unsupported accounts and missing windows show unknown,
not zero. Accounts remain separate because differing plan limits make pooled
percentages misleading. Account filenames/emails and upstream raw responses
are excluded from returned data. Reset times come from provider responses.

Refresh is explicit, limited to once every 30 seconds, and concurrent refreshes
share one request. A failed refresh preserves the previous timestamped
snapshot. Changing/removing credentials invalidates the snapshot and any
in-flight result. HTTPS is required and redirects are rejected. Credentials
are never sent to a changed endpoint unless entered again.

## Verification

Server tests cover encryption and tampering, key omission, role/CSRF/soft-toggle
gates, partial records and replay, route/model aggregation, pricing and unknown
costs, quota parsing, refresh invalidation, and OpenClaw hook integration.
`dashboard/scripts/metrics-browser-check.mjs` exercises guest/viewer isolation,
admin filters and views, tooltip data, responsive layout, and credential save,
reload, and removal. It runs with the existing isolated OIDC browser fixture.

The live CPA quota cannot be verified before an administrator supplies their
management key in the panel. No existing private management credential is
imported automatically. The initial connection state is intentionally empty.

## Public metric widgets (0.2.0)

A scene metric widget shows one of four sources, computed server-side by
`server/scene/bridge.js` from the data above:

| Source | Value published | Shown as |
|---|---|---|
| `cpa.codex.5h` | pooled mean remaining %, earliest reset, n, m, snapshot time | `62%`, `resets in 2h 14m · 3 of 4 accounts` |
| `cpa.codex.week` | same, weekly window | `resets in 3d 5h 7m` |
| `tokens.today` | tokens since 00:00 UTC, 3 significant figures | `1.23M` |
| `tokens.7d` | tokens in the last 7 days, 3 significant figures | `12.3M` |

- Pooling is the same as the admin Summary tab (`poolCodex`): equal weights,
  windows classified by length, unknown windows excluded and counted as
  "n of m accounts". No labels, IDs, emails, raw responses, or costs.
- Only sources used by a metric widget in the live scene are published, as a
  single `widget`/`metrics` event per refresh and only when a value changed.
  A stream without metric widgets records no metrics.
- While a CPA metric widget is on a live stream, the CPA quota is refreshed
  every 5 minutes through the same single-flight refresher as the admin button
  (30-second minimum interval). No background refresh runs while offline or
  when the CPA quota panel is disabled. A failed refresh keeps the last
  snapshot; the widget shows "as of N ago" once the value is older than
  10 minutes.
- Countdown and age are computed in the browser from the recorded reset time
  and the playback time, so replay shows what viewers saw at that moment.

