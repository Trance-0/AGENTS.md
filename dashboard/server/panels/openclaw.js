// OpenClaw backend manager. Shows gateway health, the configured agents with
// their model + fallback chain, and provider names with the env var names they
// read — never key values, which stay in the private environment.

import { config } from "../config.js";
import { emit } from "../log-bus.js";
import { agentSummary } from "../openclaw-agents.js";

// Provider -> env var name it reads. Names only, no secrets.
const PROVIDERS = [
  { provider: "cpa", env: "CPA_API_KEY", note: "CliProxyAPI (cpa.trance-0.com)" },
  { provider: "openai", env: "OPENAI_API_KEY", note: "Official OpenAI API" },
  { provider: "openai-codex", env: "(OAuth)", note: "ChatGPT Codex OAuth" },
];

export function createOpenclawPanel(ctx) {
  return {
    id: "openclaw",
    title: "OpenClaw",
    description: "Gateway health, agents with their model fallback chain, and model backends (provider and env var names only).",
    icon: "claw",
    group: "openclaw",
    order: 10,
    tabs: [{ id: "openclaw-status", title: "Status" }, { id: "openclaw-backends", title: "Backends" }],

    settings: () => [
      { key: "endpoint", label: "Endpoint", type: "string", value: config.openclaw.endpoint },
    ],

    status: async () => {
      const ok = await probe(ctx);
      const summary = agentSummary();
      return [
        { label: "Gateway", value: ok ? "reachable" : "unreachable", tone: ok ? "ok" : "error" },
        { label: "Agents", value: summary.available ? String(summary.agents.length) : "unknown", tone: "neutral" },
        { label: "Providers", value: String(PROVIDERS.length), tone: "neutral" },
      ];
    },

    data: () => ({
      endpoint: config.openclaw.endpoint,
      providers: PROVIDERS,
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
