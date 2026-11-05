// Agent list and model fallback chains from the mounted openclaw.json, reduced
// to public identifiers. Lives outside server/panels/ because the panel loader
// registers the first exported function of every module there.

import fs from "node:fs";
import { config } from "./config.js";

const safeName = value => typeof value === "string" && /^[a-zA-Z0-9_.:/-]{1,120}$/.test(value) ? value : null;

// Model selection as { primary, fallbacks } from either a string or an object.
function modelChain(value) {
  if (typeof value === "string") return safeName(value) ? { primary: value, fallbacks: [] } : null;
  if (!value || typeof value !== "object") return null;
  const primary = safeName(value.primary);
  const fallbacks = Array.isArray(value.fallbacks) ? value.fallbacks.map(safeName).filter(Boolean).slice(0, 8) : [];
  return primary || fallbacks.length ? { primary, fallbacks } : null;
}

// Agents and their resolved model order from the mounted openclaw.json.
// Only IDs, display names, and model IDs leave this function.
export function agentSummary(file = config.openclaw.configFile) {
  if (!file) return { available: false, reason: "OpenClaw config is not mounted in this deployment.", agents: [] };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { return { available: false, reason: `OpenClaw agents unavailable: openclaw/config read — ${error.code || "invalid JSON"}.`, agents: [] }; }
  const defaults = modelChain(parsed?.agents?.defaults?.model);
  const list = Array.isArray(parsed?.agents?.list) ? parsed.agents.list : [];
  const agents = list.slice(0, 32).map(agent => {
    const id = safeName(agent?.id);
    if (!id) return null;
    const own = modelChain(agent.model);
    return { id, name: typeof agent.name === "string" ? agent.name.slice(0, 80) : id, model: own || defaults, inheritsDefault: !own };
  }).filter(Boolean);
  return { available: true, defaults, agents };
}
