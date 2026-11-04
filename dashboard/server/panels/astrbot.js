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
        { label: "Dashboard", value: ok ? "up" : "down", tone: ok ? "ok" : "error" },
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
    const res = await ctx.fetch(config.astrbot.endpoint, { timeout: 4000 });
    return res.ok;
  } catch (err) {
    emit({ source: "astrbot", level: "warn", msg: `AstrBot status unavailable: astrbot/dashboard probe — ${err.message}` });
    return false;
  }
}
