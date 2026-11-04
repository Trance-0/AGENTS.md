import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BroadcastStore } from "./broadcast.js";
import { previewAt } from "../public/player.js";

test("recordings preserve chat, ordering, visibility, and interrupted stream recovery", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "broadcast-test-"));
  try {
    let store = new BroadcastStore(directory);
    const first = store.start("First stream");
    store.publish({ kind: "chat", source: "viewer", author: "Viewer", msg: "Hello" });
    store.publish({ source: "openclaw", msg: "Welcome" });
    store.stop();
    const saved = store.readEvents(first.id);
    assert.deepEqual(saved.map(event => event.id), [0, 1, 2, 3]);
    assert.equal(saved[1].kind, "chat");
    assert.equal(saved[2].msg, "Welcome");
    assert.ok(saved.every(event => event.ts >= first.startedAt && event.t >= 0));
    assert.equal(store.publish({ msg: "late reply" }, first.id), null);
    const second = store.start("Second stream");
    assert.equal(store.publish({ msg: "wrong stream" }, first.id), null);
    store.publish({ msg: "Unicode event: 你好 " + "x".repeat(70000) });
    appendFileSync(path.join(directory, `${second.id}.ndjson`), '{"partial');
    store = new BroadcastStore(directory);
    assert.equal(store.active, null);
    assert.equal(store.get(second.id).status, "interrupted");
    assert.equal(store.get(second.id).eventCount, 2);
    assert.match(store.readEvents(second.id, 1, 1)[0].msg, /你好/);
    assert.deepEqual(store.readEvents(second.id, 2, 1), []);
    store.update(first.id, { hidden: true, score: 90 });
    assert.equal(store.list().length, 1);
    assert.equal(store.list(true)[0].id, first.id);
    store.update(first.id, { hidden: false, score: 90 });
    assert.equal(new BroadcastStore(directory).list()[0].id, first.id);
    assert.throws(() => store.get("../../etc/passwd"), /recording ID is invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("hover previews reconstruct sparse log frames and exclude side chat", () => {
  const events = [
    { t: 0, msg: "started", kind: "log" },
    { t: 20, msg: "viewer message", kind: "chat" },
    { t: 30, msg: "host reply", kind: "log" },
    { t: 90, msg: "later reply", kind: "log" },
  ];
  assert.deepEqual(previewAt(events, 18).map(event => event.msg), ["started"]);
  assert.deepEqual(previewAt(events, 75).map(event => event.msg), ["started", "host reply"]);
  assert.deepEqual(previewAt(events, -1), []);
});
