import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { BroadcastStore } from "./broadcast.js";
import { SceneStore } from "./scene/store.js";
import { SceneService } from "./scene/service.js";
import { StreamControl, sessionRef } from "./stream-control.js";
import { UsageLine, usageText, MIN_GAP_MS, REFRESH_MS } from "./usage-line.js";
import { fold } from "../public/scene/reduce.js";
import { avatarExpression } from "../public/scene/derive.js";
import { validateWidget, mergeWidget, validateAvatarState } from "../public/scene/schema.js";
import register from "../openclaw-plugin/index.js";

process.env.OIDC_ISSUER = "https://issuer.example";
process.env.OIDC_CLIENT_ID = "test";
process.env.OIDC_CLIENT_SECRET = "test";
process.env.SESSION_SECRET = "test";
process.env.OPENCLAW_STREAM_TOKEN = "stream-control-token";
process.env.OPENCLAW_TOKEN = "gateway-token";

const RECORDING = /^[a-f0-9-]{36}$/;

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stream-control-"));
  const { mountOpenClaw } = await import("./openclaw-routes.js");
  const { mountScene } = await import("./scene/routes.js");
  const broadcast = new BroadcastStore(path.join(directory, "recordings"));
  const audit = [];
  const control = new StreamControl({ broadcast, emit: event => audit.push(event) });
  const scene = new SceneService({ broadcast, store: new SceneStore(path.join(directory, "scene")) });
  const app = express(); app.use(express.json());
  mountOpenClaw(app, broadcast, { control });
  mountScene(app, { scene, store: scene.store, streamToken: process.env.OPENCLAW_STREAM_TOKEN, requireCsrfOrToken: (_req, res) => res.status(403).end(), control });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const tokenFile = path.join(directory, "token"); await writeFile(tokenFile, process.env.OPENCLAW_STREAM_TOKEN, { mode: 0o600 });
  let factory;
  register({ pluginConfig: { endpoint, tokenFile }, logger: { warn() {} }, on() {}, registerTool: handler => { factory = handler; } });
  const run = async (context, params) => JSON.parse((await factory(context).execute("call", params)).content[0].text);
  const close = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); };
  return { directory, endpoint, broadcast, control, scene, factory, run, audit, close };
}

const owner = { agentId: "main", senderIsOwner: true, sessionKey: "agent:main:telegram:direct:owner" };
const hostKey = (recordingId, admin) => `agent:dashboard-host:openai-user:dashboard-${admin ? "admin-" : ""}${recordingId}`;

test("tool actions are offered per caller: owner channels, administrator host sessions, viewer host sessions", async () => {
  const f = await fixture();
  try {
    const id = "0f0e0d0c-0b0a-4908-8706-050403020100";
    const actions = context => f.factory(context)?.parameters.properties.action.enum;
    assert.ok(actions(owner).includes("start") && actions(owner).includes("chat_delete"));
    assert.equal(f.factory({ ...owner, senderIsOwner: false }), null, "non-owner channel");
    assert.equal(f.factory({ ...owner, sessionKey: "agent:main:openai-user:someone" }), null, "gateway HTTP sessions always claim senderIsOwner");
    assert.equal(f.factory({ ...owner, sessionKey: "agent:main:openai:1234" }), null);
    assert.deepEqual(actions({ agentId: "dashboard-host", sessionKey: hostKey(id, false) }), ["avatar"]);
    assert.ok(!actions({ agentId: "dashboard-host", sessionKey: hostKey(id, true) }).includes("start"));
    assert.ok(actions({ agentId: "dashboard-host", sessionKey: hostKey(id, true) }).includes("title"));
    assert.equal(f.factory({ agentId: "dashboard-host", sessionKey: "agent:dashboard-host:openai-user:anything" }), null);
    assert.equal(f.factory({ agentId: "relay", senderIsOwner: true, sessionKey: "agent:relay:x" }), null);
  } finally { await f.close(); }
});

test("the owner agent runs its own stream: title, description, chat moderation, widgets, hide, avatar", async () => {
  const f = await fixture();
  try {
    const started = await f.run(owner, { action: "start", title: "Control test" });
    const recordingId = started.stream.id;
    const chat = f.broadcast.publish({ kind: "chat", source: "viewer", msg: "SPAM TEXT to remove", author: "Tester" });
    const kept = f.broadcast.publish({ kind: "chat", source: "viewer", msg: "keep me", author: "Other" });
    assert.equal((await f.run(owner, { action: "title", title: "Renamed live" })).stream.title, "Renamed live");
    assert.equal(f.broadcast.get(recordingId).title, "Renamed live");
    assert.equal((await f.run(owner, { action: "summary", summary: "Line one\nLine two" })).stream.summary, "Line one\nLine two");
    const recent = await f.run(owner, { action: "chat_recent", limit: 5 });
    assert.deepEqual(recent.messages.map(message => message.id), [chat.id, kept.id]);
    const removed = await f.run(owner, { action: "chat_delete", messageId: chat.id });
    assert.equal(removed.removed, chat.id);
    const raw = await readFile(path.join(f.directory, "recordings", `${recordingId}.ndjson`), "utf8");
    assert.ok(!raw.includes("SPAM TEXT") && raw.includes("keep me"), "removed text is gone from storage; other chat stays");
    const events = f.broadcast.readEvents(recordingId);
    assert.deepEqual(events.find(event => event.id === chat.id), { id: chat.id, recordingId, ts: chat.ts, t: chat.t, kind: "chat", source: "viewer", level: "info", msg: "", deleted: true });
    const moderation = events.find(event => event.moderation);
    assert.deepEqual(moderation.moderation, { op: "chat_delete", target: chat.id, actor: "openclaw", agentId: "main", via: "owner-session" });
    assert.equal(moderation.kind, "log");
    await assert.rejects(f.run(owner, { action: "chat_delete", messageId: chat.id }), /already removed/);
    await assert.rejects(f.run(owner, { action: "chat_delete", messageId: 0 }), /not a viewer chat message/);
    assert.deepEqual((await f.run(owner, { action: "chat_recent" })).messages.map(message => message.id), [kept.id]);

    const created = await f.run(owner, { action: "widget_create", widget: { type: "text", x: 0.1, y: 0.1, w: 0.3, h: 0.1, props: { text: "Hi" } } });
    const widgetId = created.widget.id;
    assert.deepEqual((await f.run(owner, { action: "widget_update", widgetId, x: 0.5, y: 0.2, w: 0.4 })).widget, { ...created.widget, x: 0.5, y: 0.2, w: 0.4 });
    assert.equal((await f.run(owner, { action: "widget_hide", widgetId })).widget.hidden, true);
    assert.equal(f.scene.liveState().state.widgets[widgetId].hidden, true);
    assert.equal((await f.run(owner, { action: "widget_show", widgetId })).widget.hidden, undefined);
    const avatar = await f.run(owner, { action: "avatar", expression: "think", seconds: 30 });
    assert.deepEqual(avatar.avatar, { expression: "think", seconds: 30 });
    const scene = await f.run(owner, { action: "scene" });
    assert.ok(scene.widgets.some(widget => widget.id === widgetId));
    assert.deepEqual((await f.run(owner, { action: "widget_delete", widgetId })).id, widgetId);
    const all = f.broadcast.readEvents(recordingId);
    for (const fragment of ["Stream title updated", "Scene text widget hidden", "Scene text widget shown", "Avatar expression set: dashboard/scene avatar — by OpenClaw, think for 30 s.", "Chat message removed: dashboard/live chat moderation — OpenClaw removed message #"]) assert.ok(all.some(event => event.msg.startsWith(fragment)), fragment);
    assert.ok(f.audit.some(event => /chat delete by main via owner-session, message #/.test(event.msg)), "operator audit line");
    // Replay folds the forced expression with its timeout.
    const state = fold(all);
    const at = all.find(event => event.op === "avatar").t;
    assert.equal(avatarExpression(state, at + 1), "think");
    assert.notEqual(avatarExpression(state, at + 31), "think");
    await assert.rejects(f.run(owner, { action: "title", title: "bad‮title" }), /control characters/);
  } finally { await f.close(); }
});

test("public host turns: no grant is refused, viewer grants allow only the avatar, administrator grants allow live control", async () => {
  const f = await fixture();
  try {
    const live = f.broadcast.start("Admin stream");
    const viewer = { agentId: "dashboard-host", sessionKey: hostKey(live.id, false) };
    const admin = { agentId: "dashboard-host", sessionKey: hostKey(live.id, true) };
    await assert.rejects(f.run(admin, { action: "title", title: "Injected" }), /administrator-started chat turn/);
    await assert.rejects(f.run(viewer, { action: "avatar", expression: "talk" }), /administrator-started chat turn/);
    const closeViewer = f.control.grant(sessionRef(viewer.sessionKey), live.id, "viewer");
    assert.equal((await f.run(viewer, { action: "avatar", expression: "talk", seconds: 3 })).recorded, true);
    await assert.rejects(f.run(viewer, { action: "avatar", expression: "idle" }), /once every 5 seconds/, "viewer avatar rate limit");
    // A viewer grant never covers the administrator session, and vice versa.
    await assert.rejects(f.run(admin, { action: "title", title: "Injected" }), /administrator-started chat turn/);
    closeViewer();
    await assert.rejects(f.run(viewer, { action: "avatar", expression: "talk" }), /administrator-started chat turn/, "grant closed with the turn");
    const closeAdmin = f.control.grant(sessionRef(admin.sessionKey), live.id, "admin");
    assert.equal((await f.run(admin, { action: "title", title: "Admin asked" })).stream.title, "Admin asked");
    assert.equal(f.broadcast.readEvents(live.id).at(-1).msg, "Stream title updated: dashboard/stream title — OpenClaw (administrator request) renamed the live stream.");
    const chat = f.broadcast.publish({ kind: "chat", source: "viewer", msg: "remove", author: "Tester" });
    assert.equal((await f.run(admin, { action: "chat_delete", messageId: chat.id })).removed, chat.id);
    assert.equal(f.broadcast.readEvents(live.id).at(-1).moderation.via, "admin-turn");
    closeAdmin();
    // A grant is bound to its recording.
    f.broadcast.stop();
    const next = f.broadcast.start("Next");
    f.control.grant(sessionRef(admin.sessionKey), live.id, "admin");
    await assert.rejects(f.run({ ...admin, sessionKey: hostKey(next.id, true) }, { action: "title", title: "x" }), /administrator-started chat turn/);
    // The raw API: no bearer is 401; unknown agents are 403; malformed IDs are 400.
    const post = (url, body, token = process.env.OPENCLAW_STREAM_TOKEN) => fetch(f.endpoint + url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const ref = sessionRef(admin.sessionKey);
    assert.equal((await post("/api/openclaw/stream/title", { recordingId: next.id, sessionRef: ref, agentId: "dashboard-host", title: "x" }, "wrong")).status, 401);
    assert.equal((await post("/api/openclaw/stream/title", { recordingId: next.id, sessionRef: ref, agentId: "relay", title: "x" })).status, 403);
    assert.equal((await post("/api/openclaw/chat/delete", { recordingId: "nope", sessionRef: ref, agentId: "main", messageId: 1 })).status, 400);
    assert.equal((await post("/api/openclaw/chat/recent", { recordingId: next.id, sessionRef: ref, agentId: "dashboard-host" })).status, 403);
  } finally { await f.close(); }
});

test("the owner agent may act on administrator-started streams but not on another OpenClaw session's stream", async () => {
  const f = await fixture();
  try {
    await f.run(owner, { action: "start", title: "Owned" });
    const other = { ...owner, sessionKey: "agent:main:weixin:direct:owner" };
    await assert.rejects(f.run(other, { action: "title", title: "x" }), /another OpenClaw session owns/);
    await assert.rejects(f.run(other, { action: "avatar", expression: "idle" }), /another OpenClaw session owns/);
    await f.run(owner, { action: "end" });
    f.broadcast.start("Admin started");
    assert.equal((await f.run(other, { action: "title", title: "Fine" })).stream.title, "Fine");
    assert.equal((await f.run(other, { action: "widget_create", widget: { type: "clock", x: 0.1, y: 0.1, w: 0.2, h: 0.1 } })).recorded, true);
    // Title changes are rate limited for every caller (3, then one per 10 s).
    await f.run(other, { action: "title", title: "Two" });
    await f.run(other, { action: "title", title: "Three" });
    await assert.rejects(f.run(other, { action: "title", title: "Four" }), /at most 3 times/);
  } finally { await f.close(); }
});

test("schema: hidden is an optional boolean that merges; avatar states are closed and bounded", () => {
  const base = { id: "t1", type: "text", x: 0.1, y: 0.1, w: 0.2, h: 0.1, z: 100, props: { text: "Hi" } };
  assert.equal(validateWidget(base).hidden, undefined);
  assert.equal(validateWidget({ ...base, hidden: true }).hidden, true);
  assert.throws(() => validateWidget({ ...base, hidden: "yes" }), /hidden/);
  assert.equal(mergeWidget(validateWidget({ ...base, hidden: true }), { hidden: false }).hidden, undefined);
  assert.equal(mergeWidget(validateWidget(base), { x: 0.2 }).hidden, undefined);
  assert.deepEqual(validateAvatarState({ expression: "sleepy" }), { expression: "sleepy", seconds: 10 });
  assert.deepEqual(validateAvatarState({ expression: "auto", seconds: 5 }), { expression: "auto" });
  assert.throws(() => validateAvatarState({ expression: "angry" }), /expression/);
  assert.throws(() => validateAvatarState({ expression: "talk", seconds: 121 }), /seconds/);
  assert.throws(() => validateAvatarState({ expression: "talk", extra: 1 }), /unknown avatar field/);
  const events = [
    { kind: "widget", sv: 1, op: "avatar", target: "avatar", data: { expression: "sleepy", seconds: 5 }, t: 10 },
    { kind: "widget", sv: 1, op: "avatar", target: "avatar", data: { expression: "auto" }, t: 12 },
  ];
  assert.equal(avatarExpression(fold(events, 11), 11), "sleepy");
  assert.equal(fold(events).avatar, null, "auto clears the override");
});

test("usage line: pooled Codex windows, today's tokens with the paid fallback, cached and rate limited", async () => {
  const now = Date.UTC(2026, 10, 5, 12, 0, 0);
  const pooled = { updatedAt: now - 60000, fiveHour: { remainingPercent: 62, resetAt: now + (2 * 60 + 14) * 60000, accounts: 3, total: 3 }, week: { remainingPercent: 81, resetAt: now + ((3 * 24 + 4) * 60 + 10) * 60000, accounts: 3, total: 3 } };
  const routes = [{ route: "cpa", tokens: 1390000, costUsd: null, unpriced: 11 }, { route: "openai", tokens: 36800, costUsd: 0.42, unpriced: 0 }];
  assert.equal(usageText({ pooled, routes, now }), "Usage after reply: dashboard/usage — Codex pool 5h 62% left, resets in 2h 14m; weekly 81% left, resets in 3d 4h 10m · today 1.43M tokens, est. $0.42 known, 11 unpriced attempts; paid fallback 36.8K tokens, est. $0.42.");
  assert.match(usageText({ pooled: null, routes: [], now }), /Codex pool unavailable · today 0 tokens, est. cost unpriced; paid fallback 0 tokens\.$/);
  assert.match(usageText({ pooled: { ...pooled, updatedAt: now - 3 * REFRESH_MS }, routes, now }), /\(quota as of 15m ago\)/);

  const directory = await mkdtemp(path.join(os.tmpdir(), "usage-line-"));
  try {
    const broadcast = new BroadcastStore(directory);
    const live = broadcast.start("Usage");
    let clock = now, refreshes = 0;
    const snapshot = { updatedAt: now - 10 * 60000, accounts: [{ provider: "codex", label: "codex account 1", windows: [{ remainingPercent: 50, resetsAt: now + 3600000, windowSeconds: 18000 }, { remainingPercent: 70, resetsAt: now + 86400000, windowSeconds: 604800 }] }] };
    const quota = { snapshot: () => snapshot, refresh: async () => { refreshes++; snapshot.updatedAt = clock; return snapshot; } };
    const line = new UsageLine({ broadcast, metrics: { routeTotals: () => routes }, quota, secrets: { read: () => ({ endpoint: "x", key: "y" }) }, isEnabled: async () => true, now: () => clock });
    const first = await line.after(live.id);
    assert.equal(refreshes, 1, "a snapshot older than 5 minutes is refreshed once");
    assert.match(first.msg, /^Usage after reply: dashboard\/usage — Codex pool 5h 50% left, resets in 1h 0m; weekly 70% left/);
    assert.ok(!JSON.stringify(first).includes("account 1"), "no account labels");
    assert.equal(first.kind, "log");
    assert.equal(await line.after(live.id), null, "one line per reply gap");
    clock += MIN_GAP_MS;
    await line.after(live.id);
    assert.equal(refreshes, 1, "no upstream refresh within 5 minutes");
    clock += REFRESH_MS;
    await line.after(live.id);
    assert.equal(refreshes, 2);
    assert.equal(await line.after("00000000-0000-4000-8000-000000000000"), null, "only the live recording");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("host chat turns hold a grant bound to their session key for the duration of the gateway call", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chat-grant-"));
  const seen = [];
  let control;
  const gateway = express(); gateway.use(express.json());
  gateway.post("/v1/chat/completions", (req, res) => {
    const key = req.get("x-openclaw-session-key");
    seen.push({ key, user: req.body.user, system: req.body.messages[0].content, grant: control.activeGrant(sessionRef(key), broadcast.active.id)?.role });
    res.json({ id: "chatcmpl-1", choices: [{ message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }] });
  });
  const server = gateway.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  process.env.OPENCLAW_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
  const broadcast = new BroadcastStore(directory);
  try {
    const { config } = await import("./config.js");
    config.openclaw.endpoint = process.env.OPENCLAW_ENDPOINT;
    const { createChat, hostSessionKey } = await import("./chat.js");
    control = new StreamControl({ broadcast });
    const lines = [];
    const send = createChat(broadcast, { control, usageLine: { after: async id => lines.push(id) } });
    const live = broadcast.start("Chat");
    const reply = () => ({ status() { return this; }, json() { return this; } });
    for (const isAdmin of [false, true]) {
      send({ body: { message: "hi" }, session: { user: { sub: isAdmin ? "admin" : "viewer", name: "N", isAdmin } } }, reply());
      for (let i = 0; i < 100 && seen.length < (isAdmin ? 2 : 1); i++) await new Promise(resolve => setTimeout(resolve, 10));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.deepEqual(seen.map(item => [item.key, item.user, item.grant]), [
      [hostSessionKey(live.id, false), `dashboard-${live.id}`, "viewer"],
      [hostSessionKey(live.id, true), `dashboard-admin-${live.id}`, "admin"],
    ]);
    assert.equal(hostSessionKey(live.id, true), `agent:dashboard-host:openai-user:dashboard-admin-${live.id}`);
    assert.match(seen[0].system, /only tool use allowed in a viewer turn is dashboard_stream with action avatar/);
    assert.match(seen[1].system, /signed-in dashboard administrator/);
    assert.equal(control.grants.size, 0, "grants close when the turn ends");
    assert.deepEqual(lines, [live.id, live.id], "one usage line per final reply");
    assert.ok(RECORDING.test(live.id));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
});
