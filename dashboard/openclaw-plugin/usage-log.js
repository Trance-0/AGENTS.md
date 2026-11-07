import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

// llm_output carries totals for the whole attempt, including tool continuations.
// Never substitute lastAssistant.usage: that would omit earlier model calls.
export function usageRecord(event, context, config = {}) {
  if (!event.usage || !event.provider || !event.model || !event.runId) return null;
  const usage = Object.fromEntries(["input", "output", "cacheRead", "cacheWrite"].map(key => [key, count(event.usage[key])]));
  const total = Object.values(usage).reduce((sum, value) => sum + value, 0);
  if (!total) return null;
  const timestamp = Number.isFinite(event.lastAssistant?.timestamp) ? event.lastAssistant.timestamp : Date.now();
  const id = createHash("sha256").update(JSON.stringify([event.runId, event.provider, event.model, timestamp, usage])).digest("hex");
  const model = config.models?.providers?.[event.provider]?.models?.find(model => model.id === event.model);
  const rates = model?.cost;
  // Zero-filled model templates are unknown prices, not proof of free service.
  const priced = rates && ["input", "output", "cacheRead", "cacheWrite"].every(key => Number.isFinite(rates[key]) && rates[key] >= 0)
    && Object.values(rates).some(value => value > 0);
  return {
    schemaVersion: 1, id, timestamp, route: event.provider, model: event.model,
    agent: context.agentId || "unknown", ...usage, total,
    success: event.lastAssistant?.stopReason !== "error" && event.lastAssistant?.stopReason !== "aborted",
    costUsd: priced ? Object.entries(usage).reduce((sum, [key, value]) => sum + value * rates[key] / 1e6, 0) : null,
    priceSource: priced ? "openclaw-config" : "unpriced",
  };
}

export function writeUsage(directory, event, context, config) {
  if (!directory) return;
  const record = usageRecord(event, context, config);
  if (!record) return;
  mkdirSync(directory, { recursive: true });
  const day = new Date(record.timestamp).toISOString().slice(0, 10);
  appendFileSync(path.join(directory, `usage-${day}.jsonl`), JSON.stringify(record) + "\n", { mode: 0o640 });
}
