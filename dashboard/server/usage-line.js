import { poolCodex } from "./metrics/pool.js";
import { formatCountdown, formatTokens } from "../public/scene/format.js";

// One public usage line after each final host reply (owner request, see
// docs/deployment/dashboard.md "Usage line"). It is a normal log event, so
// replays show it, and it carries pooled numbers only: the Codex pool from the
// shared normalization (poolCodex: the Usage Summary's view), and today's
// (UTC) tokens and estimated cost from the metrics store with the paid
// fallback (every route except CPA) broken out. No account labels, emails, or
// raw responses.
//
// Limits: at most one line per reply and one per MIN_GAP_MS overall, built
// from cached values. The CPA quota is refreshed upstream only when the stored
// snapshot is at least REFRESH_MS old and this module has not tried within
// REFRESH_MS; the line waits at most REFRESH_WAIT_MS for that refresh.
export const MIN_GAP_MS = 10_000;
export const REFRESH_MS = 5 * 60 * 1000;
const REFRESH_WAIT_MS = 8000;
const DAY = 86400000;
const PAID_ROUTE = route => route !== "cpa";

const money = value => (value < 0.01 && value > 0 ? "<$0.01" : `$${value.toFixed(2)}`);

export function usageText({ pooled, routes, now }) {
  const parts = [];
  if (!pooled || (pooled.fiveHour.remainingPercent === null && pooled.week.remainingPercent === null)) parts.push("Codex pool unavailable");
  else {
    const window = (data, label, days) => data.remainingPercent === null ? `${label} unknown` : `${label} ${data.remainingPercent}% left${data.resetAt ? `, resets in ${formatCountdown(data.resetAt - now, days)}` : ""}`;
    const age = Number.isFinite(pooled.updatedAt) && now - pooled.updatedAt >= 2 * REFRESH_MS ? ` (quota as of ${Math.round((now - pooled.updatedAt) / 60000)}m ago)` : "";
    parts.push(`Codex pool ${window(pooled.fiveHour, "5h", false)}; ${window(pooled.week, "weekly", true)}${age}`);
  }
  const sum = (list, key) => list.reduce((total, row) => total + (row[key] ?? 0), 0);
  const paid = routes.filter(row => PAID_ROUTE(row.route));
  const tokens = sum(routes, "tokens"), paidTokens = sum(paid, "tokens");
  const priced = routes.filter(row => row.costUsd !== null), unpriced = sum(routes, "unpriced");
  const cost = priced.length ? `est. ${money(sum(priced, "costUsd"))}${unpriced ? ` known, ${unpriced} unpriced attempt${unpriced === 1 ? "" : "s"}` : ""}` : "est. cost unpriced";
  const paidCost = paid.some(row => row.costUsd !== null) ? `, est. ${money(sum(paid.filter(row => row.costUsd !== null), "costUsd"))}` : "";
  parts.push(`today ${formatTokens(tokens)} tokens, ${cost}; paid fallback ${formatTokens(paidTokens)} tokens${paidCost}`);
  return `Usage after reply: dashboard/usage — ${parts.join(" · ")}.`;
}

export class UsageLine {
  constructor({ broadcast, metrics, quota, secrets, isEnabled, emit = () => {}, now = Date.now }) {
    Object.assign(this, { broadcast, metrics, quota, secrets, isEnabled, emit, now });
    this.lastLine = 0;
    this.lastRefresh = 0;
    this.pending = null;
  }

  async freshQuota(cpaEnabled) {
    if (!cpaEnabled || !this.secrets.read?.()) return;
    const snapshot = this.quota.snapshot();
    const time = this.now();
    if (snapshot?.updatedAt && time - snapshot.updatedAt < REFRESH_MS) return;
    if (time - this.lastRefresh < REFRESH_MS) return;
    this.lastRefresh = time;
    let timer;
    await Promise.race([
      this.quota.refresh().catch(() => {}),
      new Promise(resolve => { timer = setTimeout(resolve, REFRESH_WAIT_MS); timer.unref?.(); }),
    ]).finally(() => clearTimeout(timer));
  }

  // Posts one line to `recordingId` if it is still live; null when skipped.
  after(recordingId) {
    if (!this.broadcast.active || this.broadcast.active.id !== recordingId) return Promise.resolve(null);
    if (this.pending || this.now() - this.lastLine < MIN_GAP_MS) return Promise.resolve(null);
    this.lastLine = this.now();
    this.pending = (async () => {
      try {
        const cpaEnabled = await this.isEnabled("cpa-quota");
        await this.freshQuota(cpaEnabled);
        const now = this.now();
        const pooled = cpaEnabled ? poolCodex(this.quota.snapshot(), now) : null;
        const routes = this.metrics.routeTotals(Math.floor(now / DAY) * DAY, now);
        const usage = {
          ...(pooled ? { codex: { fiveHour: { remainingPercent: pooled.fiveHour.remainingPercent, resetAt: pooled.fiveHour.resetAt }, week: { remainingPercent: pooled.week.remainingPercent, resetAt: pooled.week.resetAt }, updatedAt: pooled.updatedAt } } : {}),
          today: routes.map(({ route, tokens, costUsd }) => ({ route, tokens, costUsd })),
        };
        return this.broadcast.publish({ source: "dashboard", msg: usageText({ pooled, routes, now }), usage }, recordingId);
      } catch {
        this.emit({ source: "dashboard", level: "warn", msg: "Usage line skipped: dashboard/usage — metrics could not be read." });
        return null;
      } finally { this.pending = null; }
    })();
    return this.pending;
  }
}
