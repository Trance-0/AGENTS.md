// Agent dashboard server. Express + Casdoor OIDC + hot-pluggable panel registry
// + an SSE log stream that feeds the YouTube-style live window.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import session from "express-session";
import createMemoryStore from "memorystore";

import { config, hasDashboardToken } from "./config.js";
import { initOidc, loginUrl, handleCallback, isAuthorized, groupsOf } from "./oidc.js";
import { registerPanel, snapshot, isEnabled, setEnabled, getPanel } from "./registry.js";
import { emit, getEvents, subscribe, uptimeSeconds } from "./log-bus.js";

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
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".js"));
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

const MemoryStore = createMemoryStore(session);
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", "loopback");
app.use(express.json());

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
      email: userinfo.email,
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
  res.json(req.session?.user ?? null);
});

function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Dashboard data unavailable: dashboard/session authorization — sign-in session is missing or expired." });
  res.redirect("/auth/login");
}

function requireToken(req, res, next) {
  if (!req.session.user.isAdmin) {
    return res.status(403).json({ error: "Panel cannot be changed: dashboard/admin authorization — account lacks the required administrator group." });
  }
  if (!hasDashboardToken) {
    return res.status(503).json({ error: "Panel cannot be changed: dashboard/mutation authorization — dashboard token is not configured." });
  }
  const header = req.headers.authorization ?? "";
  if (header !== `Bearer ${config.dashboardToken}`) {
    return res.status(401).json({ error: "Panel cannot be changed: dashboard/mutation authorization — bearer token is missing or incorrect." });
  }
  next();
}

// --- Panel API ---
app.get("/api/panels", requireAuth, async (_req, res) => res.json({ panels: await snapshot() }));

app.get("/api/panels/:id/data", requireAuth, async (req, res) => {
  const panel = getPanel(req.params.id);
  if (!panel) return res.status(404).json({ error: "Panel unavailable: dashboard/panel lookup — panel ID is not registered." });
  if (!(await isEnabled(panel.id))) return res.status(404).json({ error: "Panel unavailable: dashboard/panel lookup — panel is disabled." });
  const data = typeof panel.data === "function" ? await panel.data() : {};
  res.json(data ?? {});
});

app.post("/api/panels/:id/toggle", requireAuth, requireToken, async (req, res) => {
  const panel = getPanel(req.params.id);
  if (!panel) return res.status(404).json({ error: "Panel unavailable: dashboard/panel lookup — panel ID is not registered." });
  const enabled = req.body?.enabled !== false;
  await setEnabled(panel.id, enabled);
  emit({ source: "dashboard", level: "info", msg: `Panel state updated: dashboard/panel toggle — ${panel.id} is ${enabled ? "enabled" : "disabled"}` });
  res.json({ id: panel.id, enabled });
});

// --- Live stream ---
app.get("/api/uptime", requireAuth, (_req, res) => res.json({ uptimeSeconds: uptimeSeconds() }));

app.get("/api/stream", requireAuth, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  for (const e of getEvents().slice(-100)) send(e);
  const unsubscribe = subscribe(send);
  req.on("close", unsubscribe);
});

app.use((err, _req, res, _next) => {
  const cause = err.error || err.code || err.type || err.message.split(",")[0];
  const message = `Request could not complete: dashboard/request handling — ${cause}. Retry sign-in or check the request.`;
  emit({ source: "dashboard", level: "warn", msg: message });
  res.status(400).json({ error: message });
});

// --- Static frontend ---
app.use(express.static(PUBLIC_DIR));

app.listen(config.port, config.host, () => {
  emit({ source: "dashboard", level: "info", msg: `Dashboard is ready: dashboard/startup — listening on http://${config.host}:${config.port}` });
  emit({ source: "dashboard", level: "info", msg: `Sign-in is configured: dashboard/startup — issuer ${config.oidc.issuer}, required group ${config.oidc.requiredGroup}` });
  emit({ source: "openclaw", level: "info", msg: `Service monitoring is configured: dashboard/startup — endpoint ${config.openclaw.endpoint}` });
  emit({ source: "astrbot", level: "info", msg: `Service monitoring is configured: dashboard/startup — endpoint ${config.astrbot.endpoint}` });
  emit({ source: "jenkins", level: "info", msg: `Service monitoring is configured: dashboard/startup — endpoint ${config.jenkins.endpoint}` });
});

// Seed a heartbeat so the progress bar always has movement even when quiet.
setInterval(() => {
  emit({ source: "dashboard", level: "info", msg: `Dashboard is running: dashboard/heartbeat — uptime ${uptimeSeconds()}s` });
}, 30000);
