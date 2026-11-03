// Agent dashboard server. Express + Casdoor OIDC + hot-pluggable panel registry
// + an SSE log stream that feeds the YouTube-style live window.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import session from "express-session";

import { config, hasDashboardToken } from "./config.js";
import { initOidc, oidcReady, loginUrl, handleCallback, isAuthorized, groupsOf } from "./oidc.js";
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

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", false);

app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", secure: false },
  }),
);

// --- Auth ---
app.get("/healthz", (_req, res) => res.json({ ok: true, uptime: uptimeSeconds() }));

app.get("/auth/login", (req, res) => res.redirect(loginUrl(req)));

app.get("/auth/callback", async (req, res, next) => {
  try {
    const { userinfo } = await handleCallback(req);
    if (!isAuthorized(userinfo)) {
      emit({ source: "dashboard", level: "warn", msg: `OIDC denied (groups=${groupsOf(userinfo).join(",")})` });
      return res.status(403).send("Access denied: missing required group.");
    }
    req.session.user = {
      sub: userinfo.sub,
      name: userinfo.name ?? userinfo.preferred_username ?? userinfo.sub,
      email: userinfo.email,
    };
    emit({ source: "dashboard", level: "info", msg: `sign-in: ${req.session.user.name}` });
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
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "unauthorized" });
  res.redirect("/auth/login");
}

function requireToken(req, res, next) {
  if (!hasDashboardToken) {
    return res.status(503).json({ error: "dashboard token not configured" });
  }
  const header = req.headers.authorization ?? "";
  if (header !== `Bearer ${config.dashboardToken}`) {
    return res.status(401).json({ error: "invalid token" });
  }
  next();
}

// --- Panel API ---
app.get("/api/panels", requireAuth, async (_req, res) => res.json({ panels: await snapshot() }));

app.get("/api/panels/:id/data", requireAuth, async (req, res) => {
  const panel = getPanel(req.params.id);
  if (!panel) return res.status(404).json({ error: "unknown panel" });
  if (!(await isEnabled(panel.id))) return res.status(404).json({ error: "panel disabled" });
  const data = typeof panel.data === "function" ? await panel.data() : {};
  res.json(data ?? {});
});

app.post("/api/panels/:id/toggle", requireAuth, requireToken, async (req, res) => {
  const panel = getPanel(req.params.id);
  if (!panel) return res.status(404).json({ error: "unknown panel" });
  const enabled = req.body?.enabled !== false;
  await setEnabled(panel.id, enabled);
  emit({ source: "dashboard", level: "info", msg: `panel ${panel.id} ${enabled ? "enabled" : "disabled"}` });
  res.json({ id: panel.id, enabled });
});

// --- Live stream ---
app.get("/api/uptime", requireAuth, (_req, res) => res.json({ uptimeSeconds: uptimeSeconds() }));

app.get("/api/stream", requireAuth, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  for (const e of getEvents().slice(-100)) send(e);
  const unsubscribe = subscribe(send);
  req.on("close", unsubscribe);
});

// --- Static frontend ---
app.use(express.static(PUBLIC_DIR));

app.listen(config.port, config.host, () => {
  emit({ source: "dashboard", level: "info", msg: `dashboard listening on http://${config.host}:${config.port}` });
  emit({ source: "dashboard", level: "info", msg: `oidc issuer ${config.oidc.issuer} group ${config.oidc.requiredGroup}` });
  emit({ source: "openclaw", level: "info", msg: `configured endpoint ${config.openclaw.endpoint}` });
  emit({ source: "astrbot", level: "info", msg: `configured endpoint ${config.astrbot.endpoint}` });
  emit({ source: "jenkins", level: "info", msg: `configured endpoint ${config.jenkins.endpoint}` });
});

// Seed a heartbeat so the progress bar always has movement even when quiet.
setInterval(() => {
  emit({ source: "dashboard", level: "info", msg: `heartbeat @ ${uptimeSeconds()}s` });
}, 30000);
