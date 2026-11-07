import { fetchQuota } from "./cpa.js";
import { normalizeQuota } from "./quota-normalize.js";

// Single-flight CPA quota refresh shared by the admin "Refresh quota" button
// and the live-stream background refresh. Concurrent callers share one
// upstream request; a new request starts at most once per 30 seconds. A failed
// refresh keeps the previous stored snapshot. Credential changes call
// invalidate(), which discards any in-flight result.
export function createQuotaRefresher({ store, secrets, fetcher, minIntervalMs = 30000, now = Date.now }) {
  let pending;
  let generation = 0;
  let lastAttempt = 0;
  return {
    refresh() {
      const settings = secrets.read();
      if (!settings) return Promise.reject(Object.assign(new Error("Quota unavailable: dashboard/CPA management — save the remote dashboard key first."), { status: 409 }));
      if (pending) return pending;
      if (now() - lastAttempt < minIntervalMs) return Promise.reject(Object.assign(new Error("Quota refresh delayed: dashboard/CPA management — wait 30 seconds between remote quota checks."), { status: 429 }));
      const version = generation;
      lastAttempt = now();
      pending = fetchQuota(settings, fetcher).then(snapshot => {
        if (version !== generation) throw Object.assign(new Error("Quota refresh discarded: dashboard/CPA management — settings changed during the request; refresh again."), { status: 409 });
        store.setSetting("cpa-quota", snapshot);
        return normalizeQuota(snapshot, now());
      }).finally(() => { if (version === generation) pending = undefined; });
      return pending;
    },
    invalidate() {
      generation++;
      pending = undefined;
      lastAttempt = 0;
      store.setSetting("cpa-quota", null);
    },
    // Every reader gets the normalized view (passed resets, unused weeks).
    snapshot: (at = now()) => normalizeQuota(store.getSetting("cpa-quota"), at),
  };
}
