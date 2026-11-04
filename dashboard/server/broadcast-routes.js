import { createChat } from "./chat.js";
import { Viewers } from "./viewers.js";
import { config } from "./config.js";

export function mountBroadcast(app, broadcast, { requireAuth, requireAdmin, requireCsrf }) {
  const viewers = new Viewers(config.sessionSecret, config.oidc.redirectUri.startsWith("https://"));
  const identifyViewer = viewers.identify.bind(viewers);
  const route = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
  const lookup = req => {
    const recording = broadcast.get(req.params.id);
    if (recording.hidden && !req.session?.user?.isAdmin) throw Object.assign(new Error("Recording unavailable: dashboard/recording playback — recording is hidden."), { status: 404 });
    return recording;
  };
  app.get("/api/broadcast", identifyViewer, (_req, res) => res.json({ stream: broadcast.status(), viewers: viewers.count }));
  app.get("/api/recordings", (_req, res) => res.json({ recordings: broadcast.list() }));
  app.get("/api/admin/recordings", requireAuth, requireAdmin, (_req, res) => res.json({ recordings: broadcast.list(true) }));
  app.get("/api/recordings/:id/events", route((req, res) => {
    const recording = lookup(req);
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    const events = broadcast.readEvents(recording.id, offset, 1000);
    res.json({ recording: recording.id === broadcast.active?.id ? broadcast.status() : recording, events, nextOffset: offset + events.length, more: offset + events.length < recording.eventCount });
  }));
  app.post("/api/broadcast/start", requireAuth, requireAdmin, requireCsrf, route((req, res) => {
    const title = req.body?.title;
    if (typeof title !== "string" || !title.trim() || title.length > 160) return res.status(400).json({ error: "Stream cannot start: dashboard/broadcast title — enter between 1 and 160 characters." });
    res.status(201).json({ stream: broadcast.start(title.trim()) });
  }));
  app.post("/api/broadcast/end", requireAuth, requireAdmin, requireCsrf, route((_req, res) => res.json({ recording: broadcast.stop() })));
  app.patch("/api/recordings/:id", requireAuth, requireAdmin, requireCsrf, route((req, res) => {
    const { hidden, score } = req.body || {};
    if (typeof hidden !== "boolean" || !Number.isFinite(score) || score < 0 || score > 100) return res.status(400).json({ error: "Recording cannot be edited: dashboard/recording moderation — visibility must be boolean and recommendation score must be between 0 and 100." });
    res.json({ recording: broadcast.update(req.params.id, { hidden, score }) });
  }));
  app.post("/api/chat", requireAuth, requireCsrf, createChat(broadcast));
  app.get("/api/stream", identifyViewer, (req, res) => {
    const disconnect = viewers.connect(req.viewerId);
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no", Connection: "keep-alive" });
    res.flushHeaders();
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    send("status", broadcast.status());
    if (broadcast.active) for (const event of broadcast.readEvents(broadcast.active.id, Math.max(0, broadcast.active.eventCount - 500), 500)) send("event", event);
    const unsubscribe = broadcast.subscribe(send);
    broadcast.notify("viewers", { count: viewers.count });
    const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 15000);
    req.on("close", () => { clearInterval(heartbeat); unsubscribe(); disconnect(); broadcast.notify("viewers", { count: viewers.count }); });
  });
}
