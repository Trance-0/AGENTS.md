// Subscription panel routes. The browser edits the encrypted subscription
// document (Bark devices, per-alarm templates, reset field mapping) and can
// fire one test push; the monitor runs independently every five minutes.
import { detectResetFields } from "./metrics/reset-fields.js";
import { view } from "./metrics/subscriptions.js";
import { pushBark } from "./metrics/bark.js";

export function mountSubscriptions(app, { subscriptions, quota, monitor, requireAuth, requireAdmin, requireCsrf, isEnabled }) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);
  const access = [requireAuth, requireAdmin, requireCsrf, route(async (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!(await isEnabled("subscription"))) return res.status(404).json({ error: "Subscriptions unavailable: dashboard/plugin access — panel is disabled." });
    next();
  })];

  const snapshotResetFields = () => detectResetFields(quota.snapshot()?.accounts);

  app.get("/api/admin/subscription", ...access, route(async (req, res) => {
    res.json({ ...view(subscriptions.read(), snapshotResetFields()), status: monitor.status() });
  }));

  app.put("/api/admin/subscription", ...access, route(async (req, res) => {
    const saved = subscriptions.save(req.body);
    res.json({ ...view(saved, snapshotResetFields()), status: monitor.status() });
  }));

  app.post("/api/admin/subscription/test", ...access, route(async (req, res) => {
    const config = subscriptions.read();
    const devices = config.devices.filter(device => device.enabled);
    if (!devices.length) return res.status(409).json({ error: "Test push not sent: dashboard/subscription delivery — add and enable at least one Bark device first." });
    const results = await Promise.all(devices.map(device => pushBark(device.key, "Agent dashboard test", "Subscriptions are working. This is a test push.", { level: config.level, group: config.group })));
    res.json({ sent: results.map(result => ({ key: result.key, ok: result.ok, status: result.status })) });
  }));
}
