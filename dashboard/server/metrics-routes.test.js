import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import express from "express";
import { mountMetrics } from "./metrics/routes.js";
import { MetricsStore } from "./metrics/store.js";
import { SecretStore } from "./metrics/secrets.js";

test("quota refresh is cached privately and invalidated when credentials change", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metrics-routes-"));
  const key = path.join(dir, "key"); fs.writeFileSync(key, randomBytes(32));
  const store = new MetricsStore(path.join(dir, "data")); const secrets = new SecretStore(path.join(dir, "data"), key);
  const app = express(); app.use(express.json());
  let release, blocked = false;
  const fetcher = async (_url, options) => {
    assert.ok(options.headers.authorization.startsWith("Bearer "));
    if (blocked) await new Promise(resolve => { release = resolve; });
    return Response.json({ files: [] });
  };
  const allow = (_req, _res, next) => next();
  mountMetrics(app, { store, secrets, fetcher, requireAuth: allow, requireAdmin: allow, requireCsrf: allow, isEnabled: async () => true });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/admin/metrics/cpa`;
  const request = (method, body, suffix = "") => fetch(url + suffix, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await request("PUT", { endpoint: "https://quota.example", key: "first-secret" })).status, 200);
    const refreshed = await request("POST", {}, "/refresh"); assert.equal(refreshed.status, 200);
    assert.deepEqual((await refreshed.json()).snapshot.accounts, []);
    assert.equal((await request("POST", {}, "/refresh")).status, 429);
    assert.ok((await (await request("GET")).json()).snapshot.updatedAt);
    assert.equal((await request("PUT", { endpoint: "https://quota.example", key: "second-secret" })).status, 200);
    blocked = true;
    const pending = request("POST", {}, "/refresh");
    for (let i = 0; !release && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(release);
    assert.equal((await request("DELETE")).status, 200);
    release();
    assert.equal((await pending).status, 409);
    const state = await (await request("GET")).json(); assert.equal(state.configured, false); assert.equal(state.snapshot, null);
    assert.ok(!JSON.stringify(state).includes("secret"));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
