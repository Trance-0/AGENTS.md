import { validateEndpoint } from "./cpa.js";
import { createQuotaRefresher } from "./quota-refresh.js";
import { poolCodex, tokenTotals } from "./pool.js";

// Returns the shared quota refresher so the live-stream metric bridge reuses
// the same single-flight refresh as the admin button.
export function mountMetrics(app, { store, secrets, fetcher, ...guards }) {
  const { requireAuth, requireAdmin, requireCsrf, isEnabled } = guards;
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);
  const access = id => [requireAuth, requireAdmin, route(async (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!(await isEnabled(id))) return res.status(404).json({ error: "Metrics unavailable: dashboard/plugin access — panel is disabled." });
    next();
  })];
  const quota = createQuotaRefresher({ store, secrets, fetcher });
  app.get("/api/admin/metrics/usage", ...access("usage-metrics"), route((req, res) => res.json(store.report(req.query))));
  app.get("/api/admin/metrics/summary", ...access("usage-summary"), route(async (_req, res) => {
    const now = Date.now();
    const cpaEnabled = await isEnabled("cpa-quota");
    res.json({
      now,
      tokens: tokenTotals(store, now),
      codex: cpaEnabled ? poolCodex(quota.snapshot(), now) : null,
      cpa: { enabled: cpaEnabled, configured: !!secrets.read?.() },
      note: "Codex windows pool every Codex account with equal weight; accounts without a known window are excluded. Token totals use UTC days and include cache tokens.",
    });
  }));
  app.put("/api/admin/metrics/pricing", ...access("usage-metrics"), requireCsrf, route((req, res) => {
    store.savePrice(req.body);
    res.json({ prices: store.prices() });
  }));
  app.get("/api/admin/metrics/cpa", ...access("cpa-quota"), route((_req, res) => res.json({ ...secrets.view(), snapshot: quota.snapshot() })));
  app.put("/api/admin/metrics/cpa", ...access("cpa-quota"), requireCsrf, route((req, res) => {
    const endpoint = validateEndpoint(req.body?.endpoint);
    const current = secrets.read();
    const key = req.body?.key || (current?.endpoint === endpoint ? current.key : "");
    if (typeof key !== "string" || !key.trim() || key.length > 8192 || /[\r\n]/.test(key)) return res.status(400).json({ error: "CPA settings not saved: dashboard/metrics credential — enter the remote dashboard management key." });
    secrets.save({ endpoint, key: key.trim() });
    quota.invalidate();
    res.json(secrets.view());
  }));
  app.delete("/api/admin/metrics/cpa", ...access("cpa-quota"), requireCsrf, route((_req, res) => {
    secrets.remove(); quota.invalidate();
    res.json(secrets.view());
  }));
  app.post("/api/admin/metrics/cpa/refresh", ...access("cpa-quota"), requireCsrf, route(async (_req, res) => {
    res.json({ snapshot: await quota.refresh() });
  }));
  return quota;
}
