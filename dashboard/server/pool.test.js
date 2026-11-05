import assert from "node:assert/strict";
import test from "node:test";
import { poolCodex, windowClass } from "./metrics/pool.js";
import { quotaWindow } from "./metrics/cpa.js";
import { formatAge, formatCountdown, formatTokens } from "../public/scene/format.js";

const now = Date.UTC(2026, 10, 5, 12);
const account = (provider, windows, extra = {}) => ({ id: "x", provider, label: `${provider} account`, windows, ...extra });
const w = (windowSeconds, remainingPercent, resetsIn) => ({ label: "Primary window", windowSeconds, remainingPercent, resetsAt: resetsIn === null ? null : now + resetsIn });

test("Codex windows are classified by length, not by primary/secondary label", () => {
  assert.equal(windowClass(18000), "fiveHour");
  assert.equal(windowClass(604800), "week");
  assert.equal(windowClass(86400), null);
  assert.equal(windowClass(undefined), null);
  const parsed = quotaWindow({ used_percent: 40, limit_window_seconds: 604800, reset_after_seconds: 60 }, "codex", now);
  assert.deepEqual(parsed, { remainingPercent: 60, resetsAt: now + 60000, windowSeconds: 604800 });
  assert.equal("windowSeconds" in quotaWindow({ used_percent: 1 }, "codex", now), false);
});

test("pooled Codex quota is an equal-weight mean with the earliest reset and n of m accounts", () => {
  const snapshot = {
    updatedAt: now - 120000,
    accounts: [
      // Labels are swapped on purpose: classification must use the window length.
      account("codex", [{ ...w(604800, 80, 3 * 86400e3), label: "Primary window" }, { ...w(18000, 50, 2 * 3600e3), label: "Secondary window" }]),
      account("codex", [w(18000, 25, 3600e3), w(604800, 41, 86400e3)]),
      account("codex", [w(null, 90, 600e3)]), // unknown window length: excluded
      account("codex", [], { error: "Quota unavailable: dashboard/CPA account — upstream response could not be read." }),
      account("claude", [w(18000, 5, 60e3)]), // not a Codex account
    ],
  };
  const pooled = poolCodex(snapshot, now);
  assert.deepEqual(pooled, {
    updatedAt: now - 120000,
    fiveHour: { remainingPercent: 37, resetAt: now + 3600e3, accounts: 2, total: 4 },
    week: { remainingPercent: 60, resetAt: now + 86400e3, accounts: 2, total: 4 },
  });
  assert.ok(!/label|codex account|upstream/.test(JSON.stringify(pooled)), "no labels or raw errors leave the pool");
  assert.deepEqual(poolCodex({ accounts: [account("codex", [w(18000, 0, -5)]), account("codex", [w(18000, 0.4, 10)])] }, now).fiveHour, { remainingPercent: 1, resetAt: now + 10, accounts: 2, total: 2 }, "a nearly empty pool never reads 0, past resets are ignored");
  assert.equal(poolCodex({ accounts: [account("codex", [w(18000, 0, 10)])] }, now).fiveHour.remainingPercent, 0);
  assert.deepEqual(poolCodex(null, now).week, { remainingPercent: null, resetAt: null, accounts: 0, total: 0 });
});

test("countdown, token, and age formats", () => {
  assert.equal(formatCountdown(2 * 3600e3 + 14 * 60e3), "2h 14m");
  assert.equal(formatCountdown(3 * 86400e3 + 5 * 3600e3 + 7 * 60e3, true), "3d 5h 7m");
  assert.equal(formatCountdown(30e3), "0h 1m", "partial minutes round up");
  assert.equal(formatCountdown(-5), "0h 0m");
  assert.equal(formatCountdown(NaN), null);
  assert.deepEqual([950, 12345, 1840000, 999999, 2.5e9].map(formatTokens), ["950", "12.3K", "1.84M", "1M", "2.5B"]);
  assert.equal(formatAge(125 * 60e3), "2h 5m");
});
