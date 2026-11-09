import fs from "node:fs";
import path from "node:path";
import { StreamControl, streamBearer } from "../stream-control.js";

// One scene API, two callers, one validator (public/scene/schema.js):
//
// Admin (session in the admin group; mutations also need the same-origin
//   X-Dashboard-Request header or the DASHBOARD_TOKEN bearer):
//   GET/PUT /api/scene/layout, POST /api/scene/widgets,
//   PATCH/DELETE /api/scene/widgets/:id, GET/PUT /api/scene/settings
// OpenClaw (stream-controller bearer, OPENCLAW_STREAM_TOKEN; who may act on
//   which live recording is decided by server/stream-control.js):
//   GET /api/openclaw/scene/layout, POST /api/openclaw/scene/widgets,
//   PATCH/DELETE /api/openclaw/scene/widgets/:id (changes may set `hidden`),
//   POST /api/openclaw/scene/avatar
export function mountScene(app, { avatars, scene, store, streamToken, requireCsrfOrToken, control = new StreamControl({ broadcast: scene.broadcast }) }) {
  // Scene errors already carry the full "<consequence>: <module> — <cause>" text.
  const route = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(error => {
    if (error.status && /: dashboard\/(?:scene |stream control )/.test(error.message)) return res.status(error.status).json({ error: error.message });
    next(error);
  });
  const noStore = (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); };
  const admin = (req, res, next) => {
    if (!req.session?.user) return res.status(401).json({ error: "Scene unavailable: dashboard/scene authorization — sign-in session is missing or expired." });
    if (!req.session.user.isAdmin) return res.status(403).json({ error: "Scene cannot be edited: dashboard/scene authorization — account lacks the required administrator group." });
    next();
  };
  const openclaw = streamBearer(streamToken, "Scene control unavailable");
  const body = req => (req.body && typeof req.body === "object" ? req.body : {});

  const view = () => {
    const live = scene.liveState();
    return { layout: store.layout(), live: live ? { recordingId: live.recordingId, widgets: Object.values(live.state.widgets) } : null, settings: store.settings() };
  };

  app.get("/api/scene/layout", noStore, admin, route((_req, res) => res.json(view())));
  // Replaces the saved default layout only; the live scene changes through
  // widget operations, so a bulk save never rewrites a public recording.
  app.put("/api/scene/layout", noStore, admin, requireCsrfOrToken, route((req, res) => {
    const { widgets, baseVersion } = body(req);
    if (baseVersion !== undefined && !Number.isSafeInteger(baseVersion)) return res.status(400).json({ error: "Scene layout not saved: dashboard/scene layout — baseVersion must be the version you edited." });
    scene.take("admin");
    store.saveLayout(widgets, baseVersion);
    res.json(view());
  }));
  // ?scope=live: record in the live scene only (Canvas settings "Apply to live
  // stream"); without it, the on-stage editor's both-copies behaviour.
  const scope = req => (req.query.scope === undefined ? undefined : String(req.query.scope));
  app.post("/api/scene/widgets", noStore, admin, requireCsrfOrToken, route((req, res) => res.status(201).json(scene.create("admin", body(req).widget, { scope: scope(req) }))));
  app.patch("/api/scene/widgets/:id", noStore, admin, requireCsrfOrToken, route((req, res) => res.json(scene.update("admin", req.params.id, body(req).changes, { scope: scope(req) }))));
  app.delete("/api/scene/widgets/:id", noStore, admin, requireCsrfOrToken, route((req, res) => res.json(scene.remove("admin", req.params.id, { scope: scope(req) }))));
  app.get("/api/scene/settings", noStore, admin, route((_req, res) => res.json(store.settings())));
  app.put("/api/scene/settings", noStore, admin, requireCsrfOrToken, route((req, res) => res.json(store.saveSettings(body(req)))));

  // Rejections: 400 malformed IDs, 403 no right (public host turn), 409 not
  // the caller's live recording, 429 rate limit.
  const allowed = (source, action, consequence) => control.authorize(source, action, consequence);
  const audit = (action, who, detail) => control.audit(action, who, detail);
  app.get("/api/openclaw/scene/layout", noStore, openclaw, route((req, res) => {
    allowed(req.query, "scene", "Scene not read");
    const live = scene.liveState();
    res.json({ recordingId: live.recordingId, widgets: Object.values(live.state.widgets), avatars: avatars?.catalog() || [] });
  }));
  app.post("/api/openclaw/scene/widgets", noStore, openclaw, route((req, res) => {
    const who = allowed(body(req), "scene", "Widget not created");
    const result = scene.create("openclaw", body(req).widget);
    audit("widget create", who, `widget ${result.widget.id}`);
    res.status(201).json(result);
  }));
  app.patch("/api/openclaw/scene/widgets/:id", noStore, openclaw, route((req, res) => {
    const who = allowed(body(req), "scene", "Widget not changed");
    const result = scene.update("openclaw", req.params.id, body(req).changes);
    audit("widget update", who, `widget ${result.widget.id}`);
    res.json(result);
  }));
  app.delete("/api/openclaw/scene/widgets/:id", noStore, openclaw, route((req, res) => {
    const who = allowed(body(req), "scene", "Widget not removed");
    const result = scene.remove("openclaw", req.params.id);
    audit("widget delete", who, `widget ${result.id}`);
    res.json(result);
  }));
  app.post("/api/openclaw/scene/avatar", noStore, openclaw, route((req, res) => {
    const { expression, seconds } = body(req);
    const who = allowed(body(req), "avatar", "Avatar not changed");
    const names = new Set(["auto", "idle", "blink", "talk", "think", "sleepy", ...(avatars?.catalog() || []).flatMap(pack => Object.keys(pack.states))]);
    if (!names.has(expression)) return res.status(400).json({ error: "Avatar not changed: dashboard/avatar state — requested state is not installed." });
    const result = scene.avatar("openclaw", { expression, ...(seconds === undefined ? {} : { seconds }) }, [...names]);
    audit("avatar", who, result.avatar.expression);
    res.json(result);
  }));
}

// Strict Content-Security-Policy. Image widgets may load only from the
// administrator's allowlisted HTTPS origins; frames only from the dashboard
// itself (the embed widget's dashboard-served pages); nothing else leaves 'self'.
export function contentSecurityPolicy(allowlist = []) {
  const origins = [...new Set(allowlist.map(prefix => new URL(prefix).origin))];
  return [
    "default-src 'self'", "script-src 'self'", "style-src 'self'",
    `img-src 'self' data:${origins.length ? " " + origins.join(" ") : ""}`,
    "media-src 'self'", "connect-src 'self'", "font-src 'self'",
    "frame-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join("; ");
}

// Policy for pages served under /embed/: framable only by the dashboard and
// unable to load anything from outside it. The page runs in a sandboxed
// iframe (allow-scripts, no allow-same-origin), so it gets an opaque origin
// and cannot read dashboard cookies, storage, or APIs.
export function embedSecurityPolicy() {
  return [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
    "connect-src 'self'", "font-src 'self'", "media-src 'none'", "object-src 'none'",
    "frame-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'",
  ].join("; ");
}

// Dashboard-served embed paths the scene validator accepts, from server config.
// A configured directory without index.html (for example an empty mount
// point created by Compose) leaves the embed off.
export function embedPaths({ circtimeEmbedDir }) {
  return circtimeEmbedDir && fs.existsSync(path.join(circtimeEmbedDir, "index.html")) ? ["/embed/circtime/"] : [];
}
