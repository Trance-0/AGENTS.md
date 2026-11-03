// AstrBot (QQ/WeChat adapter) status panel. Read-only.

import { config } from "../config.js";
import { emit } from "../log-bus.js";

export function createAstrbotPanel(ctx) {
  return {
    id: "astrbot",
    title: "AstrBot",
    description: "QQ / WeChat adapter that relays to OpenClaw.",
    icon: "bot",

    settings: () => [
      { key: "endpoint", label: "Endpoint", type: "string", value: config.astrbot.endpoint },
    ],

    status: async () => {
      const ok = await probe(ctx);
      return [
        { label: "API", value: ok ? "up" : "down", tone: ok ? "ok" : "error" },
        { label: "Account", value: config.astrbot.username || "(unset)", tone: "neutral" },
      ];
    },

    data: () => ({
      endpoint: config.astrbot.endpoint,
      username: config.astrbot.username || "(unset)",
    }),
  };
}

async function probe(ctx) {
  try {
    const res = await ctx.fetch(config.astrbot.endpoint + "/api/health", { timeout: 4000 });
    return res.ok;
  } catch {
    // AstrBot has no single /api/health; a TCP reach on the base is enough signal.
    try {
      const res = await ctx.fetch(config.astrbot.endpoint, { timeout: 4000 });
      return true;
    } catch (err) {
      emit({ source: "astrbot", level: "warn", msg: `probe failed: ${err.message}` });
      return false;
    }
  }
}
