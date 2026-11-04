import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("OIDC sessions, group authorization, mutation tokens, and HTTPS cookies", { timeout: 60000 }, async () => {
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
    child = spawn(process.execPath, ["server/index.js"], { cwd: dir, env: { ...process.env, NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port), OIDC_ISSUER: issuer, OIDC_CLIENT_ID: "test-dashboard", OIDC_CLIENT_SECRET: "test-client-secret", OIDC_REDIRECT_URI: "https://live.example.test/auth/callback", OIDC_REQUIRED_GROUP: "trance-0/app-agent", SESSION_SECRET: "test-session-secret", DASHBOARD_TOKEN: "test-mutation-token", OPENCLAW_ENDPOINT: issuer, OPENCLAW_TOKEN: "test-gateway-token", ASTRBOT_ENDPOINT: issuer, JENKINS_ENDPOINT: issuer } });
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
    for (const route of ["/api/panels", "/api/uptime", "/api/panels/openclaw/data", "/api/admin/recordings"]) assert.equal((await request(route)).status, 401);
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
    }
    const toggle = "/api/panels/settings/toggle";
    assert.equal((await request(toggle, { method: "POST", headers })).status, 401);
    assert.equal((await request(toggle, { method: "POST", headers: { ...headers, authorization: "Bearer wrong" } })).status, 401);
    const changed = await request(toggle, { method: "POST", headers: { ...headers, authorization: "Bearer test-mutation-token", "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
    assert.deepEqual(await changed.json(), { id: "settings", enabled: false });
    assert.equal((await request("/api/panels/settings/data", { headers })).status, 404);
    await request("/auth/logout", { headers });
    assert.equal((await request("/api/panels", { headers })).status, 401);
  } finally {
    if (child) { child.kill(); await once(child, "exit"); }
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
