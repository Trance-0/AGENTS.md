// AstrBot (QQ/WeChat adapter) status panel. Read-only.
//
// AstrBot forwards channel messages to OpenClaw's `relay` agent through the
// OpenAI-compatible endpoint (model `openclaw/relay`). Receipt is shown from
// OpenClaw's shared activity metadata, so the dashboard needs no AstrBot
// credential and never sees message content.

import { config } from "../config.js";
import { emit } from "../log-bus.js";
import { relayStatus } from "../relay-status.js";

export function createAstrbotPanel(ctx) {
  let lastProbe = null;
  return {
    id: "astrbot",
    title: "AstrBot",
    description: "QQ / WeChat adapter that relays to OpenClaw (model openclaw/relay).",
    icon: "bot",

    settings: () => [
      { key: "endpoint", label: "Endpoint", type: "string", value: config.astrbot.endpoint },
      { key: "backend", label: "Agent backend", type: "string", value: "openclaw/relay" },
    ],

    status: async () => {
      const ok = await probe(ctx, lastProbe);
      lastProbe = ok;
      const relay = relayStatus();
      return [
        { label: "Dashboard", value: ok ? "up" : "down", tone: ok ? "ok" : "error" },
        { label: "Relay requests", value: String(relay.requests), tone: "neutral" },
        { label: "Last request", value: relay.lastRequestAt || "none since dashboard start", tone: relay.lastRequestAt ? "ok" : "neutral" },
        { label: "Last reply", value: relay.lastReplyAt ? `${relay.lastReplyAt}${relay.lastFailed ? " (failed)" : ""}` : "none", tone: relay.lastFailed ? "error" : "neutral" },
      ];
    },

    data: () => ({ endpoint: config.astrbot.endpoint, relay: relayStatus() }),
  };
}

// Warn only on an up -> down transition, not on every status poll.
async function probe(ctx, previous) {
  try {
    const res = await ctx.fetch(config.astrbot.endpoint, { timeout: 4000 });
    return res.ok;
  } catch (err) {
    if (previous !== false) emit({ source: "astrbot", level: "warn", msg: `AstrBot status unavailable: astrbot/dashboard probe — ${err.message}` });
    return false;
  }
}
