import assert from "node:assert/strict";
import test from "node:test";
import { poolCodex, windowClass } from "./metrics/pool.js";
import { quotaWindow } from "./metrics/cpa.js";
import { normalizeQuota } from "./metrics/quota-normalize.js";
import { createQuotaRefresher } from "./metrics/quota-refresh.js";
import { metricValues } from "./scene/bridge.js";
import { UsageLine } from "./usage-line.js";
import { BroadcastStore } from "./broadcast.js";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
  assert.deepEqual(poolCodex({ accounts: [account("codex", [w(18000, 0, 20)]), account("codex", [w(18000, 0.4, 10)])] }, now).fiveHour, { remainingPercent: 1, resetAt: now + 10, accounts: 2, total: 2 }, "a nearly empty pool never reads 0");
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

test("an unused Codex week means an unused 5-hour window, on every surface", () => {
  // The weekly window shows 0 usage (100% remaining) but a stale 5-hour value remains.
  const stale = { updatedAt: now - 60e3, accounts: [
    account("codex", [{ ...w(18000, 35, 3 * 3600e3), label: "Primary window" }, { ...w(604800, 100, 6 * 86400e3), label: "Secondary window" }]),
    account("codex", [w(18000, 40, 3600e3), w(604800, 60, 2 * 86400e3)]), // used this week: unchanged
    account("claude", [w(18000, 10, 3600e3), w(604800, 100, 86400e3)]), // not Codex: unchanged
  ] };
  const normalized = normalizeQuota(stale, now);
  const [first, second, claude] = normalized.accounts;
  assert.deepEqual(first.windows[0], { label: "Primary window", windowSeconds: 18000, remainingPercent: 100, resetsAt: null, reported: { remainingPercent: 35, resetsAt: now + 3 * 3600e3 }, assumed: "weekly-unused" });
  assert.deepEqual(first.windows[1], stale.accounts[0].windows[1], "the weekly window itself is untouched");
  assert.deepEqual(second, stale.accounts[1]);
  assert.deepEqual(claude, stale.accounts[2]);
  assert.equal(stale.accounts[0].windows[0].remainingPercent, 35, "the stored snapshot is not modified");
  assert.deepEqual(normalizeQuota(normalized, now), normalized, "normalizing twice changes nothing");
  // Usage Summary and the public widget both pool the normalized view.
  const pooled = poolCodex(stale, now);
  assert.deepEqual(pooled.fiveHour, { remainingPercent: 70, resetAt: now + 3600e3, accounts: 2, total: 2 }, "(100 + 40) / 2, and the stale reset is not the next reset");
  const values = metricValues(new Set(["cpa.codex.5h"]), { snapshot: stale, cpaEnabled: true, metrics: null, now });
  assert.deepEqual(values["cpa.codex.5h"], { ...pooled.fiveHour, updatedAt: stale.updatedAt });
  // The admin CPA tab reads the snapshot through the refresher, which normalizes too.
  const store = { value: stale, getSetting: () => store.value, setSetting: (_name, value) => { store.value = value; } };
  const refresher = createQuotaRefresher({ store, secrets: { read: () => null }, now: () => now });
  assert.deepEqual(refresher.snapshot(), normalized);
  assert.equal(refresher.snapshot().accounts[0].windows[0].remainingPercent, 100);
});

test("a window whose reset time has passed counts as reset until the next refresh", () => {
  // Shape of the real stored snapshot on 2026-11-05: every Codex 5-hour reset
  // had passed minutes before it was read; one weekly window was exhausted.
  const snapshot = { updatedAt: now - 12 * 60e3, accounts: [
    account("codex", [w(18000, 72, -9 * 60e3), w(604800, 0, 82 * 3600e3)]),
    account("codex", [w(18000, 0, -8 * 60e3), w(604800, 31, 128 * 3600e3)]),
    account("codex", [w(18000, 0, -8 * 60e3), w(604800, 30, 128 * 3600e3)]),
    account("antigravity", [], { error: "Quota unavailable: dashboard/CPA account — upstream response could not be read." }),
  ] };
  const normalized = normalizeQuota(snapshot, now);
  // Accounts 2 and 3 (weeks at 31% and 30%): the passed 5-hour reset counts as reset.
  for (const item of normalized.accounts.slice(1, 3)) {
    assert.equal(item.windows[0].remainingPercent, 100);
    assert.equal(item.windows[0].resetsAt, null, "the next reset is unknown until the next refresh");
    assert.equal(item.windows[0].assumed, "reset-passed");
  }
  assert.equal(normalized.accounts[1].windows[0].reported.remainingPercent, 0);
  // Account 1 (week exhausted): the passed 5-hour reset does not restore capacity.
  assert.deepEqual(normalized.accounts[0].windows[0], { label: "Primary window", windowSeconds: 18000, remainingPercent: 0, resetsAt: null, reported: { remainingPercent: 72, resetsAt: now - 9 * 60e3 }, assumed: "weekly-exhausted" });
  assert.deepEqual(normalized.accounts.slice(0, 3).map(item => item.windows[1]), snapshot.accounts.slice(0, 3).map(item => item.windows[1]), "weekly windows with future resets are untouched");
  const pooled = poolCodex(snapshot, now);
  assert.deepEqual(pooled.fiveHour, { remainingPercent: 66, resetAt: null, accounts: 3, total: 3 }, "(0 + 100 + 100) / 3");
  assert.deepEqual(pooled.week, { remainingPercent: 20, resetAt: now + 82 * 3600e3, accounts: 3, total: 3 });
  // A passed weekly reset also clears the 5-hour window (rule 2 follows rule 1).
  const week = normalizeQuota({ accounts: [account("codex", [w(18000, 50, 3600e3), w(604800, 10, -1)])] }, now).accounts[0].windows;
  assert.deepEqual(week.map(item => [item.remainingPercent, item.assumed]), [[100, "weekly-unused"], [100, "reset-passed"]]);
  // Exactly at the reset time counts as passed; a reset in the future does not.
  assert.equal(normalizeQuota({ accounts: [account("codex", [w(18000, 5, 0)])] }, now).accounts[0].windows[0].remainingPercent, 100);
  assert.equal(normalizeQuota({ accounts: [account("codex", [w(18000, 5, 1)])] }, now).accounts[0].windows[0].remainingPercent, 5);
  // Unknown remaining with a passed reset becomes known: the window has reset.
  assert.equal(normalizeQuota({ accounts: [account("codex", [w(18000, null, -1)])] }, now).accounts[0].windows[0].remainingPercent, 100);
  assert.equal(normalizeQuota(null, now), null);
  assert.ok(!/label|account \d|upstream/.test(JSON.stringify(pooled)), "pooled output stays label-free");
});

test("an exhausted Codex week counts its 5-hour window as 0% remaining", () => {
  const exhausted = (fiveHourResetIn, weekResetIn = 82 * 3600e3) => ({ updatedAt: now - 60e3, accounts: [
    account("codex", [w(18000, 72, fiveHourResetIn), w(604800, 0, weekResetIn)]),
    account("codex", [w(18000, 40, 3600e3), w(604800, 50, 86400e3)]),
  ] });
  // 72% on the 5-hour window, week exhausted: 0 in the pool.
  const plain = normalizeQuota(exhausted(2 * 3600e3), now).accounts[0].windows[0];
  assert.deepEqual([plain.remainingPercent, plain.resetsAt, plain.assumed, plain.reported], [0, null, "weekly-exhausted", { remainingPercent: 72, resetsAt: now + 2 * 3600e3 }]);
  assert.deepEqual(poolCodex(exhausted(2 * 3600e3), now).fiveHour, { remainingPercent: 20, resetAt: now + 3600e3, accounts: 2, total: 2 }, "(0 + 40) / 2; the exhausted account's 5-hour reset is not the next reset");
  assert.deepEqual(poolCodex({ accounts: [exhausted(2 * 3600e3).accounts[0]] }, now).fiveHour.remainingPercent, 0);
  // The 5-hour reset has passed: still 0 while the week is exhausted.
  const passed = normalizeQuota(exhausted(-5 * 60e3), now).accounts[0].windows[0];
  assert.deepEqual([passed.remainingPercent, passed.assumed, passed.reported.remainingPercent], [0, "weekly-exhausted", 72]);
  assert.equal(poolCodex({ accounts: [exhausted(-5 * 60e3).accounts[0]] }, now).fiveHour.remainingPercent, 0);
  // The weekly reset itself has passed: the week counts as reset, so the 5-hour rule does not fire.
  const weekReset = normalizeQuota(exhausted(2 * 3600e3, -1), now).accounts[0].windows;
  assert.equal(weekReset[1].assumed, "reset-passed");
  assert.deepEqual([weekReset[0].remainingPercent, weekReset[0].assumed], [100, "weekly-unused"], "not forced to 0; the reset week is unused, so rule 2 applies as before");
  // Idempotent, and the stored snapshot is unchanged.
  const once = normalizeQuota(exhausted(-5 * 60e3), now);
  assert.deepEqual(normalizeQuota(once, now), once);
  // Not Codex: an exhausted Claude week leaves its 5-hour window alone.
  assert.equal(normalizeQuota({ accounts: [account("claude", [w(18000, 72, 3600e3), w(604800, 0, 86400e3)])] }, now).accounts[0].windows[0].remainingPercent, 72);
});

test("the usage line (OpenClaw replies) picks up the exhausted-week rule through normalizeQuota", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "usage-exhausted-"));
  try {
    const broadcast = new BroadcastStore(directory);
    const live = broadcast.start("Usage");
    // The real snapshot's shape: one exhausted week (5h said 72%), two 5-hour resets passed.
    const snapshot = { updatedAt: now - 60e3, accounts: [
      account("codex", [w(18000, 72, -9 * 60e3), w(604800, 0, 82 * 3600e3)]),
      account("codex", [w(18000, 0, -8 * 60e3), w(604800, 31, 128 * 3600e3)]),
      account("codex", [w(18000, 0, -8 * 60e3), w(604800, 30, 128 * 3600e3)]),
    ] };
    const quota = { snapshot: () => normalizeQuota(snapshot, now), refresh: async () => snapshot };
    const line = new UsageLine({ broadcast, metrics: { routeTotals: () => [] }, quota, secrets: { read: () => ({}) }, isEnabled: async () => true, now: () => now });
    const event = await line.after(live.id);
    assert.match(event.msg, /Codex pool 5h 66% left; weekly 20% left, resets in 3d 10h 0m/);
    assert.equal(event.usage.codex.fiveHour.remainingPercent, 66);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
