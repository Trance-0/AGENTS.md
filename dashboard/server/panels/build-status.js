// Jenkins build / LKG status panel. Read-only; uses the agent's read-only
// Jenkins token (if any) and never exposes credentials.

import { config } from "../config.js";
import { emit } from "../log-bus.js";

export function createBuildStatusPanel(ctx) {
  return {
    id: "build-status",
    title: "Build & LKG",
    description: "Pipeline build status and last-known-good tag.",
    icon: "build",

    settings: () => [
      { key: "endpoint", label: "Jenkins", type: "string", value: config.jenkins.endpoint },
    ],

    status: async () => {
      const ok = await probe(ctx);
      return [
        { label: "Jenkins", value: ok ? "up" : "down", tone: ok ? "ok" : "error" },
        { label: "LKG", value: "n/a", tone: "neutral" },
      ];
    },

    data: () => ({
      endpoint: config.jenkins.endpoint,
      // LKG tracking is wired when the platform deploy job is configured.
      lkg: null,
    }),
  };
}

async function probe(ctx) {
  try {
    const res = await ctx.fetch(config.jenkins.endpoint + "/login", { timeout: 4000 });
    return res.ok;
  } catch (err) {
    emit({ source: "jenkins", level: "warn", msg: `probe failed: ${err.message}` });
    return false;
  }
}
