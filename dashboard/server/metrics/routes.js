import { validateEndpoint, fetchQuota } from "./cpa.js";

export function mountMetrics(app, { store, secrets, fetcher, ...guards }) {
  const { requireAuth, requireAdmin, requireCsrf, isEnabled } = guards;
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);
  const access = id => [requireAuth, requireAdmin, route(async (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!(await isEnabled(id))) return res.status(404).json({ error: "Metrics unavailable: dashboard/plugin access — panel is disabled." });
    next();
  })];
  let pending;
  let generation = 0;
  let lastAttempt = 0;
  app.get("/api/admin/metrics/usage", ...access("usage-metrics"), route((req, res) => res.json(store.report(req.query))));
  app.put("/api/admin/metrics/pricing", ...access("usage-metrics"), requireCsrf, route((req, res) => {
    store.savePrice(req.body);
    res.json({ prices: store.prices() });
  }));
  app.get("/api/admin/metrics/cpa", ...access("cpa-quota"), route((_req, res) => res.json({ ...secrets.view(), snapshot: store.getSetting("cpa-quota") })));
  app.put("/api/admin/metrics/cpa", ...access("cpa-quota"), requireCsrf, route((req, res) => {
    const endpoint = validateEndpoint(req.body?.endpoint);
    const current = secrets.read();
    const key = req.body?.key || (current?.endpoint === endpoint ? current.key : "");
    if (typeof key !== "string" || !key.trim() || key.length > 8192 || /[\r\n]/.test(key)) return res.status(400).json({ error: "CPA settings not saved: dashboard/metrics credential — enter the remote dashboard management key." });
    secrets.save({ endpoint, key: key.trim() });
    generation++; lastAttempt = 0; pending = undefined;
    store.setSetting("cpa-quota", null);
    res.json(secrets.view());
  }));
  app.delete("/api/admin/metrics/cpa", ...access("cpa-quota"), requireCsrf, route((_req, res) => {
    secrets.remove(); generation++; pending = undefined; lastAttempt = 0; store.setSetting("cpa-quota", null);
    res.json(secrets.view());
  }));
  app.post("/api/admin/metrics/cpa/refresh", ...access("cpa-quota"), requireCsrf, route(async (_req, res) => {
    const settings = secrets.read();
    if (!settings) return res.status(409).json({ error: "Quota unavailable: dashboard/CPA management — save the remote dashboard key first." });
    if (!pending) {
      if (Date.now() - lastAttempt < 30000) return res.status(429).json({ error: "Quota refresh delayed: dashboard/CPA management — wait 30 seconds between remote quota checks." });
      const version = generation;
      lastAttempt = Date.now();
      pending = fetchQuota(settings, fetcher).then(snapshot => {
        if (version !== generation) throw Object.assign(new Error("Quota refresh discarded: dashboard/CPA management — settings changed during the request; refresh again."), { status: 409 });
        store.setSetting("cpa-quota", snapshot);
        return snapshot;
      }).finally(() => { if (version === generation) pending = undefined; });
    }
    res.json({ snapshot: await pending });
  }));
}
