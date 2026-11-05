import express from "express";
import { emit } from "./log-bus.js";

export const CONFIG_ROUTE = "/api/admin/openclaw-config";

// Administrator-only OpenClaw config editor. Reads need an admin session;
// writes additionally need the same-origin dashboard request header. The
// panel's soft toggle gates both routes without a restart.
export function mountOpenClawConfig(app, store, { requireAuth, requireAdmin, requireCsrf, isEnabled }) {
  const route = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res, next)).catch(error => {
    if (error.status && error.message?.includes(": dashboard/openclaw config")) return res.status(error.status).json({ error: error.message });
    next(error);
  });
  const available = route(async (_req, res, next) => {
    if (!(await isEnabled("openclaw-config"))) return res.status(404).json({ error: "Panel unavailable: dashboard/panel lookup — panel is disabled." });
    if (!store) return res.status(503).json({ error: "Config unavailable: dashboard/openclaw config — OPENCLAW_CONFIG_FILE is not mounted in this deployment." });
    next();
  });
  const parse = express.json({ limit: "600kb" });

  app.get(CONFIG_ROUTE, requireAuth, requireAdmin, available, route((_req, res) => {
    res.set("Cache-Control", "no-store").json(store.view());
  }));

  app.put(CONFIG_ROUTE, requireAuth, requireAdmin, requireCsrf, available, parse, route((req, res) => {
    const result = store.save(req.body?.text, req.body?.baseHash);
    if (result.changed) emit({ source: "dashboard", level: "info", msg: `OpenClaw config updated: dashboard/openclaw config — saved by administrator ${req.session.user.sub}; previous file backed up.` });
    res.set("Cache-Control", "no-store").json(result);
  }));
}
