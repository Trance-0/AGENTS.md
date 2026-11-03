// OpenClaw backend manager. Shows provider names and the env var names they
// read — never the key values, which stay in Jenkins credentials.

import { config } from "../config.js";
import { emit } from "../log-bus.js";

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
    description: "Model backend manager: provider names and env var names only.",
    icon: "claw",

    settings: () => [
      { key: "endpoint", label: "Endpoint", type: "string", value: config.openclaw.endpoint },
    ],

    status: async () => {
      const ok = await probe(ctx);
      return [
        { label: "Gateway", value: ok ? "reachable" : "unreachable", tone: ok ? "ok" : "error" },
        { label: "Providers", value: String(PROVIDERS.length), tone: "neutral" },
      ];
    },

    data: () => ({
      endpoint: config.openclaw.endpoint,
      providers: PROVIDERS,
    }),
  };
}

async function probe(ctx) {
  try {
    const res = await ctx.fetch(config.openclaw.endpoint + "/healthz", { timeout: 4000 });
    return res.ok;
  } catch (err) {
    emit({ source: "openclaw", level: "warn", msg: `probe failed: ${err.message}` });
    return false;
  }
}
