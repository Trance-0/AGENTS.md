import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ActivityReader, activityEvent } from "./openclaw-activity.js";
import { writeActivity } from "../openclaw-plugin/activity-log.js";

test("shared activity logs expose file progress without tool contents or credentials", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "activity-"));
  try {
    const context = { agentId: "main", sessionKey: "private-session" };
    writeActivity(directory, "tool_start", { toolName: "read", params: { path: "/workspace/README.md", content: "PRIVATE" } }, context);
    writeActivity(directory, "tool_end", { toolName: "read", params: { file_path: "/workspace/README.md" }, result: "SECRET CONTENT", durationMs: 12 }, context);
    writeActivity(directory, "tool_start", { toolName: "read", params: { path: "/private/.env.production" } }, context);
    writeActivity(directory, "tool_start", { toolName: "exec", params: { command: "cat SECRET" } }, context);
    const serialized = fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), "utf8");
    for (const privateText of ["PRIVATE", "SECRET", "private-session", ".env.production"]) assert.ok(!serialized.includes(privateText));
    const records = serialized.trim().split("\n").map(JSON.parse);
    assert.match(activityEvent(records[0]).msg, /started.*read \/workspace\/README.md/);
    assert.match(activityEvent(records[1]).msg, /completed.*read \/workspace\/README.md/);
    assert.equal(activityEvent(records[1]).durationMs, 12);
    assert.equal(records[2].path, "[sensitive file]");
    assert.equal(activityEvent({ ...records[0], success: false }).level, "warn");
    assert.equal(activityEvent({ ...records[0], type: "unknown" }), null);
    assert.equal(activityEvent({ ...records[0], timestamp: "bad" }), null);
    writeActivity(directory, "tool_end", { toolName: "read", result: { isError: true, content: "PRIVATE FAILURE" } }, context);
    const failed = fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), "utf8").trim().split("\n").map(JSON.parse).at(-1);
    assert.equal(failed.success, false);
    assert.ok(!JSON.stringify(failed).includes("PRIVATE FAILURE"));
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test("reader resumes cursors, handles partial UTF-8 lines, rotation and truncation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "activity-reader-"));
  const logs = path.join(directory, "logs"); fs.mkdirSync(logs);
  const cursorFile = path.join(directory, "state", "cursor.json");
  const events = [];
  const makeReader = () => new ActivityReader({ directory: logs, cursorFile, publish: event => events.push(event) });
  const record = (id, filename = "/workspace/日记.md") => JSON.stringify({ type: "tool_start", eventId: id, timestamp: new Date().toISOString(), agentId: "main", toolName: "read", path: filename }) + "\n";
  const first = path.join(logs, "activity-2026-11-04.jsonl");
  try {
    fs.writeFileSync(first, record("historical"));
    let reader = makeReader(); reader.poll();
    assert.equal(events.length, 0, "first attachment must not broadcast old private activity");
    const bytes = Buffer.from(record("one"));
    const split = bytes.indexOf(Buffer.from("日")) + 1;
    fs.appendFileSync(first, bytes.subarray(0, split)); reader.poll();
    assert.equal(events.length, 0);
    reader = makeReader();
    fs.appendFileSync(first, bytes.subarray(split)); reader.poll();
    assert.equal(events.length, 1); assert.equal(events[0].filePath, "/workspace/日记.md");
    reader = makeReader(); reader.poll(); assert.equal(events.length, 1);
    const second = path.join(logs, "activity-2026-11-05.jsonl");
    fs.writeFileSync(second, "broken json\n" + record("two")); reader.poll();
    assert.equal(events.length, 2);
    fs.writeFileSync(first, record("three", "/a")); reader.poll();
    assert.equal(events.length, 3);
    fs.renameSync(second, second + ".old"); fs.writeFileSync(second, record("four")); reader.poll();
    assert.equal(events.length, 4);
    fs.symlinkSync(first, path.join(logs, "activity-2026-11-06.jsonl")); reader.poll();
    assert.equal(events.length, 4);
    assert.deepEqual(events.map(event => event.eventRef), ["one", "two", "three", "four"]);
  } finally { fs.rmSync(directory, { recursive: true }); }
});


test("model activity identifies the actual provider, model, and gateway run", () => {
  const record = { type: "model_output", eventId: "event-1", timestamp: new Date().toISOString(), agentId: "dashboard-host", model: "gpt-6-astra", provider: "cpa", runId: "chatcmpl_verified", success: true };
  const event = activityEvent(record);
  assert.match(event.msg, /cpa\/gpt-6-astra/);
  assert.equal(event.provider, "cpa");
  assert.equal(event.model, "gpt-6-astra");
  assert.equal(event.runId, "chatcmpl_verified");
});

test("relay agent activity is labelled as AstrBot receipt without message content", async () => {
  const { noteRelayActivity, relayStatus } = await import("./relay-status.js");
  const base = { eventId: "relay-1", timestamp: new Date().toISOString(), agentId: "relay", success: true };
  const started = activityEvent({ ...base, type: "agent_start" });
  assert.equal(started.source, "astrbot");
  assert.match(started.msg, /^AstrBot relay message received: astrbot\/openclaw relay/);
  noteRelayActivity(started);
  noteRelayActivity(activityEvent({ ...base, eventId: "relay-2", type: "model_output", provider: "cpa", model: "gpt-6-astra" }));
  noteRelayActivity(activityEvent({ ...base, eventId: "relay-3", type: "agent_end" }));
  const status = relayStatus();
  assert.equal(status.requests, 1);
  assert.equal(status.lastModel, "cpa/gpt-6-astra");
  assert.equal(status.lastFailed, false);
  assert.equal(activityEvent({ ...base, agentId: "main", type: "agent_start" }).source, "openclaw");
});


test("announcement run IDs survive and reply-generation metadata excludes content", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "activity-announcement-"));
  try {
    const runId = "announce:v1:agent:main:subagent:worker:completed-run";
    writeActivity(directory, "model_output", { runId, model: "gpt-6-astra", provider: "cpa", assistantTexts: ["Private answer"], lastAssistant: { stopReason: "stop" } }, { agentId: "main" });
    const record = JSON.parse(fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), "utf8").trim());
    assert.equal(record.runId, runId);
    assert.equal(record.replyChars, 14);
    const event = activityEvent(record);
    assert.equal(event.runId, runId);
    assert.match(event.msg, /reply generated/);
    assert.ok(!JSON.stringify(record).includes("Private answer"));
    assert.ok(!event.msg.includes("\ufffd"));
    assert.match(activityEvent({ ...record, success: false, replyChars: 0 }).msg, /reply not generated/);
  } finally { fs.rmSync(directory, { recursive: true }); }
});


test("stalled parent announcements produce one explicit pending warning", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "activity-pending-"));
  const events = [];
  let now = Date.now();
  try {
    const reader = new ActivityReader({ directory, cursorFile: path.join(directory, "cursor.json"), publish: event => events.push(event), now: () => now });
    reader.poll();
    const file = path.join(directory, "activity-2026-11-05.jsonl");
    const record = { type: "model_start", eventId: "pending-test", timestamp: new Date(now).toISOString(), agentId: "main", runId: "announce:v1:worker:run", model: "gpt-6-astra" };
    fs.writeFileSync(file, JSON.stringify(record) + "\n");
    reader.poll(); now += 90001; reader.poll(); reader.poll();
    fs.appendFileSync(file, JSON.stringify({ ...record, eventId: "retry-test" }) + "\n");
    reader.poll(); now += 90001; reader.poll();
    assert.equal(events.filter(event => event.openclawEvent === "announcement_pending").length, 1);
    fs.appendFileSync(file, JSON.stringify({ ...record, eventId: "finished-test", type: "model_output", replyChars: 12 }) + "\n");
    reader.poll();
    assert.equal(reader.pendingAnnouncements.size, 0);
  } finally { fs.rmSync(directory, { recursive: true }); }
});
