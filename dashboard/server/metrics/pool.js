// Pooled, public-safe aggregates of the CPA quota snapshot and token usage.
//
// Owner decision (ai-platform-design/stream-scenes.md section 8.1): every
// available Codex account counts with equal weight. Windows are classified by
// their length (about 5 hours, about 7 days), never by the provider's
// primary/secondary label. Accounts without a known window of a class are
// excluded from that class's mean and reported as "n of m accounts". Only
// numbers leave this module: no account labels, IDs, emails, or raw responses.

import { normalizeQuota } from "./quota-normalize.js";
import { FIVE_HOURS, ONE_WEEK, windowClass } from "./window-class.js";

export { FIVE_HOURS, ONE_WEEK, windowClass };
const CODEX_PROVIDERS = new Set(["codex", "openai"]);

// { fiveHour, week, updatedAt } where each window is
// { remainingPercent (integer mean or null), resetAt (earliest future reset or null), accounts: n, total: m }.
// The snapshot is normalized first (server/metrics/quota-normalize.js: passed
// resets and unused weeks count as 0 used), the same view the admin CPA tab shows.
export function poolCodex(rawSnapshot, now = Date.now()) {
  const snapshot = normalizeQuota(rawSnapshot, now);
  const accounts = (snapshot?.accounts || []).filter(account => CODEX_PROVIDERS.has(String(account.provider || "").toLowerCase()));
  const result = { updatedAt: Number.isFinite(snapshot?.updatedAt) ? snapshot.updatedAt : null };
  for (const name of ["fiveHour", "week"]) {
    const values = [];
    let resetAt = null;
    for (const account of accounts) {
      const window = (account.windows || []).find(item => windowClass(item.windowSeconds) === name && Number.isFinite(item.remainingPercent));
      if (!window) continue;
      values.push(Math.max(0, Math.min(100, window.remainingPercent)));
      if (Number.isFinite(window.resetsAt) && window.resetsAt > now && (resetAt === null || window.resetsAt < resetAt)) resetAt = window.resetsAt;
    }
    const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    // Round toward the limit so a nearly exhausted pool never reads as more capacity than it has.
    result[name] = { remainingPercent: mean === null ? null : mean > 0 && mean < 1 ? 1 : Math.floor(mean + 1e-9), resetAt, accounts: values.length, total: accounts.length };
  }
  return result;
}

const DAY = 86400000;

// UTC day boundaries, matching the usage panel's daily buckets.
export function tokenTotals(store, now = Date.now()) {
  const startOfDay = Math.floor(now / DAY) * DAY;
  return {
    today: store.tokensBetween(startOfDay, now),
    week: store.tokensBetween(now - 7 * DAY, now),
    month: store.tokensBetween(now - 30 * DAY, now),
  };
}
