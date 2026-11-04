import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// NDJSON preserves the event envelope; append and fsync before announcing it.
// A process restart closes an interrupted recording rather than losing it.
export class BroadcastStore {
  constructor(directory) {
    this.directory = directory;
    this.listeners = new Set();
    this.active = null;
    fs.mkdirSync(directory, { recursive: true });
    for (const name of fs.readdirSync(directory).filter(name => name.endsWith(".json"))) {
      const recording = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
      if (recording.status === "live") {
        let count = 0;
        let last;
        for (const event of this.scanEvents(recording.id)) { count++; last = event; }
        Object.assign(recording, { status: "interrupted", endedAt: last?.ts || recording.startedAt, eventCount: count });
        recording.duration = (recording.endedAt - recording.startedAt) / 1000;
        this.save(recording);
      }
    }
  }

  filename(id, extension) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Object.assign(new Error("Recording unavailable: dashboard/recording lookup — recording ID is invalid."), { status: 404 });
    return path.join(this.directory, `${id}.${extension}`);
  }

  save(recording) {
    const destination = this.filename(recording.id, "json");
    const temporary = `${destination}.tmp`;
    const descriptor = fs.openSync(temporary, "w");
    try { fs.writeFileSync(descriptor, JSON.stringify(recording)); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, destination);
  }

  get(id) {
    try { return JSON.parse(fs.readFileSync(this.filename(id, "json"), "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") throw Object.assign(new Error("Recording unavailable: dashboard/recording lookup — recording does not exist."), { status: 404 });
      throw error;
    }
  }

  list(admin = false) {
    return fs.readdirSync(this.directory).filter(name => name.endsWith(".json"))
      .map(name => this.get(name.slice(0, -5)))
      .filter(recording => admin || (!recording.hidden && recording.status !== "live"))
      .sort((a, b) => b.score - a.score || b.startedAt - a.startedAt);
  }

  status() {
    return this.active ? { ...this.active, duration: (Date.now() - this.active.startedAt) / 1000 } : null;
  }

  notify(type, data) {
    for (const listener of this.listeners) {
      try { listener(type, data); } catch { this.listeners.delete(listener); }
    }
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(title) {
    if (this.active) throw Object.assign(new Error("Stream cannot start: dashboard/broadcast start — another stream is already live."), { status: 409 });
    const recording = { id: randomUUID(), title, startedAt: Date.now(), endedAt: null, duration: 0, eventCount: 0, status: "live", hidden: false, score: 0, schemaVersion: 1 };
    fs.closeSync(fs.openSync(this.filename(recording.id, "ndjson"), "wx"));
    this.save(recording);
    this.active = recording;
    this.notify("status", this.status());
    this.publish({ source: "stream", msg: "Stream is live: dashboard/broadcast — administrator started the stream." });
    return this.status();
  }

  publish({ kind = "log", source = "stream", level = "info", msg, ...payload }, expectedId = this.active?.id) {
    if (!this.active || this.active.id !== expectedId) return null;
    const ts = Date.now();
    const event = { ...payload, id: this.active.eventCount, recordingId: this.active.id, ts, t: (ts - this.active.startedAt) / 1000, kind, source, level, msg: String(msg) };
    const descriptor = fs.openSync(this.filename(this.active.id, "ndjson"), "a");
    try { fs.writeSync(descriptor, JSON.stringify(event) + "\n"); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    this.active.eventCount++;
    this.save(this.active);
    this.notify("event", event);
    return event;
  }

  stop() {
    if (!this.active) throw Object.assign(new Error("Stream cannot end: dashboard/broadcast end — no stream is live."), { status: 409 });
    this.publish({ source: "stream", msg: "Stream has ended: dashboard/broadcast — administrator ended the stream; recording saved." });
    const recording = { ...this.active, status: "ended", endedAt: Date.now() };
    recording.duration = (recording.endedAt - recording.startedAt) / 1000;
    this.save(recording);
    this.active = null;
    this.notify("status", null);
    return recording;
  }

  update(id, changes) {
    const recording = this.get(id);
    if (recording.status === "live") throw Object.assign(new Error("Recording cannot be edited: dashboard/recording moderation — end the stream before changing visibility or score."), { status: 409 });
    Object.assign(recording, changes);
    this.save(recording);
    this.notify("catalog", { id });
    return recording;
  }

  *scanEvents(id) {
    const descriptor = fs.openSync(this.filename(id, "ndjson"), "r");
    const buffer = Buffer.alloc(64 * 1024);
    let pending = Buffer.alloc(0);
    try {
      let count;
      while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null))) {
        pending = Buffer.concat([pending, buffer.subarray(0, count)]);
        let newline;
        while ((newline = pending.indexOf(10)) !== -1) {
          const line = pending.subarray(0, newline).toString("utf8");
          pending = pending.subarray(newline + 1);
          if (line) yield JSON.parse(line);
        }
      }
    } finally { fs.closeSync(descriptor); }
  }

  readEvents(id, offset = 0, limit = 1000) {
    const result = [];
    let index = 0;
    for (const event of this.scanEvents(id)) {
      if (index++ < offset) continue;
      result.push(event);
      if (result.length >= limit) break;
    }
    return result;
  }
}
