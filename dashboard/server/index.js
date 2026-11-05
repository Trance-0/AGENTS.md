// Agent dashboard server. Express + Casdoor OIDC + hot-pluggable panel registry
// + an SSE log stream that feeds the YouTube-style live window.

import fs from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import session from "express-session";
import createMemoryStore from "memorystore";

import { config, hasDashboardToken } from "./config.js";
import { initOidc, loginUrl, handleCallback, isAuthorized, groupsOf } from "./oidc.js";
import { registerPanel, snapshot, groupsFor, isEnabled, setEnabled, getPanel } from "./registry.js";
import { emit, uptimeSeconds } from "./log-bus.js";
import { BroadcastStore } from "./broadcast.js";
import { mountOpenClaw } from "./openclaw-routes.js";
import { mountBroadcast } from "./broadcast-routes.js";
import { avatarUrl, serveAvatar } from "./avatar.js";
import { watchActivity } from "./openclaw-activity.js";
import { OpenClawConfigStore } from "./openclaw-config.js";
import { mountOpenClawConfig, CONFIG_ROUTE } from "./openclaw-config-routes.js";
import { noteRelayActivity } from "./relay-status.js";
import { MetricsStore } from "./metrics/store.js";
import { SecretStore } from "./metrics/secrets.js";
import { watchUsage } from "./metrics/reader.js";
import { mountMetrics } from "./metrics/routes.js";
import { SceneStore } from "./scene/store.js";
import { SceneService } from "./scene/service.js";
import { MetricsBridge } from "./scene/bridge.js";
import { mountScene, contentSecurityPolicy, embedSecurityPolicy, embedPaths } from "./scene/routes.js";
import { embedStatic } from "./scene/embed-static.js";
import { StreamControl } from "./stream-control.js";
import { UsageLine } from "./usage-line.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

// fetch with a timeout, so a dead provider can't hang a panel status poll.
async function fetchWithTimeout(url, { timeout = 5000, ...init } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function loadPanels() {
  const dir = path.join(__dirname, "panels");
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".js") && !f.startsWith("."));
  const ctx = { fetch: fetchWithTimeout, config };
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(dir, file)).href);
    const creator = Object.values(mod).find((v) => typeof v === "function");
    if (creator) {
      registerPanel(await creator(ctx));
    }
  }
}

await loadPanels();
await initOidc();

const broadcast = new BroadcastStore(path.join(config.dataDir, "recordings"));
const metricsDirectory = config.metricsDir || path.join(config.dataDir, "metrics");
const metrics = new MetricsStore(metricsDirectory);
const metricsSecrets = new SecretStore(metricsDirectory, config.metricsKeyFile);
if (config.openclaw.activityDir) watchUsage(config.openclaw.activityDir, metrics, msg => emit({ source: "dashboard", level: "warn", msg }));
if (config.openclaw.activityDir) {
  let activityRecordingId = broadcast.active?.id;
  const activityEvents = new Set(broadcast.active ? broadcast.readEvents(broadcast.active.id, Math.max(0, broadcast.active.eventCount - 2000), 2000).map(event => event.eventRef) : []);
  watchActivity({
    directory: config.openclaw.activityDir,
    cursorFile: path.join(config.dataDir, "openclaw-activity-cursor.json"),
    publish: event => {
      noteRelayActivity(event);
      if (!broadcast.active || event.activityTimestamp < broadcast.active.startedAt) return;
      if (activityRecordingId !== broadcast.active.id) { activityRecordingId = broadcast.active.id; activityEvents.clear(); }
      if (activityEvents.has(event.eventRef)) return;
      broadcast.publish(event);
      activityEvents.add(event.eventRef);
      if (activityEvents.size > 2000) activityEvents.delete(activityEvents.values().next().value);
    },
    warn: msg => emit({ source: "openclaw", level: "warn", msg }),
  });
}
const sceneStore = new SceneStore(path.join(config.dataDir, "scene"), { embeds: embedPaths(config) });
const scene = new SceneService({ broadcast, store: sceneStore, emit });
const MemoryStore = createMemoryStore(session);
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", "loopback");
// Strict CSP on every response; image widgets add only allowlisted HTTPS origins.
app.use((_req, res, next) => { res.set("Content-Security-Policy", contentSecurityPolicy(sceneStore.settings().imageAllowlist)); next(); });
// Small JSON bodies everywhere except the config editor, which parses its own (larger) body.
const smallJson = express.json({ limit: "16kb" });
app.use((req, res, next) => (req.path === CONFIG_ROUTE ? next() : smallJson(req, res, next)));

app.use(
  session({
    store: new MemoryStore({ checkPeriod: 60000, max: 1000 }),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 12 * 60 * 60 * 1000, httpOnly: true, sameSite: "lax", secure: config.oidc.redirectUri.startsWith("https://") },
  }),
);

// --- Auth ---
app.get("/healthz", (_req, res) => res.json({ ok: true, uptime: uptimeSeconds() }));

app.get("/auth/login", (req, res) => res.redirect(loginUrl(req)));

app.get("/auth/callback", async (req, res, next) => {
  try {
    const { userinfo } = await handleCallback(req);
    if (!isAuthorized(userinfo)) {
      emit({ source: "dashboard", level: "warn", msg: "Unable to sign in: dashboard/group authorization — account lacks the required group" });
      return res.status(403).send("Unable to sign in: dashboard/group authorization — account lacks the required group.");
    }
    await new Promise((resolve, reject) => req.session.regenerate((err) => err ? reject(err) : resolve()));
    req.session.user = {
      sub: userinfo.sub,
      isAdmin: groupsOf(userinfo).includes(config.oidc.adminGroup),
      name: userinfo.name ?? userinfo.preferred_username ?? userinfo.sub,
      avatarUrl: avatarUrl(userinfo),
    };
    emit({ source: "dashboard", level: "info", msg: "Dashboard access granted: dashboard/sign-in — OIDC identity and required group verified" });
    await new Promise((resolve, reject) => req.session.save((err) => err ? reject(err) : resolve()));
    res.redirect("/");
  } catch (err) {
    next(err);
  }
});

app.get("/auth/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

app.get("/auth/user", (req, res) => {
  const user = req.session?.user;
  res.set("Cache-Control", "no-store").json(user ? { sub: user.sub, name: user.name, isAdmin: user.isAdmin, avatar: user.avatarUrl ? "/auth/avatar" : null } : null);
});

function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  if (req.path.startsWith("/api/") || req.path === "/auth/avatar") return res.status(401).json({ error: "Dashboard data unavailable: dashboard/session authorization — sign-in session is missing or expired." });
  res.redirect("/auth/login");
}

function requireAdmin(req, res, next) {
  if (!req.session.user.isAdmin) {
    return res.status(403).json({ error: "Panel cannot be changed: dashboard/admin authorization — account lacks the required administrator group." });
  }
  next();
}

function requireCsrf(req, res, next) {
  if (req.get("X-Dashboard-Request") !== "1" || (req.get("Origin") && req.get("Origin") !== new URL(config.oidc.redirectUri).origin)) {
    return res.status(403).json({ error: "Request cannot be accepted: dashboard/request origin — use the dashboard page on its configured origin." });
  }
  next();
}

app.get("/auth/avatar", requireAuth, serveAvatar);
// The metrics routes own the shared CPA quota refresher the usage line reuses.
const quota = mountMetrics(app, { store: metrics, secrets: metricsSecrets, requireAuth, requireAdmin, requireCsrf, isEnabled });
const control = new StreamControl({ broadcast, emit });
const usageLine = new UsageLine({ broadcast, metrics, quota, secrets: metricsSecrets, isEnabled, emit });
mountBroadcast(app, broadcast, { requireAuth, requireAdmin, requireCsrf, control, usageLine, emit });
mountOpenClaw(app, broadcast, { control, usageLine });
const configStore = config.openclaw.configFile
  ? new OpenClawConfigStore({ file: config.openclaw.configFile, backupDir: path.join(config.dataDir, "openclaw-config-backups") })
  : null;
mountOpenClawConfig(app, configStore, { requireAuth, requireAdmin, requireCsrf, isEnabled });
mountScene(app, { scene, store: sceneStore, streamToken: config.openclaw.streamToken, requireCsrfOrToken, control });
new MetricsBridge({ scene, broadcast, metrics, quota, secrets: metricsSecrets, isEnabled, emit }).start();

function requireToken(req, res, next) {
  if (!hasDashboardToken) {
    return res.status(503).json({ error: "Panel cannot be changed: dashboard/mutation authorization — dashboard token is not configured." });
  }
  const actual = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${config.dashboardToken}`);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return res.status(401).json({ error: "Panel cannot be changed: dashboard/mutation authorization — bearer token is missing or incorrect." });
  }
  next();
}

// --- Panel API ---
app.get("/api/panels", requireAuth, async (req, res) => {
  const panels = await snapshot({ isAdmin: req.session.user.isAdmin });
  res.json({ panels, groups: groupsFor(panels) });
});

app.get("/api/panels/:id/data", requireAuth, async (req, res) => {
  const panel = getPanel(req.params.id);
  if (!panel) return res.status(404).json({ error: "Panel unavailable: dashboard/panel lookup — panel ID is not registered." });
  if (panel.adminOnly && !req.session.user.isAdmin) return res.status(403).json({ error: "Panel unavailable: dashboard/panel authorization — administrator group is required." });
  if (!(await isEnabled(panel.id))) return res.status(404).json({ error: "Panel unavailable: dashboard/panel lookup — panel is disabled." });
  const data = typeof panel.data === "function" ? await panel.data() : {};
  res.json(data ?? {});
});

// Browser admins use their session plus the same-origin header, like every
// other admin mutation. Non-browser automation may instead send the
// DASHBOARD_TOKEN bearer (still with an admin session); a present but wrong
// bearer is rejected rather than falling back to the header check.
function requireCsrfOrToken(req, res, next) {
  return req.headers.authorization ? requireToken(req, res, next) : requireCsrf(req, res, next);
}

app.post("/api/panels/:id/toggle", requireAuth, requireAdmin, requireCsrfOrToken, async (req, res) => {
  const panel = getPanel(req.params.id);
  if (!panel) return res.status(404).json({ error: "Panel unavailable: dashboard/panel lookup — panel ID is not registered." });
  if (panel.id === "live-stream") return res.status(400).json({ error: "Panel cannot be changed: dashboard/panel toggle — the live stream panel is always on." });
  const enabled = req.body?.enabled !== false;
  await setEnabled(panel.id, enabled);
  emit({ source: "dashboard", level: "info", msg: `Panel state updated: dashboard/panel toggle — ${panel.id} is ${enabled ? "enabled" : "disabled"}` });
  res.json({ id: panel.id, enabled });
});

// --- Live stream ---
app.get("/api/uptime", requireAuth, (_req, res) => res.json({ uptimeSeconds: uptimeSeconds() }));

app.use((err, _req, res, _next) => {
  const cause = err.error || err.code || err.type || (err.message?.includes(": dashboard/") ? err.message.split(" — ").at(-1) : "request validation or upstream operation failed");
  const message = `Request could not complete: dashboard/request handling — ${cause}. Retry sign-in or check the request.`;
  emit({ source: "dashboard", level: "warn", msg: message });
  res.status(err.status || 400).json({ error: message });
});

// --- Scene embeds (read-only static builds; off unless configured) ---
const embedHeaders = (_req, res, next) => { res.set({ "Content-Security-Policy": embedSecurityPolicy(), "X-Content-Type-Options": "nosniff" }); next(); };
if (embedPaths(config).includes("/embed/circtime/")) app.use("/embed/circtime", embedHeaders, embedStatic(config.circtimeEmbedDir));
app.use("/embed", (_req, res) => res.status(404).type("text/plain").send("Embed unavailable: dashboard/scene embeds — this page is not served by this deployment."));

// --- Static frontend ---
// Scene assets carry content hashes in their names, so they never change in place.
app.use("/scene/assets", express.static(path.join(PUBLIC_DIR, "scene", "assets"), { immutable: true, maxAge: "365d", fallthrough: false }));
app.use(express.static(PUBLIC_DIR));

app.listen(config.port, config.host, () => {
  emit({ source: "dashboard", level: "info", msg: `Dashboard is ready: dashboard/startup — listening on http://${config.host}:${config.port}` });
  emit({ source: "dashboard", level: "info", msg: `Sign-in is configured: dashboard/startup — issuer ${config.oidc.issuer}, required group ${config.oidc.requiredGroup}` });
  emit({ source: "openclaw", level: "info", msg: `Service monitoring is configured: dashboard/startup — endpoint ${config.openclaw.endpoint}` });
  emit({ source: "astrbot", level: "info", msg: `Service monitoring is configured: dashboard/startup — endpoint ${config.astrbot.endpoint}` });
  emit({ source: "jenkins", level: "info", msg: `Service monitoring is configured: dashboard/startup — endpoint ${config.jenkins.endpoint}` });
});

// Quiet heartbeat (every 5 minutes) so an idle stream still shows it is alive.
setInterval(() => {
  emit({ source: "dashboard", level: "info", msg: `Dashboard is running: dashboard/heartbeat — uptime ${uptimeSeconds()}s` });
  broadcast.publish({ source: "stream", msg: "Stream is running: dashboard/broadcast heartbeat — waiting for the next viewer message." });
}, 5 * 60 * 1000);
