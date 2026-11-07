// Last-seen AstrBot -> OpenClaw relay activity, derived from the shared
// OpenClaw activity metadata (agent `relay`). Only lifecycle metadata is kept:
// no message text, sender, or conversation identifiers.

export const RELAY_AGENT = "relay";

const state = { requests: 0, failures: 0, lastRequestAt: null, lastReplyAt: null, lastModel: null, lastFailed: false };

export function noteRelayActivity(event) {
  if (event?.agentId !== RELAY_AGENT) return;
  const at = new Date(event.activityTimestamp || Date.now()).toISOString();
  if (event.openclawEvent === "agent_start") { state.requests += 1; state.lastRequestAt = at; }
  if (event.openclawEvent === "model_output" && event.model) state.lastModel = `${event.provider ? event.provider + "/" : ""}${event.model}`;
  if (event.openclawEvent === "agent_end") {
    state.lastReplyAt = at;
    state.lastFailed = event.level === "warn";
    if (state.lastFailed) state.failures += 1;
  }
}

export function relayStatus() {
  return { ...state };
}
