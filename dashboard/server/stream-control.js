import { createHash, timingSafeEqual } from "node:crypto";
import { tokenBucket } from "./scene/service.js";

// Who may change the live stream through the stream-controller API, decided
// server-side for every request (design: ai-platform-design/stream-scenes.md
// section 11). The stream-controller bearer proves the caller is the
// dashboard-stream OpenClaw plugin; the plugin reports the gateway-supplied
// agent ID and a SHA-256 reference of the gateway session key.
//
// - `main` (owner-only channels; the plugin registers its tool only for
//   senderIsOwner turns) may act on the live recording its own session started
//   or on an administrator-started stream, never on a stream another OpenClaw
//   session owns (decision 8: OpenClaw makes live changes).
// - `dashboard-host` answers public viewers, so it holds no standing right.
//   The dashboard grants each host turn a short-lived capability bound to the
//   turn's session reference and live recording. Only a turn the dashboard
//   started for a signed-in administrator gets an `admin` grant (all live
//   control actions on that recording); a viewer turn gets a `viewer` grant
//   that allows a timed avatar expression only. No prompt text is involved.
// - Requests without an agent ID keep the original owner-session-only rule.
// Actions: title, summary, chat (delete), chat-read, scene (widgets), avatar.
const VIEWER_ACTIONS = new Set(["avatar"]);
// Covers the 120-second host reply timeout (server/chat.js) plus slack.
export const GRANT_TTL_MS = 130_000;
const SESSION_REF = /^[a-f0-9]{64}$/;
const RECORDING_ID = /^[a-f0-9-]{36}$/;

export const sessionRef = sessionKey => createHash("sha256").update(sessionKey).digest("hex");

const fail = (status, consequence, reason) => Object.assign(new Error(`${consequence}: dashboard/stream control — ${reason}.`), { status });

export class StreamControl {
  constructor({ broadcast, emit = () => {}, now = Date.now, limits = {} }) {
    Object.assign(this, { broadcast, emit, now });
    this.grants = new Map();
    // Per action, across all callers: these change what every viewer sees.
    const bucket = (rate, burst) => tokenBucket(rate, burst, now);
    this.buckets = {
      title: bucket(limits.title ?? 0.1, limits.titleBurst ?? 3),
      summary: bucket(limits.summary ?? 0.1, limits.summaryBurst ?? 3),
      chat: bucket(limits.chat ?? 0.5, limits.chatBurst ?? 5),
      viewerAvatar: bucket(limits.viewerAvatar ?? 0.2, limits.viewerAvatarBurst ?? 1),
    };
  }

  // Opens a capability for one dashboard-host turn. Returns a closer; the
  // grant also expires on its own after GRANT_TTL_MS.
  grant(ref, recordingId, role) {
    if (!SESSION_REF.test(ref) || !RECORDING_ID.test(recordingId) || !["admin", "viewer"].includes(role)) throw new Error("grant needs a session reference, a recording ID, and a role");
    const entry = { recordingId, role, expiresAt: this.now() + GRANT_TTL_MS };
    this.grants.set(ref, entry);
    return () => { if (this.grants.get(ref) === entry) this.grants.delete(ref); };
  }

  activeGrant(ref, recordingId) {
    const entry = this.grants.get(ref);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) { this.grants.delete(ref); return null; }
    return entry.recordingId === recordingId ? entry : null;
  }

  // Throws unless the caller may perform `action` on the live recording.
  // Returns { via: "owner-session" | "owner-agent" | "admin-turn" | "viewer-turn", agentId }.
  authorize(source, action, consequence = "Stream not changed") {
    const { recordingId, sessionRef: ref, agentId } = source || {};
    if (typeof recordingId !== "string" || !RECORDING_ID.test(recordingId) || typeof ref !== "string" || !SESSION_REF.test(ref)) throw fail(400, consequence, "a live recording ID and a valid session reference are required");
    if (agentId !== undefined && (typeof agentId !== "string" || !/^[a-zA-Z0-9_.:/-]{1,120}$/.test(agentId))) throw fail(400, consequence, "the agent ID is invalid");
    const active = this.broadcast.active;
    if (!active || active.id !== recordingId) throw fail(409, consequence, "the target recording is no longer live");
    const ownSession = active.sessionRef === ref;
    let via;
    if (agentId === "dashboard-host") {
      const entry = this.activeGrant(ref, recordingId);
      if (!entry) via = null;
      else if (entry.role === "admin") via = "admin-turn";
      else if (VIEWER_ACTIONS.has(action)) via = "viewer-turn";
      if (!via) {
        this.emit({ source: "dashboard", level: "warn", msg: `Stream control refused: dashboard/stream control — dashboard-host ${action} without an administrator turn (session ${ref.slice(0, 8)}).` });
        throw fail(403, consequence, entry ? "viewer turns may only set a timed avatar expression; ask a dashboard administrator" : "public host turns need an administrator-started chat turn for this recording");
      }
    } else if (agentId === "main") {
      if (!ownSession && active.origin === "openclaw") throw fail(409, consequence, "another OpenClaw session owns the live recording");
      via = ownSession ? "owner-session" : "owner-agent";
    } else if (agentId === undefined) {
      if (!ownSession) throw fail(409, consequence, "this session does not own the live recording");
      via = "owner-session";
    } else throw fail(403, consequence, `agent '${agentId}' has no stream-control rights`);
    if (via === "viewer-turn" && !this.buckets.viewerAvatar.take()) throw fail(429, consequence, "viewer turns may set the avatar at most once every 5 seconds");
    if (this.buckets[action] && !this.buckets[action].take()) throw fail(429, consequence, { title: "the title may change at most 3 times, then once every 10 seconds", summary: "the description may change at most 3 times, then once every 10 seconds", chat: "chat moderation accepts at most 5 removals, then one every 2 seconds" }[action]);
    return { via, agentId: agentId ?? "unknown" };
  }

  // Private operator audit line (container log), never published.
  audit(action, who, detail = "") {
    this.emit({ source: "dashboard", level: "info", msg: `Stream control applied: dashboard/stream control — ${action} by ${who.agentId} via ${who.via}${detail ? `, ${detail}` : ""}.` });
  }
}

// Constant-time stream-controller bearer check shared by the OpenClaw routes.
export function streamBearer(token, consequence) {
  return (req, res, next) => {
    const expected = Buffer.from(`Bearer ${token}`);
    const actual = Buffer.from(req.get("authorization") || "");
    if (!token || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return res.status(401).json({ error: `${consequence}: dashboard/openclaw authentication — stream-controller bearer token is missing or incorrect.` });
    }
    next();
  };
}
