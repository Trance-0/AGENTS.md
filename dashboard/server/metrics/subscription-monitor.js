// Subscription monitor: every REFRESH_MS the dashboard refreshes the CPA quota
// snapshot once and diffs it against the previous tick, pushing Bark
// notifications for the alarm types the administrator subscribed to. Edge
// alarms (depleted, new credits, reset arrived, reset requested) fire on the
// transition; the 5-hour pool status fires when its value changes. Numbers
// only leave this module — no account labels that are not already the pooled
// "account N" labels, and no device keys are ever logged.
import { detectResetFields, readResetState, resolveMapping } from "./reset-fields.js";
import { pushBark } from "./bark.js";
import { renderTemplate } from "./subscriptions.js";

export const REFRESH_MS = 5 * 60 * 1000;
const CODEX_PROVIDERS = new Set(["codex", "openai"]);

// A Codex account contributes to the 5-hour pool the *smaller* of its 5-hour
// and weekly remaining percentages, because a 5-hour request also draws down
// the weekly window (owner note: "the 5-hour window depletes the weekly
// usage"). A stale 5-hour reading of 100% beside a weekly of 5% therefore
// contributes 5%, not 100%.
export function effective5h(account) {
  const windows = account?.windows || [];
  const five = windows.find(item => windowClassOf(item) === "fiveHour");
  const week = windows.find(item => windowClassOf(item) === "week");
  const values = [five?.remainingPercent, week?.remainingPercent].filter(value => Number.isFinite(value));
  if (values.length === 0) return null;
  const cap = Math.min(...values);
  return Math.max(0, Math.min(100, cap));
}

// Classify a window by its recorded length without importing pool internals.
function windowClassOf(window) {
  const seconds = window?.windowSeconds;
  if (!Number.isFinite(seconds)) return null;
  if (Math.abs(seconds - 18000) <= 3600) return "fiveHour";
  if (Math.abs(seconds - 604800) <= 86400) return "week";
  return null;
}

export function codexAccounts(snapshot) {
  return (snapshot?.accounts || []).filter(account => CODEX_PROVIDERS.has(String(account.provider || "").toLowerCase()));
}

// Sum of per-account effective 5-hour percentages (can exceed 100: four full
// accounts read 400%). `week` is the mean weekly remaining for context.
export function pool5h(snapshot, now = Date.now()) {
  const accounts = codexAccounts(snapshot);
  let sum = 0;
  let contributing = 0;
  const weekValues = [];
  for (const account of accounts) {
    const value = effective5h(account);
    if (value !== null) { sum += value; contributing++; }
    const week = (account.windows || []).find(item => windowClassOf(item) === "week");
    if (Number.isFinite(week?.remainingPercent)) weekValues.push(week.remainingPercent);
  }
  const week = weekValues.length ? Math.floor(weekValues.reduce((total, value) => total + value, 0) / weekValues.length + 1e-9) : null;
  return { percent: contributing ? Math.round(sum) : null, accounts: contributing, total: accounts.length, week };
}

// Earliest future reset across an account's windows: when it can serve again.
export function nextAvailable(account, now = Date.now()) {
  let earliest = null;
  for (const window of account?.windows || []) {
    if (!Number.isFinite(window?.resetsAt) || window.resetsAt <= now) continue;
    if (earliest === null || window.resetsAt < earliest) earliest = window.resetsAt;
  }
  return earliest;
}

export function isDepleted(account) {
  return effective5h(account) === 0;
}

const fmt = ms => (Number.isFinite(ms) ? new Date(ms).toLocaleString() : "unknown");

// Context for a template: pooled numbers plus the account's public label only.
function contextFor(account, snapshot, now) {
  const pool = pool5h(snapshot, now);
  return {
    account: String(account?.label || account?.id || "an account"),
    provider: String(account?.provider || "codex"),
    reset: fmt(nextAvailable(account, now)),
    expire: "",
    pool5h: pool.percent === null ? "unknown" : String(pool.percent),
    week: pool.week === null ? "unknown" : String(pool.week),
    accounts: `${pool.accounts} of ${pool.total}`,
    time: new Date(now).toLocaleString(),
  };
}

export class SubscriptionMonitor {
  constructor({ subscriptions, quota, secrets, isEnabled, emit = () => {}, push = pushBark, now = Date.now }) {
    Object.assign(this, { subscriptions, quota, secrets, isEnabled, emit, push, now });
    this.previous = new Map();
    this.lastPool5h = null;
    this.lastRunAt = null;
    this.lastDelivery = [];
    this.running = null;
  }

  // One monitoring pass. Returns the deliveries it pushed (or [] when skipped).
  async tick() {
    if (this.running) return this.running;
    this.running = (async () => {
      if (!(await this.isEnabled("subscription"))) return [];
      if (!(await this.isEnabled("cpa-quota")) || !this.secrets.read?.()) return [];
      let config;
      try { config = this.subscriptions.read(); } catch (error) { this.emit({ source: "dashboard", level: "warn", msg: error.message }); return []; }
      if (!config.devices.some(device => device.enabled) || !Object.values(config.types).some(type => type.enabled)) return [];

      // Refresh upstream once per pass (single-flight; a 30 s throttle returns 429).
      try { await this.quota.refresh(); } catch (error) { if (error.status !== 429) this.emit({ source: "dashboard", level: "warn", msg: `Subscription check kept its last snapshot: dashboard/subscription monitor — ${error.message.split(" — ").at(-1)}` }); }

      const snapshot = this.quota.snapshot();
      const now = this.now();
      const mapping = resolveMapping(detectResetFields(snapshot?.accounts), config.resetFields);
      const pool = pool5h(snapshot, now);
      const deliveries = [];
      const previous = this.previous;

      for (const account of codexAccounts(snapshot)) {
        const id = account.id;
        const prev = previous.get(id);
        const depleted = isDepleted(account);
        const reset = readResetState(account, mapping);
        const base = () => contextFor(account, snapshot, now);

        if (config.types.depleted.enabled && prev && prev.depleted === false && depleted) {
          const ctx = base();
          deliveries.push(...await this.pushType(config, "depleted", ctx));
        }
        if (config.types.newCredits.enabled && prev && prev.depleted === true && !depleted) {
          deliveries.push(...await this.pushType(config, "newCredits", base()));
        }

        const arrived = Number.isFinite(reset.arrivedAt) ? reset.arrivedAt : null;
        if (config.types.resetArrived.enabled && arrived !== null && prev && prev.arrivedAt !== arrived) {
          deliveries.push(...await this.pushType(config, "resetArrived", { ...base(), expire: fmt(reset.expiresAt) }));
        }

        const unticked = reset.requested === true && reset.ticked !== true;
        if (config.types.resetRequested.enabled && unticked && prev && prev.unticked !== true) {
          deliveries.push(...await this.pushType(config, "resetRequested", base()));
        }

        previous.set(id, { depleted, arrivedAt: arrived, unticked, ticked: reset.ticked, requested: reset.requested });
      }

      // Drop accounts that disappeared from the snapshot so a returning account
      // with the same id is treated as fresh.
      for (const id of [...previous.keys()]) if (!codexAccounts(snapshot).some(account => account.id === id)) previous.delete(id);

      if (config.types.pool5h.enabled && pool.percent !== null && pool.percent !== this.lastPool5h) {
        this.lastPool5h = pool.percent;
        deliveries.push(...await this.pushType(config, "pool5h", contextFor({ label: "Codex pool" }, snapshot, now)));
      }

      this.lastRunAt = now;
      this.lastDelivery = deliveries.slice(-20);
      return deliveries;
    })().finally(() => { this.running = null; });
    return this.running;
  }

  async pushType(config, type, context) {
    const template = config.types[type];
    const title = renderTemplate(template.title, context);
    const body = renderTemplate(template.body, context);
    const results = [];
    for (const device of config.devices.filter(item => item.enabled)) {
      results.push(await this.push(device.key, title, body, { level: config.level, group: config.group }));
    }
    const ok = results.filter(result => result.ok).length;
    if (results.length && ok !== results.length) this.emit({ source: "dashboard", level: "warn", msg: `Subscription push partly failed: dashboard/subscription delivery — ${ok} of ${results.length} devices accepted the ${type} notification.` });
    return results;
  }

  status() {
    return { lastRunAt: this.lastRunAt, lastDelivery: this.lastDelivery, monitorRunning: this.running !== null };
  }

  start() {
    const run = () => this.tick().catch(() => {});
    run();
    const timer = setInterval(run, REFRESH_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}
