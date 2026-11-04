import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

const reference = context => createHash("sha256").update(context.sessionKey || context.sessionId || "unknown").digest("hex");

export default function register(api) {
  const endpoint = new URL(api.pluginConfig.endpoint);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.protocol !== "http:") throw new Error("Plugin cannot start: dashboard-stream/configuration — endpoint must be loopback HTTP.");
  const token = readFileSync(api.pluginConfig.tokenFile, "utf8").trim();
  if (!token) throw new Error("Plugin cannot start: dashboard-stream/configuration — stream token file is empty.");
  const request = async (pathname, body) => {
    const response = await fetch(new URL(pathname, endpoint), {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`Dashboard request unavailable: dashboard-stream/transport — HTTP ${response.status}.`);
    return data;
  };
  let queue = Promise.resolve();
  let pending = 0;
  function record(type, event, context) {
    if (!context.agentId || (!context.sessionKey && !context.sessionId)) return;
    if (pending >= 256) { api.logger.warn("Event not forwarded: dashboard-stream/event queue — 256 pending events reached; dashboard is too slow."); return; }
    pending++;
    // Snapshot the target at hook arrival; queued events cannot drift into a later stream.
    const snapshot = request("/api/openclaw/stream").catch(() => {
      api.logger.warn("Event not forwarded: dashboard-stream/status lookup — dashboard is unreachable or rejected the stream credential; agent continues.");
      return null;
    });
    const operation = async () => {
      try {
        const stream = (await snapshot)?.stream;
        if (!stream) return;
        const sessionRef = reference(context);
        await request("/api/openclaw/events", {
          type, recordingId: stream.id, sessionRef, agentId: context.agentId, eventId: randomUUID(),
          ...(event.toolName ? { toolName: event.toolName } : {}),
          ...(event.model ? { model: event.model } : {}),
          ...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
          success: event.success !== false && !event.error && event.lastAssistant?.stopReason !== "error",
          ...(type === "model_output" && stream.sessionRef === sessionRef ? { text: (event.assistantTexts || []).join("\n").slice(0, 12000) } : {}),
        });
      } catch {
        api.logger.warn("Event not forwarded: dashboard-stream/event delivery — dashboard request failed or recording ended; agent continues.");
      } finally { pending--; }
    };
    queue = queue.then(operation, operation);
    return queue;
  }
  for (const [hook, type] of [["before_agent_start", "agent_start"], ["llm_input", "model_start"], ["llm_output", "model_output"], ["before_tool_call", "tool_start"], ["after_tool_call", "tool_end"], ["agent_end", "agent_end"]]) {
    api.on(hook, (event, context) => record(type, event, context));
  }
  api.registerTool(context => {
    if (context.agentId !== "main" || context.senderIsOwner !== true || !context.sessionKey) return null;
    return {
      name: "dashboard_stream",
      label: "Dashboard stream",
      description: "Start, summarize, inspect, or end the public dashboard stream at live.trance-0.com. Use start only when the owner asks to broadcast: subsequent assistant text in this session becomes public. Logs and chat are recorded. Other sessions remain private. Summary sets the current live description, including an administrator-started stream. End saves the recording; admins curate it in the dashboard.",
      parameters: { type: "object", additionalProperties: false, required: ["action"], properties: { action: { type: "string", enum: ["start", "status", "summary", "end"] }, title: { type: "string", maxLength: 160 }, summary: { type: "string", maxLength: 4000 } } },
      async execute(_id, params) {
        const sessionRef = reference(context);
        let data;
        if (params.action === "start") {
          data = await request("/api/openclaw/stream/start", { title: params.title || "OpenClaw Live", sessionRef, agentId: context.agentId });
        } else if (params.action === "summary") {
          const current = await request("/api/openclaw/stream");
          data = await request("/api/openclaw/stream/summary", { recordingId: current.stream?.id, sessionRef, agentId: context.agentId, summary: params.summary });
        } else if (params.action === "end") {
          const current = await request("/api/openclaw/stream");
          data = await request("/api/openclaw/stream/end", { recordingId: current.stream?.id, sessionRef });
        } else if (params.action === "status") data = await request("/api/openclaw/stream");
        else throw new Error("Stream cannot be controlled: dashboard-stream/tool validation — action must be start, status, summary, or end.");
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    };
  }, { optional: true, name: "dashboard_stream" });
}
