import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function writeActivity(directory, type, event, context) {
  if (!directory || !context.agentId) return;
  const timestamp = new Date().toISOString();
  const record = {
    eventId: randomUUID(), timestamp, type, agentId: context.agentId,
    success: event.success !== false && !event.error && event.result?.isError !== true && event.lastAssistant?.stopReason !== "error" && event.lastAssistant?.stopReason !== "aborted",
  };
  if (event.toolName) record.toolName = event.toolName;
  if (event.model) record.model = event.model;
  if (event.provider) record.provider = event.provider;
  const runId = event.runId || context.runId;
  if (typeof runId === "string" && /^[a-zA-Z0-9_.:-]{1,256}$/.test(runId)) record.runId = runId;
  if (type === "model_output") {
    record.replyChars = (event.assistantTexts || []).filter(text => typeof text === "string").reduce((sum, text) => sum + text.trim().length, 0);
    if (["stop", "end_turn", "toolUse", "length", "error", "aborted"].includes(event.lastAssistant?.stopReason)) record.stopReason = event.lastAssistant.stopReason;
  }
  if (Number.isFinite(event.durationMs)) record.durationMs = Math.max(0, Math.round(event.durationMs));
  // File activity is public metadata. Never copy commands, contents, or other arguments.
  if (["read", "write", "edit"].includes(event.toolName)) {
    const filename = event.params?.path ?? event.params?.file_path;
    if (typeof filename === "string") {
      record.path = /(?:^|[/\\])(?:\.env(?:\.[^/\\]*)?|credentials|secrets?|[^/\\]*\.(?:pem|key))(?:[/\\]|$)/i.test(filename)
        ? "[sensitive file]" : filename.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 512);
    }
  }
  mkdirSync(directory, { recursive: true });
  appendFileSync(path.join(directory, `activity-${timestamp.slice(0, 10)}.jsonl`), JSON.stringify(record) + "\n", { mode: 0o640 });
}
