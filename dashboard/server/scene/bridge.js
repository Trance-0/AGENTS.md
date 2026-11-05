import { poolCodex, tokenTotals } from "../metrics/pool.js";

// Metric widget bridge: computes the public metric values server-side from the
// existing metrics data and records them as one `widget/metrics` event per
// refresh, so replay matches what viewers saw (decisions 1-3).
//
// - Only sources used by a metric widget in the live scene are published; a
//   stream without metric widgets never puts metrics in its recording.
// - While such a stream is live, the CPA quota is refreshed every 5 minutes
//   through the shared single-flight refresher. A failed refresh keeps the
//   last snapshot; its `updatedAt` lets the widget show the value's age.
// - Values are pooled numbers only: no account labels, emails, or raw data.
export const REFRESH_MS = 5 * 60 * 1000;
const CPA_SOURCES = { "cpa.codex.5h": "fiveHour", "cpa.codex.week": "week" };

// Three significant figures, so token counters do not publish every tick of usage.
const roundTokens = value => (value < 1000 ? value : Number(value.toPrecision(3)));

export function metricValues(sources, { snapshot, cpaEnabled, metrics, now }) {
  const values = {};
  const pooled = cpaEnabled ? poolCodex(snapshot, now) : null;
  const totals = [...sources].some(source => source.startsWith("tokens.")) ? tokenTotals(metrics, now) : null;
  for (const source of sources) {
    if (CPA_SOURCES[source]) {
      const window = pooled?.[CPA_SOURCES[source]];
      values[source] = window ? { ...window, updatedAt: pooled.updatedAt } : { remainingPercent: null, resetAt: null, accounts: 0, total: 0, updatedAt: null };
    } else if (source === "tokens.today") values[source] = { tokens: roundTokens(totals.today) };
    else if (source === "tokens.7d") values[source] = { tokens: roundTokens(totals.week) };
  }
  return values;
}

export class MetricsBridge {
  constructor({ scene, broadcast, metrics, quota, secrets, isEnabled, emit = () => {}, now = Date.now }) {
    Object.assign(this, { scene, broadcast, metrics, quota, secrets, isEnabled, emit, now });
    this.published = { recordingId: null, values: {} };
    this.running = null;
    scene.onChange(reason => { this.publish().catch(() => {}); if (reason === "open") this.cycle(); });
  }

  sourcesInUse() {
    return new Set((this.scene.liveWidgets() || []).filter(widget => widget.type === "metric").map(widget => widget.props.source));
  }

  // Publishes changed values for the sources in use; at most one event per call.
  async publish() {
    const active = this.broadcast.active;
    const sources = this.sourcesInUse();
    if (!active || !sources.size) return null;
    if (this.published.recordingId !== active.id) this.published = { recordingId: active.id, values: {} };
    const cpaEnabled = await this.isEnabled("cpa-quota");
    const values = metricValues(sources, { snapshot: this.quota.snapshot(), cpaEnabled, metrics: this.metrics, now: this.now() });
    const changed = Object.fromEntries(Object.entries(values).filter(([source, value]) => JSON.stringify(this.published.values[source]) !== JSON.stringify(value)));
    if (!Object.keys(changed).length) return null;
    const event = this.scene.publish("dashboard", "metrics", "metrics", { values: changed }, { force: true });
    if (event) Object.assign(this.published.values, changed);
    return event;
  }

  // One refresh cycle: refresh CPA if a CPA widget is live, then publish.
  cycle() {
    if (this.running) return this.running;
    this.running = (async () => {
      const sources = this.sourcesInUse();
      if (!this.broadcast.active || !sources.size) return null;
      const needsCpa = [...sources].some(source => CPA_SOURCES[source]);
      if (needsCpa && this.secrets.read() && (await this.isEnabled("cpa-quota"))) {
        try { await this.quota.refresh(); }
        catch (error) {
          // 429: a refresh ran within 30 s, so the stored snapshot is fresh enough.
          if (error.status !== 429) this.emit({ source: "dashboard", level: "warn", msg: `Scene metric kept its last value: dashboard/scene metrics refresh — ${error.message.split(" — ").at(-1)}` });
        }
      }
      return this.publish();
    })().finally(() => { this.running = null; });
    return this.running;
  }

  start(intervalMs = REFRESH_MS) {
    const timer = setInterval(() => this.cycle().catch(() => {}), intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}
