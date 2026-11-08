// Jenkins build / LKG status panel. Read-only; uses the agent's read-only
// Jenkins token (if any) and never exposes credentials.

import { releaseStatus } from "../release-status.js";
import { config } from "../config.js";
import { emit } from "../log-bus.js";

export function createBuildStatusPanel(ctx) {
  return {
    id: "build-status",
    title: "Build & LKG",
    description: "Pipeline build status and last-known-good tag.",
    icon: "build",
    group: "builds",
    order: 10,
    tabTitle: "Build & LKG",

    settings: () => [
      { key: "endpoint", label: "Jenkins", type: "string", value: config.jenkins.endpoint },
    ],

    status: async () => {
      const ok = await probe(ctx);
      const release = releaseStatus();
      return [
        { label: "Jenkins", value: ok ? "up" : "down", tone: ok ? "ok" : "error" },
        { label: "OpenClaw known-good", value: release ? release.revision.slice(0, 12) : "Not configured", tone: release?.healthy && !release.stale ? "ok" : "neutral" },
        { label: "Recovery", value: release ? (release.stale ? "Status is stale" : release.action) : "Not configured", tone: release?.stale ? "warn" : "neutral" },
      ];
    },

    data: () => ({
      endpoint: config.jenkins.endpoint,
      lkg: releaseStatus(),
    }),
  };
}

async function probe(ctx) {
  try {
    const res = await ctx.fetch(config.jenkins.endpoint + "/login", { timeout: 4000 });
    return res.ok;
  } catch (err) {
    emit({ source: "jenkins", level: "warn", msg: `Build status unavailable: build-status/health probe — ${err.message}` });
    return false;
  }
}
