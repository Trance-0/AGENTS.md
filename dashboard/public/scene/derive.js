// Client-derived avatar expressions and cat poses: pure functions of the folded
// scene state and the playback time, so live, seek, and every playback rate
// show the same picture for the same t (decision 10: no extra stored state).

export const EXPRESSIONS = Object.freeze(["idle", "blink", "talk", "think", "sleepy"]);
export const CAT_SLEEP_SECONDS = 300;
const THINK_TIMEOUT = 120;
const BLINK_PERIOD = 4.2;
const BLINK_LENGTH = 0.16;
const TAP_LENGTH = 0.25;
const TYPING_AFTER_TAP = 1.5;

// Small integer hash for deterministic jitter (no Math.random).
function jitter(n) {
  let x = (n | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

export function blinking(t) {
  const cycle = Math.floor(t / BLINK_PERIOD);
  const start = cycle * BLINK_PERIOD + 0.4 + jitter(cycle) * (BLINK_PERIOD - 0.8);
  return t >= start && t < start + BLINK_LENGTH;
}

// Sleepy while the host runs on the paid fallback: the latest host
// model_output came from provider "openai" instead of "cpa", or a pooled Codex
// window (as last published to the stream) is at 0%.
export function onPaidFallback(state) {
  if (state.activity.provider === "openai") return true;
  return ["cpa.codex.5h", "cpa.codex.week"].some(source => state.metrics[source]?.remainingPercent === 0);
}

export function avatarExpression(state, t) {
  const activity = state.activity;
  // A forced expression (OpenClaw `avatar` action) wins until it times out.
  if (state.avatar && t < state.avatar.until && EXPRESSIONS.includes(state.avatar.expression)) return state.avatar.expression;
  if (onPaidFallback(state)) return "sleepy";
  if (activity.talkUntil !== null && t < activity.talkUntil) return "talk";
  const recent = activity.lastT !== null && t - activity.lastT < THINK_TIMEOUT;
  if (recent && (activity.thinkingSince !== null || activity.tools > 0)) return "think";
  return blinking(t) ? "blink" : "idle";
}

// Mouth frame while talking: alternate open/closed every 0.18 s (static when
// motion is reduced).
export function talkFrame(t, reduced = false) {
  return reduced || Math.floor(t / 0.18) % 2 === 0 ? "talk" : "idle";
}

// { pose: "idle" | "typing" | "tap" | "sleepy", left, right } with paws true = down.
export function catPose(state, t, reduced = false) {
  const activity = state.activity;
  const last = activity.lastT ?? 0;
  if (t - last >= CAT_SLEEP_SECONDS) return { pose: "sleepy", left: true, right: true };
  const tap = activity.taps.findLast(time => time <= t);
  if (tap !== undefined && t - tap < TAP_LENGTH) return { pose: "tap", left: true, right: true };
  const busy = (activity.tools > 0 || activity.thinkingSince !== null) && t - last < THINK_TIMEOUT;
  if (busy || (tap !== undefined && t - tap < TYPING_AFTER_TAP)) {
    if (reduced) return { pose: "typing", left: true, right: false };
    const left = Math.floor(t / 0.15) % 2 === 0;
    return { pose: "typing", left, right: !left };
  }
  return { pose: "idle", left: false, right: false };
}
