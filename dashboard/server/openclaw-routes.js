import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

const types = new Set(["agent_start", "model_start", "model_output", "tool_start", "tool_end", "agent_end"]);
const safeRunId = value => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,256}$/.test(value);
const safeName = value => typeof value === "string" && /^[a-zA-Z0-9_.:/-]{1,120}$/.test(value);

export function mountOpenClaw(app, broadcast) {
  let recordingId;
  const seen = new Set();
  const route = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
  const authenticate = (req, res, next) => {
    const expected = Buffer.from(`Bearer ${config.openclaw.streamToken}`);
    const actual = Buffer.from(req.get("authorization") || "");
    if (!config.openclaw.streamToken || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return res.status(401).json({ error: "Stream control unavailable: dashboard/openclaw authentication — stream-controller bearer token is missing or incorrect." });
    }
    next();
  };
  app.get("/api/openclaw/stream", authenticate, (_req, res) => res.json({ stream: broadcast.status() }));
  app.post("/api/openclaw/stream/start", authenticate, route((req, res) => {
    const { title, sessionRef, agentId } = req.body || {};
    if (typeof title !== "string" || !title.trim() || title.length > 160 || !/^[a-f0-9]{64}$/.test(sessionRef || "") || !safeName(agentId)) {
      return res.status(400).json({ error: "Stream cannot start: dashboard/openclaw control — a title, valid session reference, and agent ID are required." });
    }
    if (broadcast.active) {
      if (broadcast.active.sessionRef !== sessionRef) return res.status(409).json({ error: "Stream cannot start: dashboard/openclaw control — another session already owns the live stream." });
      return res.json({ stream: broadcast.status() });
    }
    res.status(201).json({ stream: broadcast.start(title.trim(), { origin: "openclaw", agentId, sessionRef }) });
  }));
  app.post("/api/openclaw/stream/end", authenticate, route((req, res) => {
    if (!broadcast.active || broadcast.active.id !== req.body?.recordingId || broadcast.active.sessionRef !== req.body?.sessionRef) {
      return res.status(409).json({ error: "Stream cannot end: dashboard/openclaw control — this session does not own the live recording." });
    }
    res.json({ recording: broadcast.stop("openclaw") });
  }));
  app.post("/api/openclaw/stream/summary", authenticate, route((req, res) => {
    const { summary, recordingId, sessionRef, agentId } = req.body || {};
    if (!broadcast.active || broadcast.active.id !== recordingId) return res.status(409).json({ error: "Summary cannot be updated: dashboard/openclaw control — target recording is no longer live." });
    if (agentId !== "main" || !/^[a-f0-9]{64}$/.test(sessionRef || "")) return res.status(403).json({ error: "Summary cannot be updated: dashboard/openclaw control — the trusted main-agent controller is required." });
    if (typeof summary !== "string" || !summary.trim() || summary.length > 4000) return res.status(400).json({ error: "Summary cannot be updated: dashboard/stream summary — enter between 1 and 4000 characters." });
    res.json({ stream: broadcast.summarize(summary.trim()) });
  }));
  app.post("/api/openclaw/events", authenticate, route((req, res) => {
    const event = req.body || {};
    if (!broadcast.active || broadcast.active.id !== event.recordingId) return res.status(409).json({ error: "Event not recorded: dashboard/openclaw ingestion — target recording is no longer live." });
    if (!types.has(event.type) || !safeName(event.agentId) || !/^[a-f0-9]{64}$/.test(event.sessionRef || "") || !safeName(event.eventId) || (event.toolName !== undefined && !safeName(event.toolName)) || (event.model !== undefined && !safeName(event.model)) || (event.provider !== undefined && !safeName(event.provider)) || (event.runId !== undefined && !safeRunId(event.runId))) {
      return res.status(400).json({ error: "Event not recorded: dashboard/openclaw ingestion — event type or public metadata is invalid." });
    }
    if (recordingId !== event.recordingId) { recordingId = event.recordingId; seen.clear(); }
    if (seen.has(event.eventId)) return res.json({ duplicate: true });
    const detail = event.toolName ? `tool ${event.toolName}` : event.model ? `model ${event.provider ? event.provider + "/" : ""}${event.model}` : `agent ${event.agentId}`;
    const failed = event.success === false;
    const durationMs = Number.isFinite(event.durationMs) ? Math.max(0, Math.round(event.durationMs)) : undefined;
    let msg = `OpenClaw activity ${failed ? "failed" : "recorded"}: openclaw/${event.type} — ${detail}${durationMs === undefined ? "" : `, duration ${durationMs}ms`}${failed ? ", operation reported failure" : ""}.`;
    // Only a session which explicitly started broadcasting may publish its text.
    if (event.type === "model_output" && broadcast.active.sessionRef === event.sessionRef && typeof event.text === "string" && event.text.trim()) msg = event.text.trim().slice(0, 12000);
    const saved = broadcast.publish({ source: "openclaw", level: failed ? "warn" : "info", msg, openclawEvent: event.type, agentId: event.agentId, eventRef: event.eventId, ...(event.provider ? { provider: event.provider } : {}), ...(event.model ? { model: event.model } : {}), ...(event.runId ? { runId: event.runId } : {}), ...(durationMs === undefined ? {} : { durationMs }) }, event.recordingId);
    seen.add(event.eventId);
    res.status(201).json({ id: saved.id });
  }));
}
