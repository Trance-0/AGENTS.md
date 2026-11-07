// Deterministic scene state: state(t) = fold(reduce, initialState(), events
// with t_e <= t, in id order). Pure ES module shared by the browser renderer
// and the server (live-scene tracking): no DOM, clock, or randomness.
//
// reduce() never mutates its input; unchanged branches are shared, so stored
// checkpoints stay valid without cloning. Unknown kinds, ops, and scene schema
// versions are ignored (they still show as log lines), never errors.
import { SCENE_SV } from "./schema.js";

export const CHECKPOINT_EVERY = 250;
const MAX_TAPS = 6;
const HOST_SOURCES = new Set(["openclaw"]);

export function initialState() {
  return {
    widgets: {},
    metrics: {},
    activity: { lastT: null, thinkingSince: null, tools: 0, talkUntil: null, provider: null, taps: [] },
    // Forced avatar expression { expression, until } (recording time), or null.
    avatar: null,
  };
}

// Seconds of mouth movement for one reply: about 18 characters per second.
export function talkSeconds(event) {
  const chars = Number.isSafeInteger(event.replyChars) ? event.replyChars
    : typeof event.msg === "string" && !/^OpenClaw (activity )?\w+:/.test(event.msg) ? event.msg.length : 0;
  return Math.min(10, Math.max(1.5, chars / 18));
}

function reduceActivity(activity, event, t) {
  const type = event.openclawEvent;
  const next = { ...activity, lastT: t };
  if (type === "model_start") next.thinkingSince = t;
  else if (type === "model_output") {
    next.thinkingSince = null;
    next.talkUntil = t + talkSeconds(event);
    if (typeof event.provider === "string") next.provider = event.provider;
  } else if (type === "tool_start") next.tools = Math.min(8, activity.tools + 1);
  else if (type === "tool_end") next.tools = Math.max(0, activity.tools - 1);
  else if (type === "agent_end") { next.thinkingSince = null; next.tools = 0; }
  if (type === "tool_start" || type === "tool_end" || type === "model_output") next.taps = [...activity.taps, t].slice(-MAX_TAPS);
  return next;
}

function reduceWidget(state, event, t) {
  const data = event.data;
  if (!data || typeof data !== "object") return state;
  if (event.op === "create" || event.op === "update") {
    const widget = data.widget;
    if (!widget || typeof widget.id !== "string" || widget.id !== event.target) return state;
    return { ...state, widgets: { ...state.widgets, [widget.id]: widget } };
  }
  if (event.op === "delete") {
    if (!(event.target in state.widgets)) return state;
    const widgets = { ...state.widgets };
    delete widgets[event.target];
    return { ...state, widgets };
  }
  if (event.op === "avatar") {
    if (data.expression === "auto") return { ...state, avatar: null };
    if (typeof data.expression !== "string" || !Number.isFinite(data.seconds)) return state;
    return { ...state, avatar: { expression: data.expression, until: t + data.seconds } };
  }
  if (event.op === "metrics") {
    const values = data.values;
    if (!values || typeof values !== "object") return state;
    return { ...state, metrics: { ...state.metrics, ...values } };
  }
  return state;
}

export function reduce(state, event, t) {
  if (!event || typeof event !== "object") return state;
  if (t === undefined) t = event.t;
  if (event.kind === "widget") return event.sv === SCENE_SV ? reduceWidget(state, event, t) : state;
  if (event.kind === "log" && typeof event.openclawEvent === "string" && HOST_SOURCES.has(event.source)) {
    return { ...state, activity: reduceActivity(state.activity, event, t) };
  }
  return state;
}

export function fold(events, t = Infinity) {
  let state = initialState();
  let effective = 0;
  for (const event of events) {
    effective = Math.max(effective, Number.isFinite(event.t) ? event.t : 0);
    if (effective > t) break;
    state = reduce(state, event, effective);
  }
  return state;
}

// Client-side checkpoints for seeking (design 2.5, decision 9: no server
// snapshots). Event time is the running maximum of `t`, so the visible set is
// always a prefix even if an old recording's clock stepped backwards.
export class SceneTimeline {
  constructor(events = []) {
    this.events = [];
    this.times = [];
    this.tail = initialState();
    this.checkpoints = [this.tail];
    this.cursor = { count: 0, state: this.tail };
    for (const event of events) this.push(event);
  }

  push(event) {
    const t = Math.max(this.times.at(-1) ?? 0, Number.isFinite(event?.t) ? event.t : 0);
    this.events.push(event);
    this.times.push(t);
    this.tail = reduce(this.tail, event, t);
    if (this.events.length % CHECKPOINT_EVERY === 0) this.checkpoints.push(this.tail);
  }

  // Number of events with effective time <= t (binary search).
  countAt(t) {
    let low = 0, high = this.times.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.times[middle] <= t) low = middle + 1; else high = middle;
    }
    return low;
  }

  stateAt(t) {
    const count = this.countAt(t);
    if (count === this.events.length) return this.tail;
    // Fold forward from the cursor when it is close behind; otherwise restore
    // the nearest checkpoint at or before the target.
    let { count: from, state } = this.cursor;
    if (from > count || count - from > CHECKPOINT_EVERY) {
      from = Math.floor(count / CHECKPOINT_EVERY) * CHECKPOINT_EVERY;
      state = this.checkpoints[from / CHECKPOINT_EVERY];
    }
    for (let index = from; index < count; index++) state = reduce(state, this.events[index], this.times[index]);
    this.cursor = { count, state };
    return state;
  }
}
