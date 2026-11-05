// Read-time normalization of the stored CPA quota snapshot. Every surface (the
// admin CPA tab, the Usage Summary, and the public metric widgets) reads the
// snapshot through this function, so they always agree.
//
// A snapshot is a point-in-time copy of upstream quota windows and goes stale
// between refreshes. Two rules correct what is known to have changed since:
//
// 1. Reset passed: a window whose reported reset time is already in the past
//    has reset, so it counts as 0 used (100% remaining) until the next
//    refresh. Its reset time becomes unknown: the provider starts the next
//    window on first use, so the old time says nothing about the next one.
// 2. Unused week (Codex): when an account's weekly window shows 0 usage, its
//    5-hour window cannot hold usage either (every 5-hour request also counts
//    toward the week), so a nonzero 5-hour value is stale and counts as 0 used.
//
// Corrected windows keep the reported value in `reported` and say why in
// `assumed` ("reset-passed" or "weekly-unused") for the admin tab. Pure: the
// stored snapshot is never modified.
import { windowClass } from "./window-class.js";

const CODEX_PROVIDERS = new Set(["codex", "openai"]);
const FULL = 100;

export function normalizeQuota(snapshot, now = Date.now()) {
  if (!snapshot || !Array.isArray(snapshot.accounts)) return snapshot ?? null;
  return { ...snapshot, accounts: snapshot.accounts.map(account => normalizeAccount(account, now)) };
}

function normalizeAccount(account, now) {
  if (!Array.isArray(account?.windows)) return account;
  let windows = account.windows.map(window => {
    if (window?.assumed || !Number.isFinite(window?.resetsAt) || window.resetsAt > now) return window;
    return { ...window, remainingPercent: FULL, resetsAt: null, reported: { remainingPercent: window.remainingPercent ?? null, resetsAt: window.resetsAt }, assumed: "reset-passed" };
  });
  if (CODEX_PROVIDERS.has(String(account.provider || "").toLowerCase())) {
    const weekUnused = windows.some(window => windowClass(window.windowSeconds) === "week" && window.remainingPercent === FULL);
    if (weekUnused) {
      windows = windows.map(window => windowClass(window.windowSeconds) !== "fiveHour" || window.assumed || !Number.isFinite(window.remainingPercent) || window.remainingPercent >= FULL ? window
        : { ...window, remainingPercent: FULL, resetsAt: null, reported: { remainingPercent: window.remainingPercent, resetsAt: window.resetsAt ?? null }, assumed: "weekly-unused" });
    }
  }
  return { ...account, windows };
}
