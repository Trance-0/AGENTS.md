import assert from "node:assert/strict";
import { generateKeyPairSync, sign, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { writeUsage } from "../openclaw-plugin/usage-log.js";

test("OIDC sessions, group authorization, mutation tokens, and HTTPS cookies", { timeout: process.env.DASHBOARD_BROWSER_CHECK === "1" ? 300000 : 60000 }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-auth-"));
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test", use: "sig", alg: "RS256" };
  const codes = new Map();
  let issuer;
  const provider = http.createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    res.setHeader("content-type", "application/json");
    res.setHeader("connection", "close");
    if (url.pathname === "/.well-known/openid-configuration") {
      return res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, userinfo_endpoint: `${issuer}/userinfo`, jwks_uri: `${issuer}/jwks`, response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"] }));
    }
    if (url.pathname === "/jwks") return res.end(JSON.stringify({ keys: [jwk] }));
    if (url.pathname === "/token") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const code = new URLSearchParams(body).get("code");
      const identity = codes.get(code);
      if (!identity) { res.statusCode = 400; return res.end(JSON.stringify({ error: "invalid_grant" })); }
      const now = Math.floor(Date.now() / 1000);
      const payload = { iss: issuer, sub: "test-user", aud: "test-dashboard", iat: now, exp: now + 60, nonce: identity.nonce };
      const encoded = [ { alg: "RS256", kid: "test" }, payload ].map(v => Buffer.from(JSON.stringify(v)).toString("base64url")).join(".");
      const jwt = `${encoded}.${sign("RSA-SHA256", Buffer.from(encoded), privateKey).toString("base64url")}`;
      return res.end(JSON.stringify({ access_token: code, token_type: "Bearer", id_token: jwt }));
    }
    if (url.pathname === "/avatar.png") { res.setHeader("content-type", "image/png"); return res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64")); }
    if (url.pathname === "/v1/chat/completions") {
      let body = ""; for await (const chunk of req) body += chunk;
      assert.equal(req.headers.authorization, "Bearer test-gateway-token");
      assert.equal(JSON.parse(body).model, "openclaw:dashboard-host");
      assert.match(req.headers["x-openclaw-session-key"], /^agent:dashboard-host:openai-user:dashboard-(?:admin-)?[a-f0-9-]{36}$/);
      return res.end(JSON.stringify({ choices: [{ message: { content: "Welcome to the stream!" } }] }));
    }
    if (url.pathname === "/userinfo") {
      const identity = codes.get(req.headers.authorization?.replace("Bearer ", ""));
      return res.end(JSON.stringify({ sub: "test-user", name: "Test user", picture: `${issuer}/avatar.png`, groups: identity?.groups || [] }));
    }
    res.end("{}");
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  issuer = `http://127.0.0.1:${provider.address().port}`;
  const reservation = http.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  let child;
  let output = "";
  try {
    await cp(path.join(root, "server"), path.join(dir, "server"), { recursive: true });
    await cp(path.join(root, "public"), path.join(dir, "public"), { recursive: true });
    await cp(path.join(root, "package.json"), path.join(dir, "package.json"));
    await symlink(path.join(root, "node_modules"), path.join(dir, "node_modules"));
    const configFile = path.join(dir, "openclaw-config", "openclaw.json");
    await mkdir(path.dirname(configFile));
    await writeFile(configFile, JSON.stringify({ gateway: { bind: "loopback" }, agents: { defaults: { model: { primary: "cpa/claude-opus-5-5-high", fallbacks: ["cpa/gpt-6-astra", "openai/gpt-6-astra"] } }, list: [{ id: "main" }, { id: "dashboard-host", name: "Dashboard Host", model: "cpa/gpt-6-astra", workspace: "/private/workspace" }] }, channels: { telegram: { botToken: "literal-telegram-secret", groupPolicy: "allowlist" } } }, null, 2) + "\n");
    // The circtime embed: the real build when DASHBOARD_CIRCTIME_DIR names one
    // (host browser gate), otherwise a stand-in with the same contract — a
    // crossorigin module script and relative JSON fetches from an opaque-origin
    // sandbox, documentElement.dataset.theme from ?theme= and from
    // {type:"circtime-theme"} messages sent by the parent named in parent_origin.
    const embedDir = path.join(dir, "circtime");
    if (process.env.DASHBOARD_CIRCTIME_DIR) await cp(process.env.DASHBOARD_CIRCTIME_DIR, embedDir, { recursive: true });
    else {
      await mkdir(path.join(embedDir, "assets"), { recursive: true });
      await writeFile(path.join(embedDir, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><title>circtime fixture</title><script type="module" crossorigin src="./assets/index-Fx1x2x3x.js"></script><link rel="stylesheet" crossorigin href="./assets/index-Cs1s2s3s.css"></head><body><canvas id="radar" width="320" height="180"></canvas></body></html>\n');
      await writeFile(path.join(embedDir, "assets/index-Cs1s2s3s.css"), "body { margin: 0; background: transparent; } canvas { width: 100%; height: 100vh; display: block; }\n");
      await writeFile(path.join(embedDir, "assets/index-Fx1x2x3x.js"), [
        'const params = new URLSearchParams(location.search), root = document.documentElement;',
        'root.dataset.theme = params.get("theme") || "system";',
        'root.dataset.loadedAt = String(performance.timeOrigin);',
        'root.classList.toggle("circtime-embed", params.get("embed") === "1");',
        'addEventListener("message", event => { if (event.source !== parent || event.origin !== params.get("parent_origin")) return; if (event.data?.type === "circtime-theme") root.dataset.theme = event.data.theme; });',
        'const [config, latest] = await Promise.all(["circtime-config.json", "uptime-history.json"].map(name => fetch("./" + name, { cache: "no-store" }).then(response => response.json())));',
        'const context = document.querySelector("#radar").getContext("2d");',
        'context.fillStyle = "#22c55e"; context.beginPath(); context.arc(160, 90, 80, 0, Math.PI * 2); context.fill();',
        'root.dataset.services = String(config.infrastructure.length + latest.samples.length);',
      ].join("\n") + "\n");
      await writeFile(path.join(embedDir, "circtime-config.json"), JSON.stringify({ version: 2, infrastructure: [{ id: "ai-host" }] }));
      await writeFile(path.join(embedDir, "uptime-latest.json"), JSON.stringify({ checks: [{ id: "openclaw-gateway", status: "up" }] }));
      await writeFile(path.join(embedDir, "uptime-history.json"), JSON.stringify({ samples: Array.from({ length: 2000 }, (_, i) => ({ t: i, status: "up" })) }));
    }
    const metricsKeyFile = path.join(dir, "metrics-key");
    await writeFile(metricsKeyFile, randomBytes(32), { mode: 0o400 });
    const usageDir = path.join(dir, "usage-logs");
    for (const [provider, model] of [["cpa", "claude-test"], ["openai", "gpt-test"]]) writeUsage(usageDir, { runId: provider, provider, model, usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 }, lastAssistant: { timestamp: Date.now() } }, { agentId: "main" });
    child = spawn(process.execPath, ["server/index.js"], { cwd: dir, env: { ...process.env, NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port), OIDC_ISSUER: issuer, OIDC_CLIENT_ID: "test-dashboard", OIDC_CLIENT_SECRET: "test-client-secret", OIDC_REDIRECT_URI: "https://live.example.test/auth/callback", OIDC_REQUIRED_GROUP: "trance-0/app-agent", SESSION_SECRET: "test-session-secret", DASHBOARD_TOKEN: "test-mutation-token", OPENCLAW_ENDPOINT: issuer, OPENCLAW_TOKEN: "test-gateway-token", OPENCLAW_STREAM_TOKEN: "test-stream-token", CIRCTIME_EMBED_DIR: embedDir, ASTRBOT_ENDPOINT: issuer, JENKINS_ENDPOINT: issuer, OPENCLAW_CONFIG_FILE: configFile, METRICS_ENCRYPTION_KEY_FILE: metricsKeyFile, OPENCLAW_ACTIVITY_DIR: usageDir } });
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const base = `http://127.0.0.1:${port}`;
    const request = (url, init = {}) => fetch(base + url, { ...init, redirect: "manual", signal: AbortSignal.timeout(3000), headers: { connection: "close", "x-forwarded-proto": "https", ...init.headers } });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await request("/healthz")).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, output);
    for (const route of ["/api/panels", "/api/uptime", "/api/panels/openclaw/data", "/api/admin/recordings", "/api/admin/openclaw-config", "/api/admin/openclaw-tasks", "/api/admin/metrics/usage", "/api/admin/metrics/cpa", "/api/panels/usage-metrics/data"]) assert.equal((await request(route)).status, 401);
    assert.equal((await request("/api/admin/openclaw-config", { method: "PUT", headers: { "x-dashboard-request": "1", "content-type": "application/json" }, body: "{}" })).status, 401);
    assert.equal((await request("/api/panels/openclaw/toggle", { method: "POST", headers: { authorization: "Bearer test-mutation-token" } })).status, 401);
    assert.equal((await request("/auth/callback?code=unsolicited&state=unsolicited")).status, 400);
    const login = async (groups, nonceOverride) => {
      const response = await request("/auth/login");
      assert.equal(response.status, 302);
      const cookie = response.headers.get("set-cookie");
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /Secure/);
      assert.match(cookie, /SameSite=Lax/);
      const url = new URL(response.headers.get("location"));
      assert.equal(url.searchParams.get("redirect_uri"), "https://live.example.test/auth/callback");
      const code = String(codes.size);
      codes.set(code, { groups, nonce: nonceOverride || url.searchParams.get("nonce") });
      const headers = { cookie: cookie.split(";")[0] };
      return { code, state: url.searchParams.get("state"), headers };
    };
    const denied = await login([]);
    assert.equal((await request(`/auth/callback?code=${denied.code}&state=${denied.state}`, { headers: denied.headers })).status, 403);
    const badState = await login(["trance-0/app-agent"]);
    assert.equal((await request(`/auth/callback?code=${badState.code}&state=wrong`, { headers: badState.headers })).status, 400);
    const badNonce = await login(["trance-0/app-agent"], "wrong-nonce");
    assert.equal((await request(`/auth/callback?code=${badNonce.code}&state=${badNonce.state}`, { headers: badNonce.headers })).status, 400);
    const viewer = await login(["trance-0/app-agent"]);
    const viewerCallback = await request(`/auth/callback?code=${viewer.code}&state=${viewer.state}`, { headers: viewer.headers });
    const viewerHeaders = { cookie: viewerCallback.headers.get("set-cookie").split(";")[0], authorization: "Bearer test-mutation-token" };
    assert.equal((await request("/api/panels/settings/toggle", { method: "POST", headers: viewerHeaders })).status, 403);
    assert.equal((await request("/api/admin/openclaw-config", { headers: viewerHeaders })).status, 403, "viewers cannot read the OpenClaw config");
    for (const url of ["/api/admin/openclaw-tasks", "/api/admin/metrics/usage", "/api/admin/metrics/cpa", "/api/panels/usage-metrics/data", "/api/panels/cpa-quota/data"]) assert.equal((await request(url, { headers: viewerHeaders })).status, 403);
    const viewerPanels = (await (await request("/api/panels", { headers: viewerHeaders })).json()).panels;
    assert.ok(!viewerPanels.some(panel => ["cpa-quota", "usage-metrics", "openclaw-config"].includes(panel.id)), "admin-only panels stay out of the viewer menu");
    assert.ok(["astrbot", "build-status", "openclaw", "settings"].every(id => viewerPanels.some(panel => panel.id === id)));
    assert.equal((await request("/api/panels/openclaw-config/data", { headers: viewerHeaders })).status, 403);
    const openclawData = await (await request("/api/panels/openclaw/data", { headers: viewerHeaders })).json();
    assert.deepEqual(openclawData.agents.map(agent => [agent.id, agent.model.primary, agent.model.fallbacks.length, agent.inheritsDefault]), [["main", "cpa/claude-opus-5-5-high", 2, true], ["dashboard-host", "cpa/gpt-6-astra", 0, false]]);
    assert.ok(!JSON.stringify(openclawData).includes("literal-telegram-secret") && !JSON.stringify(openclawData).includes("/private/workspace"), "the agent summary carries IDs and model IDs only");
    assert.deepEqual(viewerPanels.find(panel => panel.id === "settings").settings.map(setting => [setting.key, setting.scope]), [["theme", "browser"], ["motion", "browser"], ["autoplay", "browser"], ["playbackRate", "browser"]]);
    const viewerMenu = await (await request("/api/panels", { headers: viewerHeaders })).json();
    assert.deepEqual(viewerMenu.groups.map(group => group.id), ["live", "openclaw", "adapters", "builds", "settings"], "members see only groups with a visible panel");
    assert.deepEqual(viewerPanels.find(panel => panel.id === "openclaw").tabs.map(tab => tab.id), ["openclaw-status", "openclaw-backends"]);
    assert.ok(!viewerPanels.some(panel => panel.id === "usage-summary"));
    assert.equal((await request("/api/admin/metrics/summary", { headers: viewerHeaders })).status, 403);
    assert.equal((await request("/api/admin/metrics/summary")).status, 401);
    // Scene API: same session gates as other admin routes; machine routes need the stream token.
    assert.equal((await request("/api/scene/layout")).status, 401);
    assert.equal((await request("/api/scene/layout", { headers: viewerHeaders })).status, 403);
    assert.equal((await request("/api/scene/widgets", { method: "POST", headers: { ...viewerHeaders, "x-dashboard-request": "1", "content-type": "application/json" }, body: JSON.stringify({ widget: { type: "text", x: 0, y: 0, w: 0.2, h: 0.1 } }) })).status, 403);
    assert.equal((await request("/api/openclaw/scene/layout")).status, 401);
    const page = await request("/");
    assert.match(page.headers.get("content-security-policy"), /^default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;/);
    const asset = await request("/scene/assets/" + (await readFile(path.join(root, "public/scene/assets.js"), "utf8")).match(/witch-idle\.[a-f0-9]{8}\.svg/)[0]);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("cache-control"), /max-age=31536000, immutable/);
    assert.equal((await request("/scene/assets/witch-idle.svg")).status, 404, "only hashed asset names exist");
    assert.match(page.headers.get("content-security-policy"), /frame-src 'self';.*frame-ancestors 'none'/);
    const embedPage = await request("/embed/circtime/?embed=1&theme=dark");
    assert.equal(embedPage.status, 200);
    assert.match(embedPage.headers.get("content-type"), /^text\/html/);
    assert.match(embedPage.headers.get("content-security-policy"), /^default-src 'self'; script-src 'self';.*frame-ancestors 'self'$/);
    assert.equal(embedPage.headers.get("x-content-type-options"), "nosniff");
    assert.equal(embedPage.headers.get("access-control-allow-origin"), "*", "the opaque-origin sandbox loads modules and JSON over CORS");
    assert.equal(embedPage.headers.get("access-control-allow-credentials"), null);
    const json = await request("/embed/circtime/uptime-history.json", { headers: { "accept-encoding": "br, gzip" } });
    assert.deepEqual([json.status, json.headers.get("content-encoding"), json.headers.get("cache-control"), json.headers.get("vary")], [200, "br", "no-cache", "Accept-Encoding"]);
    assert.ok(Array.isArray(JSON.parse(await json.text()).samples ?? []) , "fetch decodes brotli transparently");
    const gz = await request("/embed/circtime/circtime-config.json", { headers: { "accept-encoding": "gzip" } });
    assert.equal(gz.headers.get("content-encoding"), "gzip");
    const embedAsset = (await readFile(path.join(embedDir, "index.html"), "utf8")).match(/assets\/index-[A-Za-z0-9_-]+\.js/)[0];
    const script = await request(`/embed/circtime/${embedAsset}`, { headers: { "accept-encoding": "gzip" } });
    assert.deepEqual([script.status, script.headers.get("cache-control"), script.headers.get("content-encoding")], [200, "public, max-age=31536000, immutable", "gzip"]);
    assert.match(script.headers.get("content-type"), /javascript/);
    assert.equal((await request(`/embed/circtime/${embedAsset}`, { headers: { "if-none-match": script.headers.get("etag") } })).status, 304);
    const posted = await request("/embed/circtime/uptime-latest.json", { method: "POST", body: "{}" });
    assert.deepEqual([posted.status, posted.headers.get("allow"), posted.headers.get("access-control-allow-origin")], [405, "GET, HEAD", null], "GET and HEAD only");
    assert.equal((await request("/embed/circtime?embed=1")).headers.get("location"), "/embed/circtime/?embed=1", "the entry URL gets its trailing slash");
    assert.equal((await request("/embed/elsewhere/")).status, 404, "only allowlisted embed paths are served");
    assert.equal((await request("/embed/circtime/%2e%2e/%2e%2e/package.json")).status, 404, "no path traversal out of the embed directory");
    assert.equal((await request("/embed/circtime/..%2f..%2fpackage.json")).status, 404);
    assert.equal((await request("/embed/circtime/.env")).status, 404);
    const allowed = await login(["trance-0/app-agent", "trance-0/admin-agent"]);
    const callback = await request(`/auth/callback?code=${allowed.code}&state=${allowed.state}`, { headers: allowed.headers });
    assert.equal(callback.status, 302);
    const headers = { cookie: callback.headers.get("set-cookie").split(";")[0] };
    assert.notEqual(headers.cookie, allowed.headers.cookie);
    assert.equal((await request("/api/panels", { headers: allowed.headers })).status, 401);
    assert.equal((await (await request("/auth/user", { headers })).json()).sub, "test-user");
    assert.equal((await request("/api/panels", { headers })).status, 200);
    assert.equal((await request("/auth/avatar", { headers })).headers.get("content-type"), "image/png");
    assert.equal((await request("/auth/avatar")).status, 401);
    const mutation = { ...headers, "x-dashboard-request": "1", "content-type": "application/json" };
    const sceneWidget = { widget: { type: "text", x: 0.05, y: 0.05, w: 0.3, h: 0.1, props: { text: "Auth fixture" } } };
    assert.equal((await request("/api/scene/widgets", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(sceneWidget) })).status, 403, "scene edits need the same-origin header");
    assert.equal((await request("/api/scene/widgets", { method: "POST", headers: { ...mutation, origin: "https://attacker.invalid" }, body: JSON.stringify(sceneWidget) })).status, 403, "cross-origin scene edits are refused");
    assert.equal((await request("/api/scene/widgets", { method: "POST", headers: { ...mutation, authorization: "Bearer wrong" }, body: JSON.stringify(sceneWidget) })).status, 401);
    assert.equal((await (await request("/api/scene/layout", { headers })).json()).layout.builtin, true);
    const adminPanels = (await (await request("/api/panels", { headers })).json()).panels;
    assert.ok(adminPanels.some(panel => panel.id === "usage-metrics"));
    assert.ok(adminPanels.some(panel => panel.id === "cpa-quota"));
    const adminMenu = await (await request("/api/panels", { headers })).json();
    assert.deepEqual(adminMenu.groups.map(group => group.id), ["live", "openclaw", "usage", "adapters", "canvas", "builds", "settings"]);
    assert.deepEqual(adminPanels.filter(panel => panel.group === "usage").flatMap(panel => panel.tabs.map(tab => tab.title)), ["Summary", "CPA quota", "Token metrics"]);
    assert.deepEqual(adminPanels.filter(panel => panel.group === "openclaw").flatMap(panel => panel.tabs.map(tab => tab.title)), ["Status", "Backends", "Settings", "Scheduled tasks"]);
    const summary = await (await request("/api/admin/metrics/summary", { headers })).json();
    assert.equal(summary.tokens.week, 3600);
    assert.deepEqual(summary.codex.fiveHour, { remainingPercent: null, resetAt: null, accounts: 0, total: 0 });
    const metrics = await (await request("/api/admin/metrics/usage", { headers })).json();
    assert.equal(metrics.summary.tokens, 3600);
    assert.equal(metrics.summary.unpriced, 2);
    const credential = { endpoint: "https://quota.example", key: "PRIVATE-METRICS-KEY" };
    assert.equal((await request("/api/admin/metrics/cpa", { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(credential) })).status, 403);
    assert.equal((await request("/api/admin/metrics/cpa", { method: "PUT", headers: { ...mutation, ...viewerHeaders }, body: JSON.stringify(credential) })).status, 403);
    const savedCredential = await request("/api/admin/metrics/cpa", { method: "PUT", headers: mutation, body: JSON.stringify(credential) });
    assert.equal(savedCredential.status, 200);
    assert.ok(!(await savedCredential.text()).includes(credential.key));
    assert.ok(!(await readFile(path.join(dir, ".data/metrics/cpa-credential.enc.json"), "utf8")).includes(credential.key));
    const secretView = await request("/api/admin/metrics/cpa", { headers });
    assert.equal(secretView.headers.get("cache-control"), "no-store");
    assert.ok(!(await secretView.text()).includes(credential.key));
    assert.equal((await request("/api/admin/metrics/cpa", { method: "PUT", headers: mutation, body: JSON.stringify({ endpoint: "https://changed.example", key: "" }) })).status, 400, "changing endpoint cannot silently forward the old key");
    const price = { route: "cpa", model: "claude-test", input: 3, output: 15, cacheRead: .3, cacheWrite: 3.75 };
    assert.equal((await request("/api/admin/metrics/pricing", { method: "PUT", headers: { ...mutation, origin: "https://attacker.invalid" }, body: JSON.stringify(price) })).status, 403);
    assert.equal((await request("/api/admin/metrics/pricing", { method: "PUT", headers: mutation, body: JSON.stringify(price) })).status, 200);
    const priced = await (await request("/api/admin/metrics/usage?route=cpa", { headers })).json();
    assert.equal(priced.summary.costUsd, .010935);
    assert.equal((await request("/api/admin/metrics/cpa", { method: "DELETE", headers: mutation })).status, 200);
    assert.equal((await request("/api/admin/metrics/cpa/refresh", { method: "POST", headers: mutation, body: "{}" })).status, 409);
    const configView = await (await request("/api/admin/openclaw-config", { headers })).json();
    assert.equal(configView.config.channels.telegram.botToken, "__dashboard_redacted__");
    assert.ok(!JSON.stringify(configView).includes("literal-telegram-secret"));
    const editedConfig = JSON.stringify({ ...configView.config, gateway: { bind: "loopback", note: "x".repeat(20000) } });
    assert.equal((await request("/api/admin/openclaw-config", { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ text: editedConfig, baseHash: configView.hash }) })).status, 403, "config writes need the same-origin header");
    assert.equal((await request("/api/admin/openclaw-config", { method: "PUT", headers: { ...mutation, ...viewerHeaders }, body: JSON.stringify({ text: editedConfig, baseHash: configView.hash }) })).status, 403);
    assert.equal((await request("/api/admin/openclaw-config", { method: "PUT", headers: mutation, body: JSON.stringify({ text: "{ broken", baseHash: configView.hash }) })).status, 400);
    const savedConfig = await request("/api/admin/openclaw-config", { method: "PUT", headers: mutation, body: JSON.stringify({ text: editedConfig, baseHash: configView.hash }) });
    assert.equal(savedConfig.status, 200, "a >16 KiB config saves through its own body limit");
    const liveConfig = JSON.parse(await readFile(configFile, "utf8"));
    assert.equal(liveConfig.channels.telegram.botToken, "literal-telegram-secret");
    assert.equal(liveConfig.gateway.note.length, 20000);
    assert.equal((await request("/api/admin/openclaw-config", { method: "PUT", headers: mutation, body: JSON.stringify({ text: editedConfig, baseHash: configView.hash }) })).status, 409);
    assert.equal((await request("/api/broadcast/start", { method: "POST", headers, body: "{}" })).status, 403);
    assert.equal((await request("/api/broadcast/start", { method: "POST", headers: { ...mutation, origin: "https://attacker.invalid" }, body: "{}" })).status, 403);
    assert.equal((await request("/api/broadcast/start", { method: "POST", headers: { ...mutation, ...viewerHeaders }, body: JSON.stringify({ title: "Viewer stream" }) })).status, 403);
    assert.equal((await request("/api/chat", { method: "POST", headers: mutation, body: JSON.stringify({ message: "offline" }) })).status, 409);
    const started = await request("/api/broadcast/start", { method: "POST", headers: mutation, body: JSON.stringify({ title: "Test stream" }) });
    assert.equal(started.status, 201);
    const streamId = (await started.json()).stream.id;
    assert.equal((await request("/api/broadcast/start", { method: "POST", headers: mutation, body: JSON.stringify({ title: "Duplicate" }) })).status, 409);
    const publicStream = await request("/api/stream");
    assert.equal(publicStream.status, 200);
    assert.match(publicStream.headers.get("content-type"), /^text\/event-stream/);
    await publicStream.body.cancel();
    assert.equal((await request("/api/chat", { method: "POST", body: "{}" })).status, 401);
    assert.equal((await request("/api/chat", { method: "POST", headers: mutation, body: JSON.stringify({ message: "Hello host" }) })).status, 202);
    let recording;
    for (let i = 0; i < 50; i++) {
      recording = await (await request(`/api/recordings/${streamId}/events`)).json();
      if (recording.events.some(event => event.msg === "Welcome to the stream!")) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(recording.events.some(event => event.kind === "chat" && event.msg === "Hello host"));
    assert.ok(recording.events.some(event => event.kind === "log" && event.msg === "Welcome to the stream!"));
    assert.ok(!recording.events.some(event => event.msg.includes("configured endpoint")));
    assert.equal((await request("/api/broadcast/end", { method: "POST", headers: mutation, body: "{}" })).status, 200);
    assert.equal((await (await request("/api/recordings")).json()).recordings.length, 1);
    assert.equal((await request(`/api/recordings/${streamId}`, { method: "PATCH", headers: mutation, body: JSON.stringify({ hidden: true, score: 90 }) })).status, 200);
    assert.equal((await request(`/api/recordings/${streamId}/events`)).status, 404);
    assert.equal((await request(`/api/recordings/${streamId}/events`, { headers })).status, 200);
    assert.equal((await (await request("/api/recordings")).json()).recordings.length, 0);
    assert.equal((await (await request("/api/admin/recordings", { headers })).json()).recordings[0].score, 90);
    await request(`/api/recordings/${streamId}`, { method: "PATCH", headers: mutation, body: JSON.stringify({ hidden: false, score: 10 }) });
    if (process.env.DASHBOARD_BROWSER_CHECK === "1") {
      const check = spawn(process.execPath, [path.join(root, "scripts/browser-check.mjs")], { env: { ...process.env, DASHBOARD_TEST_URL: base, DASHBOARD_TEST_COOKIE: headers.cookie }, stdio: "inherit" });
      const [code] = await once(check, "exit");
      assert.equal(code, 0);
      const metricsCheck = spawn(process.execPath, [path.join(root, "scripts/metrics-browser-check.mjs")], { env: { ...process.env, DASHBOARD_TEST_URL: base, DASHBOARD_TEST_COOKIE: headers.cookie, DASHBOARD_VIEWER_COOKIE: viewerHeaders.cookie }, stdio: "inherit" });
      const [metricsCode] = await once(metricsCheck, "exit");
      assert.equal(metricsCode, 0);
      const uiCheck = spawn(process.execPath, [path.join(root, "scripts/ui-browser-check.mjs")], { env: { ...process.env, DASHBOARD_TEST_URL: base, DASHBOARD_TEST_COOKIE: headers.cookie, DASHBOARD_VIEWER_COOKIE: viewerHeaders.cookie }, stdio: "inherit" });
      const [uiCode] = await once(uiCheck, "exit");
      assert.equal(uiCode, 0);
      const pagesCheck = spawn(process.execPath, [path.join(root, "scripts/pages-browser-check.mjs")], { env: { ...process.env, DASHBOARD_TEST_URL: base, DASHBOARD_TEST_COOKIE: headers.cookie, DASHBOARD_VIEWER_COOKIE: viewerHeaders.cookie }, stdio: "inherit" });
      const [pagesCode] = await once(pagesCheck, "exit");
      assert.equal(pagesCode, 0);
      const sceneCheck = spawn(process.execPath, [path.join(root, "scripts/scene-browser-check.mjs")], { env: { ...process.env, DASHBOARD_TEST_URL: base, DASHBOARD_TEST_COOKIE: headers.cookie, DASHBOARD_VIEWER_COOKIE: viewerHeaders.cookie, DASHBOARD_STREAM_TOKEN: "test-stream-token" }, stdio: "inherit" });
      const [sceneCode] = await once(sceneCheck, "exit");
      assert.equal(sceneCode, 0);
      const controlCheck = spawn(process.execPath, [path.join(root, "scripts/control-browser-check.mjs")], { env: { ...process.env, DASHBOARD_TEST_URL: base, DASHBOARD_TEST_COOKIE: headers.cookie, DASHBOARD_STREAM_TOKEN: "test-stream-token" }, stdio: "inherit" });
      const [controlCode] = await once(controlCheck, "exit");
      assert.equal(controlCode, 0);
      const canvasCheck = spawn(process.execPath, [path.join(root, "scripts/canvas-browser-check.mjs")], { env: { ...process.env, DASHBOARD_TEST_URL: base, DASHBOARD_TEST_COOKIE: headers.cookie, DASHBOARD_VIEWER_COOKIE: viewerHeaders.cookie }, stdio: "inherit" });
      const [canvasCode] = await once(canvasCheck, "exit");
      assert.equal(canvasCode, 0);
    }
    if (process.env.DASHBOARD_CANVAS_ONLY_CHECK === "1") {
      const check = spawn(process.execPath, [path.join(root, "scripts/canvas-browser-check.mjs")], { env: { ...process.env, DASHBOARD_TEST_URL: base, DASHBOARD_TEST_COOKIE: headers.cookie, DASHBOARD_VIEWER_COOKIE: viewerHeaders.cookie }, stdio: "inherit" });
      const [code] = await once(check, "exit"); assert.equal(code, 0);
    }
    if (process.env.DASHBOARD_CANVAS_FEATURES_CHECK === "1") {
      const check = spawn(process.execPath, [path.join(root, "scripts/canvas-features-browser-check.mjs")], { env: { ...process.env, DASHBOARD_TEST_URL: base, DASHBOARD_TEST_COOKIE: headers.cookie }, stdio: "inherit" });
      const [code] = await once(check, "exit"); assert.equal(code, 0);
    }
    if (process.env.DASHBOARD_SETTINGS_BROWSER_CHECK === "1") {
      const check = spawn(process.execPath, [path.join(root, "scripts/settings-browser-check.mjs")], { env: { ...process.env, DASHBOARD_TEST_URL: base, DASHBOARD_TEST_COOKIE: headers.cookie }, stdio: "inherit" });
      const [code] = await once(check, "exit"); assert.equal(code, 0);
    }
    const toggle = "/api/panels/settings/toggle";
    // Browser path: admin session + same-origin header. Automation path: admin session + bearer.
    assert.equal((await request(toggle, { method: "POST", headers })).status, 403, "toggle needs the same-origin header or the bearer");
    assert.equal((await request(toggle, { method: "POST", headers: { ...mutation, origin: "https://attacker.invalid" }, body: JSON.stringify({ enabled: false }) })).status, 403);
    assert.equal((await request(toggle, { method: "POST", headers: { ...mutation, cookie: viewerHeaders.cookie }, body: JSON.stringify({ enabled: false }) })).status, 403, "viewers cannot toggle from the browser");
    assert.equal((await request(toggle, { method: "POST", headers: { ...headers, authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await request(toggle, { method: "POST", headers: { ...mutation, authorization: "Bearer wrong" }, body: "{}" })).status, 401, "a wrong bearer is rejected, not ignored");
    assert.equal((await request("/api/panels/live-stream/toggle", { method: "POST", headers: mutation, body: JSON.stringify({ enabled: false }) })).status, 400);
    const browserToggle = await request("/api/panels/astrbot/toggle", { method: "POST", headers: mutation, body: JSON.stringify({ enabled: false }) });
    assert.deepEqual(await browserToggle.json(), { id: "astrbot", enabled: false });
    assert.ok(!(await (await request("/api/panels", { headers: viewerHeaders })).json()).panels.some(panel => panel.id === "astrbot"), "disabled panels leave the member menu");
    assert.equal((await (await request("/api/panels", { headers })).json()).panels.find(panel => panel.id === "astrbot").enabled, false, "admins still see disabled panels");
    assert.deepEqual(await (await request("/api/panels/astrbot/toggle", { method: "POST", headers: mutation, body: JSON.stringify({ enabled: true }) })).json(), { id: "astrbot", enabled: true });
    const changed = await request(toggle, { method: "POST", headers: { ...headers, authorization: "Bearer test-mutation-token", "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
    assert.deepEqual(await changed.json(), { id: "settings", enabled: false });
    assert.equal((await request("/api/panels/settings/data", { headers })).status, 404);
    await request("/api/panels/cpa-quota/toggle", { method: "POST", headers: { ...mutation, authorization: "Bearer test-mutation-token" }, body: JSON.stringify({ enabled: false }) });
    assert.equal((await request("/api/admin/metrics/cpa", { headers })).status, 404);
    assert.equal((await request("/api/admin/metrics/cpa/refresh", { method: "POST", headers: mutation, body: "{}" })).status, 404);
    await request("/auth/logout", { headers });
    assert.equal((await request("/api/panels", { headers })).status, 401);
  } finally {
    if (child) { child.kill(); await once(child, "exit"); }
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
