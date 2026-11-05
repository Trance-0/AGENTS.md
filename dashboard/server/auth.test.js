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

test("OIDC sessions, group authorization, mutation tokens, and HTTPS cookies", { timeout: process.env.DASHBOARD_BROWSER_CHECK === "1" ? 180000 : 60000 }, async () => {
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
    await writeFile(configFile, JSON.stringify({ gateway: { bind: "loopback" }, channels: { telegram: { botToken: "literal-telegram-secret", groupPolicy: "allowlist" } } }, null, 2) + "\n");
    const metricsKeyFile = path.join(dir, "metrics-key");
    await writeFile(metricsKeyFile, randomBytes(32), { mode: 0o400 });
    const usageDir = path.join(dir, "usage-logs");
    for (const [provider, model] of [["cpa", "claude-test"], ["openai", "gpt-test"]]) writeUsage(usageDir, { runId: provider, provider, model, usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 }, lastAssistant: { timestamp: Date.now() } }, { agentId: "main" });
    child = spawn(process.execPath, ["server/index.js"], { cwd: dir, env: { ...process.env, NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port), OIDC_ISSUER: issuer, OIDC_CLIENT_ID: "test-dashboard", OIDC_CLIENT_SECRET: "test-client-secret", OIDC_REDIRECT_URI: "https://live.example.test/auth/callback", OIDC_REQUIRED_GROUP: "trance-0/app-agent", SESSION_SECRET: "test-session-secret", DASHBOARD_TOKEN: "test-mutation-token", OPENCLAW_ENDPOINT: issuer, OPENCLAW_TOKEN: "test-gateway-token", ASTRBOT_ENDPOINT: issuer, JENKINS_ENDPOINT: issuer, OPENCLAW_CONFIG_FILE: configFile, METRICS_ENCRYPTION_KEY_FILE: metricsKeyFile, OPENCLAW_ACTIVITY_DIR: usageDir } });
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
    for (const route of ["/api/panels", "/api/uptime", "/api/panels/openclaw/data", "/api/admin/recordings", "/api/admin/openclaw-config", "/api/admin/metrics/usage", "/api/admin/metrics/cpa", "/api/panels/usage-metrics/data"]) assert.equal((await request(route)).status, 401);
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
    for (const url of ["/api/admin/metrics/usage", "/api/admin/metrics/cpa", "/api/panels/usage-metrics/data", "/api/panels/cpa-quota/data"]) assert.equal((await request(url, { headers: viewerHeaders })).status, 403);
    const viewerPanels = (await (await request("/api/panels", { headers: viewerHeaders })).json()).panels;
    assert.ok(!viewerPanels.some(panel => ["cpa-quota", "usage-metrics", "openclaw-config"].includes(panel.id)), "admin-only panels stay out of the viewer menu");
    assert.ok(["astrbot", "build-status", "openclaw", "settings"].every(id => viewerPanels.some(panel => panel.id === id)));
    assert.equal((await request("/api/panels/openclaw-config/data", { headers: viewerHeaders })).status, 403);
    assert.deepEqual(viewerPanels.find(panel => panel.id === "settings").settings.map(setting => [setting.key, setting.scope]), [["theme", "browser"], ["autoplay", "browser"]]);
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
    const adminPanels = (await (await request("/api/panels", { headers })).json()).panels;
    assert.ok(adminPanels.some(panel => panel.id === "usage-metrics"));
    assert.ok(adminPanels.some(panel => panel.id === "cpa-quota"));
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
