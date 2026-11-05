import fs from "node:fs";
import path from "node:path";

const types = new Set(["agent_start", "model_start", "model_output", "tool_start", "tool_end", "agent_end"]);
const safeRunId = value => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,256}$/.test(value);
const safeName = value => typeof value === "string" && /^[a-zA-Z0-9_.:/-]{1,120}$/.test(value);

export function activityEvent(record) {
  if (!types.has(record.type) || !safeName(record.agentId) || !safeName(record.eventId) || !Number.isFinite(Date.parse(record.timestamp))) return null;
  const tool = safeName(record.toolName) ? record.toolName : undefined;
  const filename = ["read", "write", "edit"].includes(tool) && typeof record.path === "string"
    ? record.path.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 512) : undefined;
  const failed = record.success === false;
  const action = record.type === "tool_start" ? "started" : record.type === "tool_end" ? "completed" : "recorded";
  const detail = tool ? `${tool}${filename ? ` ${filename}` : ""}` : safeName(record.model) ? `${safeName(record.provider) ? record.provider + "/" : ""}${record.model}` : record.agentId;
  const replyChars = Number.isSafeInteger(record.replyChars) && record.replyChars >= 0 ? record.replyChars : undefined;
  const replyDetail = record.type === "model_output" && replyChars !== undefined
    ? failed ? "; reply not generated" : replyChars > 0 ? `; reply generated (${replyChars} characters; text belongs to its conversation)` : "; no reply text generated"
    : "";
  // The `relay` agent only serves AstrBot (QQ/WeChat/Telegram adapters), so its
  // lifecycle doubles as AstrBot's "message received / answered" signal.
  const relay = record.agentId === "relay";
  const relayPhase = { agent_start: "message received", model_start: "model started", model_output: "reply generated", agent_end: "request completed" }[record.type] || action;
  return {
    source: relay ? "astrbot" : "openclaw", level: failed ? "warn" : "info", openclawEvent: record.type,
    eventRef: record.eventId, agentId: record.agentId,
    activityTimestamp: Date.parse(record.timestamp),
    ...(safeName(record.provider) ? { provider: record.provider } : {}),
    ...(safeName(record.model) ? { model: record.model } : {}),
    ...(safeRunId(record.runId) ? { runId: record.runId } : {}),
    ...(replyChars === undefined ? {} : { replyChars }),
    ...(filename ? { filePath: filename } : {}),
    ...(Number.isFinite(record.durationMs) ? { durationMs: record.durationMs } : {}),
    msg: relay
      ? `AstrBot relay ${failed ? "failed" : relayPhase}: astrbot/openclaw relay - ${detail}${failed ? ", operation reported failure" : ""}${replyDetail}.`
      : `OpenClaw ${failed ? "failed" : action}: openclaw/${record.type} - ${detail}${failed ? ", operation reported failure" : ""}${replyDetail}.`,
  };
}

// Only activity metadata is consumed here. Raw gateway logs and session transcripts
// stay outside the public feed. Cursor state lives in dashboard storage, never in the mount.
export class ActivityReader {
  constructor({ directory, cursorFile, publish, warn = () => {}, now = Date.now }) {
    Object.assign(this, { directory, cursorFile, publish, warn, now });
    this.pendingAnnouncements = new Map();
    this.cursors = fs.existsSync(cursorFile) ? JSON.parse(fs.readFileSync(cursorFile, "utf8")) : {};
    this.initial = !fs.existsSync(cursorFile);
  }

  poll() {
    const names = fs.readdirSync(this.directory).filter(name => /^activity-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
    for (const name of names) {
      const filename = path.join(this.directory, name);
      if (fs.lstatSync(filename).isSymbolicLink()) continue;
      const descriptor = fs.openSync(filename, "r");
      try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile()) continue;
        let cursor = this.cursors[name];
        if (!cursor) cursor = { ino: stat.ino, offset: this.initial ? stat.size : 0 };
        if (cursor.ino !== stat.ino || cursor.offset > stat.size) cursor = { ino: stat.ino, offset: 0 };
        const buffer = Buffer.alloc(Math.min(256 * 1024, stat.size - cursor.offset));
        const count = fs.readSync(descriptor, buffer, 0, buffer.length, cursor.offset);
        const end = buffer.subarray(0, count).lastIndexOf(10);
        if (end >= 0) {
          for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) {
            let record;
            try { record = JSON.parse(line); } catch { continue; }
            const event = record && activityEvent(record);
            if (event) {
              this.publish(event);
              if (event.runId?.startsWith("announce:")) {
                // Fallback retries reuse the run ID; keep the first start so the warning fires once.
                if (event.openclawEvent === "model_start" && !this.pendingAnnouncements.has(event.runId)) this.pendingAnnouncements.set(event.runId, { event, started: this.now(), warned: false });
                if (event.openclawEvent === "model_output") this.pendingAnnouncements.delete(event.runId);
              }
            }
          }
          cursor.offset += end + 1;
        } else if (count === 256 * 1024) {
          // A corrupted oversized record must not stall every subsequent event.
          cursor.offset += count;
          this.warn("Activity record skipped: dashboard/openclaw log reader — line exceeded 256 KiB.");
        }
        this.cursors[name] = cursor;
      } finally { fs.closeSync(descriptor); }
    }
    for (const [runId, pending] of this.pendingAnnouncements) {
      if (!pending.warned && this.now() - pending.started >= 90000) {
        this.publish({ source: "openclaw", level: "warn", openclawEvent: "announcement_pending", runId, activityTimestamp: this.now(), eventRef: `pending-${pending.event.eventRef}`, agentId: pending.event.agentId,
          msg: "Parent reply is still pending: openclaw/announcement delivery - no completed model result after 90 seconds; check the original conversation for the preserved worker result." });
        pending.warned = true;
      }
      if (this.now() - pending.started > 3600000) this.pendingAnnouncements.delete(runId);
    }
    this.initial = false;
    for (const name of Object.keys(this.cursors)) if (!names.includes(name)) delete this.cursors[name];
    fs.mkdirSync(path.dirname(this.cursorFile), { recursive: true });
    fs.writeFileSync(`${this.cursorFile}.tmp`, JSON.stringify(this.cursors));
    fs.renameSync(`${this.cursorFile}.tmp`, this.cursorFile);
  }
}

export function watchActivity(options) {
  const reader = new ActivityReader(options);
  let lastError = null;
  const poll = () => {
    try { reader.poll(); lastError = null; }
    catch (error) {
      const code = error.code || "unknown";
      if (lastError !== code) options.warn(`Activity unavailable: dashboard/openclaw log reader — shared directory read failed (${code}); retrying.`);
      lastError = code;
    }
  };
  poll();
  const timer = setInterval(poll, 500);
  timer.unref();
  return () => clearInterval(timer);
}
