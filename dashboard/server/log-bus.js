// Live log/event bus that feeds the streaming window.
// One in-memory ring buffer, one startedAt clock, and a set of SSE subscribers.

import logger from "loglevel";

logger.setLevel("info");
const MAX_EVENTS = 2000;

const startedAt = Date.now();
const events = [];
const subscribers = new Set();

export function uptimeSeconds() {
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}

// A log line with an uptime timestamp (t) so the timeline scrubber can map
// every event to a point on the uptime progress bar.
export function emit({ source = "dashboard", level = "info", msg = "" }) {
  const event = {
    id: events.length,
    ts: Date.now(),
    t: uptimeSeconds(),
    source,
    level,
    msg: String(msg),
  };
  logger[level](JSON.stringify({ time: new Date(event.ts).toISOString(), level: level.toUpperCase(), source, msg: event.msg }));
  events.push(event);
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }
  for (const send of subscribers) {
    try {
      send(event);
    } catch {
      // best-effort; a dead subscriber is pruned on the next write
    }
  }
  return event;
}

export function getEvents() {
  return events.slice();
}

export function subscribe(send) {
  subscribers.add(send);
  return () => subscribers.delete(send);
}

export function subscriberCount() {
  return subscribers.size;
}
