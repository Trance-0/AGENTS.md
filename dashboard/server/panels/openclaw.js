// OpenClaw status manager. Shows gateway health and the configured agents with
// their model + fallback chain. Model/providers are edited in the Agents tab;
// key values never leave the private environment.

import { config } from "../config.js";
import { emit } from "../log-bus.js";
import { agentSummary } from "../openclaw-agents.js";

export function createOpenclawPanel(ctx) {
  return {
    id: "openclaw",
    title: "OpenClaw",
    description: "Gateway health and the configured agents with their model fallback chain.",
    icon: "claw",
    group: "openclaw",
    order: 10,
    tabs: [{ id: "openclaw-status", title: "Status" }],

    settings: () => [
      { key: "endpoint", label: "Endpoint", type: "string", value: config.openclaw.endpoint },
    ],

    status: async () => {
      const ok = await probe(ctx);
      const summary = agentSummary();
      return [
        { label: "Gateway", value: ok ? "reachable" : "unreachable", tone: ok ? "ok" : "error" },
        { label: "Agents", value: summary.available ? String(summary.agents.length) : "unknown", tone: "neutral" },
      ];
    },

    data: () => ({
      endpoint: config.openclaw.endpoint,
      ...agentSummary(),
    }),
  };
}

async function probe(ctx) {
  try {
    const res = await ctx.fetch(config.openclaw.endpoint + "/healthz", { timeout: 4000 });
    return res.ok;
  } catch (err) {
    emit({ source: "openclaw", level: "warn", msg: `Gateway status unavailable: openclaw/health probe — ${err.message}` });
    return false;
  }
}
