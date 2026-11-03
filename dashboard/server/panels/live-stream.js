// The live streaming window panel. For now the "video" is the log stream:
// uptime drives the progress bar, and every log event carries an uptime
// timestamp so the timeline scrubber can resolve a timepoint to its events.

import { emit, getEvents, subscriberCount, uptimeSeconds } from "../log-bus.js";

export function createLiveStreamPanel(ctx) {
  return {
    id: "live-stream",
    title: "Live Stream",
    description: "Streaming window: uptime progress bar and the live log feed.",
    icon: "stream",

    settings: () => [
      {
        key: "autoScroll",
        label: "Auto-scroll",
        type: "boolean",
        value: true,
      },
      {
        key: "showSource",
        label: "Show source column",
        type: "boolean",
        value: true,
      },
    ],

    status: () => [
      { label: "Uptime", value: fmtUptime(uptimeSeconds()), tone: "ok" },
      { label: "Events", value: String(getEvents().length), tone: "neutral" },
      { label: "Viewers", value: String(subscriberCount()), tone: "neutral" },
    ],

    data: () => ({
      uptimeSeconds: uptimeSeconds(),
      events: getEvents(),
    }),
  };
}

function fmtUptime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, "0")).join(":");
}

// Re-export so the index can seed startup events.
export { emit };
