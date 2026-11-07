import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { SecretStore } from "./metrics/secrets.js";
import { MetricsStore } from "./metrics/store.js";
import { ingestUsage } from "./metrics/reader.js";
import { usageRecord, writeUsage } from "../openclaw-plugin/usage-log.js";
import { fetchQuota, quotaWindow, validateEndpoint } from "./metrics/cpa.js";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-metrics-"));
  const keyFile = path.join(directory, "key"); fs.writeFileSync(keyFile, randomBytes(32), { mode: 0o400 });
  const logs = path.join(directory, "logs"); fs.mkdirSync(logs);
  return { directory, keyFile, logs, close: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
const sample = (overrides = {}) => ({ runId: "run-1", provider: "cpa", model: "claude-test", usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 }, lastAssistant: { timestamp: Date.now(), usage: { input: 1, output: 1 }, stopReason: "stop" }, ...overrides });

test("management credentials are encrypted, authenticated, restart-safe, and never returned", () => {
  const f = fixture();
  try {
    let secrets = new SecretStore(f.directory, f.keyFile);
    secrets.save({ endpoint: "https://quota.example", key: "management-super-secret" });
    const serialized = fs.readFileSync(secrets.file, "utf8");
    assert.ok(!serialized.includes("management-super-secret"));
    assert.equal(fs.statSync(secrets.file).mode & 0o777, 0o600);
    secrets = new SecretStore(f.directory, f.keyFile);
    assert.equal(secrets.read().key, "management-super-secret");
    assert.ok(!JSON.stringify(secrets.view()).includes("management-super-secret"));
    const corrupted = JSON.parse(serialized); corrupted.data = Buffer.from("tampered").toString("base64");
    fs.writeFileSync(secrets.file, JSON.stringify(corrupted));
    assert.throws(() => secrets.read(), /could not be authenticated/);
    secrets.remove(); assert.equal(secrets.view().configured, false);
    const missing = new SecretStore(f.directory, path.join(f.directory, "missing"));
    assert.equal(missing.view().encryptionReady, false);
    assert.throws(() => missing.save({ key: "secret" }), /not available/);
  } finally { f.close(); }
});

test("usage exporter captures attempt totals and routes without conversation or credentials", () => {
  const event = sample({ prompt: "PRIVATE", assistantTexts: ["PRIVATE"], sessionId: "PRIVATE" });
  const config = { models: { providers: { cpa: { apiKey: "PRIVATE", models: [{ id: "claude-test", cost: { input: 3, output: 15, cacheRead: .3, cacheWrite: 3.75 } }] } } } };
  const record = usageRecord(event, { agentId: "main", sessionKey: "PRIVATE" }, config);
  assert.equal(record.total, 1800);
  assert.equal(record.input, 1000, "uses all tool-continuation calls, not lastAssistant usage");
  assert.ok(Math.abs(record.costUsd - .010935) < 1e-10);
  assert.ok(!JSON.stringify(record).includes("PRIVATE"));
  assert.equal(usageRecord(event, { agentId: "main" }, config).id, record.id);
  assert.equal(usageRecord(sample({ usage: undefined }), {}), null);
});

test("SQLite import is replay-safe across restart, partial lines, rotation and changed pricing", () => {
  const f = fixture(); let store = new MetricsStore(path.join(f.directory, "data"));
  try {
    const event = sample();
    writeUsage(f.logs, event, { agentId: "main" });
    writeUsage(f.logs, event, { agentId: "main" });
    assert.equal(ingestUsage(f.logs, store), 1);
    assert.equal(ingestUsage(f.logs, store), 0);
    let report = store.report(); assert.equal(report.summary.tokens, 1800); assert.equal(report.summary.costUsd, null); assert.equal(report.summary.unpriced, 1);
    store.savePrice({ route: "cpa", model: "claude-test", input: 3, output: 15, cacheRead: .3, cacheWrite: 3.75 });
    report = store.report(); assert.equal(report.summary.costUsd, .010935); assert.equal(report.summary.unpriced, 0);
    const row = usageRecord(sample({ runId: "two", provider: "openai", model: "gpt-test" }), { agentId: "relay" });
    const file = path.join(f.logs, fs.readdirSync(f.logs)[0]); const bytes = JSON.stringify(row) + "\n";
    fs.appendFileSync(file, bytes.slice(0, 10)); assert.equal(ingestUsage(f.logs, store), 0);
    store.close(); store = new MetricsStore(path.join(f.directory, "data"));
    fs.appendFileSync(file, bytes.slice(10)); assert.equal(ingestUsage(f.logs, store), 1);
    assert.equal(store.report().summary.tokens, 3600); assert.equal(store.report().summary.unpriced, 1);
    assert.equal(store.report({ route: "openai" }).summary.tokens, 1800);
    assert.equal(store.report({ model: "gpt-test" }).routes.length, 1);
    assert.equal(store.report().models.length, 2);
    fs.writeFileSync(file, bytes); assert.equal(ingestUsage(f.logs, store), 0, "truncated/replayed event cannot double count");
    fs.renameSync(file, file + ".old"); fs.writeFileSync(file, bytes); assert.equal(ingestUsage(f.logs, store), 0);
    assert.throws(() => store.savePrice({ route: "cpa", model: "test", input: -1 }), /prices/);
    assert.throws(() => store.report({ days: "NaN" }), /supported time range/);
    assert.throws(() => store.report({ route: "' OR 1=1" }), /valid route/);
    assert.equal(store.ingest({ ...row, id: "c".repeat(64), input: Infinity }), false);
    store.transaction(() => { assert.equal(store.ingest({ ...row, id: "d".repeat(64) }), true); });
    assert.throws(() => store.transaction(() => { store.ingest({ ...row, id: "e".repeat(64) }); throw new Error("abort"); }), /abort/);
    assert.equal(store.report().summary.attempts, 3);
  } finally { store.close(); f.close(); }
});

test("CPA quota uses management auth, separates accounts, preserves unknowns and upstream errors", async () => {
  assert.equal(validateEndpoint("https://quota.example/management.html"), "https://quota.example");
  assert.throws(() => validateEndpoint("http://quota.example"), /HTTPS/);
  assert.throws(() => validateEndpoint("https://key@quota.example"), /credentials/);
  assert.equal(quotaWindow({ utilization: 25 }, "claude").remainingPercent, 75);
  assert.equal(quotaWindow({}, "claude").remainingPercent, null);
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.headers.authorization, "Bearer secret-key");
    assert.equal(options.redirect, "error");
    if (url.endsWith("/auth-files")) return Response.json({ files: [{ name: "private-email@example.test", provider: "claude", auth_index: "a" }, { name: "codex", provider: "codex", auth_index: "b" }, { name: "disabled", provider: "claude", auth_index: "d", disabled: true }] });
    const body = JSON.parse(options.body); assert.equal(body.header.Authorization, "Bearer $TOKEN$");
    return body.authIndex === "a" ? Response.json({ status_code: 200, body: JSON.stringify({ five_hour: { utilization: 30, resets_at: "2026-12-01T00:00:00Z" }, seven_day: {} }) }) : Response.json({ status_code: 429, body: "PRIVATE UPSTREAM TOKEN" });
  };
  const result = await fetchQuota({ endpoint: "https://quota.example", key: "secret-key" }, fetcher);
  assert.equal(result.accounts.length, 2); assert.equal(calls.length, 3);
  const claude = result.accounts.find(a => a.provider === "claude"); assert.equal(claude.windows[0].remainingPercent, 70); assert.equal(claude.windows[1].remainingPercent, null);
  assert.match(result.accounts.find(a => a.provider === "codex").error, /HTTP 429/);
  for (const secret of ["secret-key", "PRIVATE UPSTREAM TOKEN", "private-email"]) assert.ok(!JSON.stringify(result).includes(secret));
  await assert.rejects(fetchQuota({ endpoint: "https://quota.example", key: "secret-key" }, async () => new Response("secret-key", { status: 403 })), error => !error.message.includes("secret-key") && /HTTP 403/.test(error.message));
});

test("an OpenClaw output hook exports usage even without an active broadcast", async () => {
  const f = fixture();
  try {
    const { default: register } = await import("../openclaw-plugin/index.js");
    const tokenFile = path.join(f.directory, "token"); fs.writeFileSync(tokenFile, "fixture-stream-token");
    const hooks = new Map();
    register({ pluginConfig: { endpoint: "http://127.0.0.1:1", tokenFile, activityDir: f.logs }, config: {}, logger: { warn() {} }, on: (name, handler) => hooks.set(name, handler), registerTool() {} });
    // No session context means the public stream handler exits immediately;
    // metering must still consume the provider's usage independently.
    await hooks.get("llm_output")(sample(), { agentId: "main" });
    const store = new MetricsStore(path.join(f.directory, "data"));
    try { assert.equal(ingestUsage(f.logs, store), 1); assert.equal(store.report().summary.tokens, 1800); }
    finally { store.close(); }
  } finally { f.close(); }
});
