import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { BroadcastStore } from "./broadcast.js";
import { SceneStore } from "./scene/store.js";
import { SceneService } from "./scene/service.js";
import { MetricsBridge, metricValues } from "./scene/bridge.js";
import { mountScene } from "./scene/routes.js";
import { fold } from "../public/scene/reduce.js";

const TOKEN = "scene-stream-token";
const OWNER = "a".repeat(64), OTHER = "b".repeat(64);

async function fixture({ limits, embeds = [] } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "scene-routes-"));
  const broadcast = new BroadcastStore(path.join(dir, "recordings"));
  const store = new SceneStore(path.join(dir, "scene"), { embeds });
  const warnings = [];
  const scene = new SceneService({ broadcast, store, emit: event => warnings.push(event), limits });
  const app = express();
  app.use(express.json({ limit: "16kb" }));
  // Test session: the x-test-role header stands in for the OIDC session.
  app.use((req, _res, next) => { const role = req.get("x-test-role"); req.session = role ? { user: { sub: role, isAdmin: role === "admin" } } : {}; next(); });
  const requireCsrfOrToken = (req, res, next) => (req.get("x-dashboard-request") === "1" && (!req.get("origin") || req.get("origin") === "https://live.example.test") ? next() : res.status(403).json({ error: "Request cannot be accepted: dashboard/request origin — use the dashboard page on its configured origin." }));
  mountScene(app, { scene, store, streamToken: TOKEN, requireCsrfOrToken });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const response = await fetch(base + url, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const admin = { "x-test-role": "admin", "x-dashboard-request": "1" };
  const oc = { authorization: `Bearer ${TOKEN}` };
  const events = () => broadcast.active ? broadcast.readEvents(broadcast.active.id, 0, 10000) : [];
  const close = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); };
  return { broadcast, store, scene, call, admin, oc, events, warnings, close };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const text = (props = {}) => ({ type: "text", x: 0.1, y: 0.1, w: 0.3, h: 0.1, props: { text: "Hello", ...props } });

test("admin scene routes require an admin session and the same-origin header", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call("GET", "/api/scene/layout")).status, 401);
    assert.equal((await f.call("GET", "/api/scene/layout", undefined, { "x-test-role": "viewer" })).status, 403);
    assert.equal((await f.call("POST", "/api/scene/widgets", { widget: text() }, { "x-test-role": "viewer", "x-dashboard-request": "1" })).status, 403);
    assert.equal((await f.call("POST", "/api/scene/widgets", { widget: text() }, { "x-test-role": "admin" })).status, 403, "no same-origin header");
    assert.equal((await f.call("POST", "/api/scene/widgets", { widget: text() }, { ...f.admin, origin: "https://attacker.invalid" })).status, 403, "cross-origin");
    for (const [method, url] of [["PUT", "/api/scene/layout"], ["PATCH", "/api/scene/widgets/avatar"], ["DELETE", "/api/scene/widgets/avatar"], ["PUT", "/api/scene/settings"]]) {
      assert.equal((await f.call(method, url, {})).status, 401, `${method} ${url} anonymous`);
      assert.equal((await f.call(method, url, {}, { "x-test-role": "viewer", "x-dashboard-request": "1" })).status, 403, `${method} ${url} viewer`);
    }
    const view = await f.call("GET", "/api/scene/layout", undefined, { "x-test-role": "admin" });
    assert.deepEqual([view.body.layout.version, view.body.layout.builtin, view.body.live], [0, true, null]);
  } finally { await f.close(); }
});

test("offline edits change only the saved layout, which opens the next stream", async () => {
  const f = await fixture();
  try {
    const created = await f.call("POST", "/api/scene/widgets", { widget: text() }, f.admin);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual([created.body.recorded, created.body.layoutVersion], [false, 1]);
    const id = created.body.widget.id;
    assert.match(id, /^w-[a-f0-9]{8}$/);
    assert.equal(created.body.widget.z, 102, "new widgets go on top");
    assert.equal((await f.call("PATCH", `/api/scene/widgets/${id}`, { changes: { x: 0.5 } }, f.admin)).body.widget.x, 0.5);
    assert.equal((await f.call("PATCH", `/api/scene/widgets/${id}`, { changes: { type: "image" } }, f.admin)).status, 400);
    assert.equal((await f.call("PATCH", "/api/scene/widgets/missing", { changes: { x: 0.5 } }, f.admin)).status, 404);
    assert.match((await f.call("POST", "/api/scene/widgets", { widget: { ...text(), type: "iframe" } }, f.admin)).body.error, /^Widget not created: dashboard\/scene widgets — widget type 'iframe' is not supported\.$/);
    assert.equal((await f.call("POST", "/api/scene/widgets", { widget: { ...text(), id } }, f.admin)).status, 409);
    const image = { type: "image", x: 0, y: 0, w: 0.2, h: 0.2, props: { url: "https://img.example.com/stream/a.png" } };
    assert.equal((await f.call("POST", "/api/scene/widgets", { widget: image }, f.admin)).status, 400, "no allowlist yet");
    assert.equal((await f.call("PUT", "/api/scene/settings", { imageAllowlist: ["https://img.example.com/stream"] }, f.admin)).status, 200);
    assert.equal((await f.call("POST", "/api/scene/widgets", { widget: image }, f.admin)).status, 201);
    assert.equal((await f.call("PUT", "/api/scene/layout", { widgets: [], baseVersion: 1 }, f.admin)).status, 409, "stale baseVersion");
    assert.equal(f.store.layout().widgets.length, 4);
    assert.equal(f.broadcast.list(true).length, 0, "no recording is created by offline edits");

    f.broadcast.start("Scene stream");
    await flush();
    const opening = f.events().filter(event => event.kind === "widget");
    assert.deepEqual(opening.map(event => [event.op, event.target]), f.store.layout().widgets.map(widget => ["create", widget.id]));
    assert.ok(f.events()[0].msg.startsWith("Stream is live"), "the opening scene follows the live event");
    assert.ok(opening.every(event => event.sv === 1 && event.source === "dashboard" && JSON.stringify(event).length <= 2048));
    // A second status notification for the same stream does not replay the layout again.
    f.broadcast.notify("status", f.broadcast.status());
    await flush();
    assert.equal(f.events().filter(event => event.kind === "widget").length, opening.length);
  } finally { await f.close(); }
});

test("a stream recovered after a restart is not given an opening scene later", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "scene-recover-"));
  try {
    const first = new BroadcastStore(path.join(dir, "recordings"));
    first.start("Started before scenes");
    // Restart: a new store resumes the live recording, then a summary update notifies status.
    const broadcast = new BroadcastStore(path.join(dir, "recordings"));
    const scene = new SceneService({ broadcast, store: new SceneStore(path.join(dir, "scene")) });
    broadcast.summarize("Later summary");
    await flush();
    assert.equal(broadcast.readEvents(broadcast.active.id, 0, 100).filter(event => event.kind === "widget").length, 0);
    assert.deepEqual(scene.liveWidgets(), []);
    broadcast.stop();
    broadcast.start("Next stream");
    await flush();
    assert.equal(broadcast.readEvents(broadcast.active.id, 0, 100).filter(event => event.kind === "widget").length, 2, "the next real start opens the saved layout");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("live admin edits are recorded and also saved; the recording folds to the live scene", async () => {
  const f = await fixture();
  try {
    f.broadcast.start("Live edits");
    await flush();
    const created = await f.call("POST", "/api/scene/widgets", { widget: text({ text: "Live title" }) }, f.admin);
    assert.equal(created.body.recorded, true);
    const id = created.body.widget.id;
    await f.call("PATCH", `/api/scene/widgets/${id}`, { changes: { props: { size: 40 } } }, f.admin);
    await f.call("DELETE", "/api/scene/widgets/cat", undefined, f.admin);
    const ops = f.events().filter(event => event.kind === "widget").map(event => event.op);
    assert.deepEqual(ops, ["create", "create", "create", "update", "delete"]);
    assert.ok(f.store.layout().widgets.some(widget => widget.id === id && widget.props.size === 40), "saved layout follows admin edits");
    assert.ok(!f.store.layout().widgets.some(widget => widget.id === "cat"));
    assert.deepEqual(fold(f.events()).widgets, f.scene.liveState().state.widgets, "replay reproduces the live scene");
    const view = await f.call("GET", "/api/scene/layout", undefined, { "x-test-role": "admin" });
    assert.deepEqual(view.body.live.widgets.map(widget => widget.id).sort(), ["avatar", id].sort());
  } finally { await f.close(); }
});

test("OpenClaw scene routes need the stream token and the session that owns the live recording", async () => {
  const f = await fixture({ limits: { openclaw: 0.0001, openclawBurst: 4 } });
  try {
    const body = extra => ({ recordingId: f.broadcast.active?.id ?? "00000000-0000-0000-0000-000000000000", sessionRef: OWNER, ...extra });
    assert.equal((await f.call("POST", "/api/openclaw/scene/widgets", body({ widget: text() }))).status, 401, "no token");
    assert.equal((await f.call("POST", "/api/openclaw/scene/widgets", body({ widget: text() }), { authorization: "Bearer wrong" })).status, 401);
    assert.equal((await f.call("POST", "/api/openclaw/scene/widgets", body({ widget: text() }), { ...f.admin })).status, 401, "an admin session is not the machine token");
    assert.equal((await f.call("POST", "/api/openclaw/scene/widgets", body({ widget: text() }), f.oc)).status, 409, "nothing is live");
    f.broadcast.start("Admin stream");
    await flush();
    assert.equal((await f.call("POST", "/api/openclaw/scene/widgets", body({ widget: text() }), f.oc)).status, 409, "streams started by an administrator are not OpenClaw's");
    f.broadcast.stop();
    f.broadcast.start("OpenClaw stream", { origin: "openclaw", agentId: "main", sessionRef: OWNER });
    await flush();
    assert.equal((await f.call("POST", "/api/openclaw/scene/widgets", { ...body({ widget: text() }), sessionRef: OTHER }, f.oc)).status, 409, "another session");
    assert.equal((await f.call("POST", "/api/openclaw/scene/widgets", { ...body({ widget: text() }), sessionRef: "short" }, f.oc)).status, 400);
    assert.equal((await f.call("GET", `/api/openclaw/scene/layout?recordingId=${f.broadcast.active.id}&sessionRef=${OTHER}`, undefined, f.oc)).status, 409);
    const listed = await f.call("GET", `/api/openclaw/scene/layout?recordingId=${f.broadcast.active.id}&sessionRef=${OWNER}`, undefined, f.oc);
    assert.deepEqual(listed.body.widgets.map(widget => widget.id), ["avatar", "cat"]);
    const layoutBefore = JSON.stringify(f.store.layout());
    const created = await f.call("POST", "/api/openclaw/scene/widgets", body({ widget: { ...text(), id: "oc-title" } }), f.oc);
    assert.deepEqual([created.status, created.body.recorded], [201, true]);
    assert.equal((await f.call("PATCH", "/api/openclaw/scene/widgets/oc-title", body({ changes: { y: 0.5 } }), f.oc)).body.widget.y, 0.5);
    assert.equal((await f.call("POST", "/api/openclaw/scene/widgets", body({ widget: { ...text(), props: { text: "<img src=x onerror=alert(1)>", script: "x" } } }), f.oc)).status, 400);
    assert.equal((await f.call("DELETE", "/api/openclaw/scene/widgets/cat", body({}), f.oc)).status, 200);
    assert.equal(JSON.stringify(f.store.layout()), layoutBefore, "OpenClaw never rewrites the saved default layout");
    const limited = await f.call("PATCH", "/api/openclaw/scene/widgets/oc-title", body({ changes: { y: 0.4 } }), f.oc);
    assert.equal(limited.status, 429);
    assert.match(limited.body.error, /^Scene change not accepted: dashboard\/scene rate limit — OpenClaw may change the scene at most 2 times per second\.$/);
    const sources = new Set(f.events().filter(event => event.kind === "widget" && event.source === "openclaw").map(event => event.op));
    assert.deepEqual([...sources], ["create", "update", "delete"]);
  } finally { await f.close(); }
});

test("metric widgets publish pooled public values once per refresh and keep the last value on failure", async () => {
  const f = await fixture();
  try {
    const now = Date.UTC(2026, 10, 5, 12);
    let snapshot = { updatedAt: now - 60000, accounts: [
      { provider: "codex", label: "codex account 1", windows: [{ label: "Primary window", windowSeconds: 18000, remainingPercent: 40, resetsAt: now + 3600e3 }] },
      { provider: "codex", label: "codex account 2", windows: [{ label: "Secondary window", windowSeconds: 18000, remainingPercent: 60, resetsAt: now + 7200e3 }] },
    ] };
    let refreshes = 0, failNext = false;
    const quota = { snapshot: () => snapshot, refresh: async () => { refreshes++; if (failNext) throw Object.assign(new Error("Quota unavailable: dashboard/CPA management — remote request timed out or could not connect."), { status: 502 }); return snapshot; } };
    const metrics = { tokensBetween: () => 1234567 };
    const bridge = new MetricsBridge({ scene: f.scene, broadcast: f.broadcast, metrics, quota, secrets: { read: () => ({ endpoint: "https://quota.example" }) }, isEnabled: async () => true, emit: event => f.warnings.push(event), now: () => now });
    assert.equal(await bridge.cycle(), null, "nothing is live");
    f.broadcast.start("Metrics stream");
    await flush();
    await bridge.cycle();
    assert.equal(refreshes, 0, "no CPA calls without a CPA widget on stage");
    assert.equal(f.events().filter(event => event.op === "metrics").length, 0, "no metrics in a recording without metric widgets");
    await f.call("POST", "/api/scene/widgets", { widget: { type: "metric", x: 0, y: 0, w: 0.2, h: 0.1, props: { source: "cpa.codex.5h" } } }, f.admin);
    await f.call("POST", "/api/scene/widgets", { widget: { type: "metric", x: 0, y: 0.2, w: 0.2, h: 0.1, props: { source: "tokens.today" } } }, f.admin);
    await bridge.running;
    await bridge.cycle();
    assert.equal(refreshes, 1);
    const published = f.events().filter(event => event.op === "metrics");
    assert.deepEqual(fold(f.events()).metrics["cpa.codex.5h"], { remainingPercent: 50, resetAt: now + 3600e3, accounts: 2, total: 2, updatedAt: now - 60000 });
    assert.ok(!JSON.stringify(published).includes("account 1") && !JSON.stringify(published).includes("label"), "no account labels in public events");
    assert.equal(fold(f.events()).metrics["tokens.today"].tokens, 1230000, "token counts are rounded to 3 significant figures");
    const count = published.length;
    await bridge.cycle();
    assert.equal(f.events().filter(event => event.op === "metrics").length, count, "unchanged values publish nothing");
    failNext = true;
    await bridge.cycle();
    assert.equal(f.events().filter(event => event.op === "metrics").length, count, "a failed refresh keeps the last published value");
    assert.match(f.warnings.at(-1).msg, /^Scene metric kept its last value: dashboard\/scene metrics refresh — remote request timed out/);
    snapshot = { ...snapshot, accounts: [{ ...snapshot.accounts[0], windows: [{ ...snapshot.accounts[0].windows[0], remainingPercent: 0 }] }, { provider: "codex", windows: [] }] };
    failNext = false;
    await bridge.cycle();
    assert.deepEqual(fold(f.events()).metrics["cpa.codex.5h"], { remainingPercent: 0, resetAt: now + 3600e3, accounts: 1, total: 2, updatedAt: now - 60000 }, "one event per refresh, n of m accounts");
    assert.deepEqual(metricValues(new Set(["cpa.codex.week"]), { snapshot, cpaEnabled: false, metrics, now }), { "cpa.codex.week": { remainingPercent: null, resetAt: null, accounts: 0, total: 0, updatedAt: null } }, "a disabled CPA panel publishes no quota");
  } finally { await f.close(); }
});

test("embed widgets validate against the deployment's served pages and start on the back layer", async () => {
  const f = await fixture({ embeds: ["/embed/circtime/"] });
  try {
    const view = await f.call("GET", "/api/scene/layout", undefined, { "x-test-role": "admin" });
    assert.deepEqual(view.body.settings.embeds, ["/embed/circtime/"]);
    assert.equal(view.body.layout.widgets[0].type, "embed", "the built-in layout includes the backdrop");
    const created = await f.call("POST", "/api/scene/widgets", { widget: { type: "embed", x: 0, y: 0, w: 0.5, h: 0.5, props: { src: "/embed/circtime/" } } }, f.admin);
    assert.deepEqual([created.status, created.body.widget.z, created.body.widget.props.opacity], [201, 0, 0.3]);
    assert.equal((await f.call("POST", "/api/scene/widgets", { widget: { type: "embed", x: 0, y: 0, w: 1, h: 1, props: { src: "/embed/unknown/" } } }, f.admin)).status, 400);
    assert.equal((await f.call("PATCH", `/api/scene/widgets/${created.body.widget.id}`, { changes: { props: { opacity: 0.6 } } }, f.admin)).body.widget.props.opacity, 0.6);
  } finally { await f.close(); }
});

