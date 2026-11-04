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
