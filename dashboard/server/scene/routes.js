import { timingSafeEqual } from "node:crypto";

// One scene API, two callers, one validator (public/scene/schema.js):
//
// Admin (session in the admin group; mutations also need the same-origin
//   X-Dashboard-Request header or the DASHBOARD_TOKEN bearer):
//   GET/PUT /api/scene/layout, POST /api/scene/widgets,
//   PATCH/DELETE /api/scene/widgets/:id, GET/PUT /api/scene/settings
// OpenClaw (stream-controller bearer, OPENCLAW_STREAM_TOKEN; only the live
//   recording its own session owns):
//   GET /api/openclaw/scene/layout, POST /api/openclaw/scene/widgets,
//   PATCH/DELETE /api/openclaw/scene/widgets/:id
export function mountScene(app, { scene, store, streamToken, requireCsrfOrToken }) {
  // Scene errors already carry the full "<consequence>: <module> — <cause>" text.
  const route = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(error => {
    if (error.status && /: dashboard\/scene /.test(error.message)) return res.status(error.status).json({ error: error.message });
    next(error);
  });
  const noStore = (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); };
  const admin = (req, res, next) => {
    if (!req.session?.user) return res.status(401).json({ error: "Scene unavailable: dashboard/scene authorization — sign-in session is missing or expired." });
    if (!req.session.user.isAdmin) return res.status(403).json({ error: "Scene cannot be edited: dashboard/scene authorization — account lacks the required administrator group." });
    next();
  };
  const openclaw = (req, res, next) => {
    const expected = Buffer.from(`Bearer ${streamToken}`);
    const actual = Buffer.from(req.get("authorization") || "");
    if (!streamToken || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return res.status(401).json({ error: "Scene control unavailable: dashboard/scene openclaw authentication — stream-controller bearer token is missing or incorrect." });
    }
    next();
  };
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
  app.post("/api/scene/widgets", noStore, admin, requireCsrfOrToken, route((req, res) => res.status(201).json(scene.create("admin", body(req).widget))));
  app.patch("/api/scene/widgets/:id", noStore, admin, requireCsrfOrToken, route((req, res) => res.json(scene.update("admin", req.params.id, body(req).changes))));
  app.delete("/api/scene/widgets/:id", noStore, admin, requireCsrfOrToken, route((req, res) => res.json(scene.remove("admin", req.params.id))));
  app.get("/api/scene/settings", noStore, admin, route((_req, res) => res.json(store.settings())));
  app.put("/api/scene/settings", noStore, admin, requireCsrfOrToken, route((req, res) => res.json(store.saveSettings(body(req)))));

  const owned = (req, source) => scene.requireOwner(source.recordingId, source.sessionRef);
  app.get("/api/openclaw/scene/layout", noStore, openclaw, route((req, res) => {
    const live = owned(req, req.query);
    res.json({ recordingId: live.recordingId, widgets: Object.values(live.state.widgets) });
  }));
  app.post("/api/openclaw/scene/widgets", noStore, openclaw, route((req, res) => {
    owned(req, body(req));
    res.status(201).json(scene.create("openclaw", body(req).widget));
  }));
  app.patch("/api/openclaw/scene/widgets/:id", noStore, openclaw, route((req, res) => {
    owned(req, body(req));
    res.json(scene.update("openclaw", req.params.id, body(req).changes));
  }));
  app.delete("/api/openclaw/scene/widgets/:id", noStore, openclaw, route((req, res) => {
    owned(req, body(req));
    res.json(scene.remove("openclaw", req.params.id));
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
export function embedPaths({ circtimeEmbedDir }) {
  return circtimeEmbedDir ? ["/embed/circtime/"] : [];
}
