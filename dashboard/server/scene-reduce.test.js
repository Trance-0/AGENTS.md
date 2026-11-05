import assert from "node:assert/strict";
import test from "node:test";
import { CHECKPOINT_EVERY, SceneTimeline, fold, initialState, reduce, talkSeconds } from "../public/scene/reduce.js";
import { avatarExpression, blinking, catPose, onPaidFallback, CAT_SLEEP_SECONDS } from "../public/scene/derive.js";
import { advanceTime } from "../public/player.js";

const widget = (id, extra = {}) => ({ id, type: "text", x: 0.1, y: 0.1, w: 0.3, h: 0.1, z: 100, props: { text: id, size: 28, color: "snow", align: "left", card: true }, ...extra });
let nextId = 0;
const ev = (t, fields) => ({ id: nextId++, recordingId: "r", ts: 1e12 + t * 1000, t, level: "info", msg: "event", ...fields });
const wev = (t, op, target, data) => ev(t, { kind: "widget", sv: 1, op, target, data, source: "admin" });
const act = (t, type, extra = {}) => ev(t, { kind: "log", source: "openclaw", openclawEvent: type, ...extra });

// Deterministic pseudo-random recording mixing widget ops, metrics, activity, chat, and plain logs.
function recording(count = 1200) {
  nextId = 0;
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const events = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    t += random() * 2;
    const roll = random();
    const id = `w${Math.floor(random() * 6)}`;
    if (roll < 0.15) events.push(wev(t, "create", id, { widget: widget(id, { x: Math.round(random() * 50) / 100 }) }));
    else if (roll < 0.25) events.push(wev(t, "update", id, { widget: widget(id, { z: Math.floor(random() * 200) }) }));
    else if (roll < 0.3) events.push(wev(t, "delete", id, {}));
    else if (roll < 0.35) events.push(wev(t, "metrics", "metrics", { values: { "cpa.codex.5h": { remainingPercent: Math.floor(random() * 100), resetAt: 1e12 + 9e6, accounts: 2, total: 3, updatedAt: 1e12 } } }));
    else if (roll < 0.6) events.push(act(t, ["model_start", "model_output", "tool_start", "tool_end", "agent_end"][Math.floor(random() * 5)], { provider: random() < 0.2 ? "openai" : "cpa" }));
    else if (roll < 0.7) events.push(ev(t, { kind: "chat", source: "viewer", msg: "hi" }));
    else events.push(ev(t, { kind: "log", source: "stream", msg: "log" }));
  }
  // An old clock step backwards: the timeline must still treat time as a prefix.
  events[600].t = events[599].t - 5;
  return events;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
  return value;
}

test("reduce applies widget ops, metrics, and host activity without mutating its input", () => {
  nextId = 0;
  let state = deepFreeze(initialState());
  state = reduce(state, wev(1, "create", "a", { widget: widget("a") }));
  state = reduce(deepFreeze(state), wev(2, "update", "a", { widget: widget("a", { x: 0.5 }) }));
  assert.equal(state.widgets.a.x, 0.5);
  state = reduce(deepFreeze(state), wev(3, "metrics", "metrics", { values: { "tokens.today": { tokens: 1200 } } }));
  assert.equal(state.metrics["tokens.today"].tokens, 1200);
  state = reduce(deepFreeze(state), act(4, "model_start"));
  assert.equal(state.activity.thinkingSince, 4);
  state = reduce(deepFreeze(state), act(5, "model_output", { provider: "cpa", msg: "x".repeat(90) }));
  assert.deepEqual([state.activity.thinkingSince, state.activity.talkUntil, state.activity.provider], [null, 10, "cpa"]);
  state = reduce(deepFreeze(state), wev(6, "delete", "a", {}));
  assert.deepEqual(state.widgets, {});
  const before = JSON.stringify(state);
  for (const ignored of [wev(7, "explode", "a", {}), { ...wev(7, "create", "b", { widget: widget("b") }), sv: 2 }, wev(7, "create", "c", { widget: widget("other") }), ev(7, { kind: "gift", msg: "x" }), act(7, "tool_start", { source: "astrbot" }), null]) {
    assert.equal(JSON.stringify(reduce(deepFreeze(state), ignored)), before, "unknown op/sv/kind, mismatched target, and relay activity are ignored");
  }
  assert.equal(talkSeconds({ msg: "OpenClaw activity recorded: openclaw/model_output — model cpa/x." }), 1.5);
  assert.equal(talkSeconds({ replyChars: 900 }), 10);
});

test("seeking from a checkpoint equals folding from zero at every probe time", () => {
  const events = recording();
  const timeline = new SceneTimeline(events);
  assert.equal(timeline.checkpoints.length, Math.floor(events.length / CHECKPOINT_EVERY) + 1);
  const end = timeline.times.at(-1);
  // Random-order probes force both checkpoint restores and cursor fold-forward.
  const probes = [end, 0, end / 2, end / 3, end * 0.9, 1, end * 0.25, events[600].t, events[599].t + 0.001, end + 10];
  for (const t of probes) {
    const effective = [];
    let max = 0;
    for (const event of events) { max = Math.max(max, event.t); if (max > t) break; effective.push(event); }
    assert.deepEqual(timeline.stateAt(t), fold(events, t), `state at ${t}`);
    assert.deepEqual(timeline.stateAt(t), fold(effective), "fold over the visible prefix");
  }
  // Live: pushing events one at a time gives the same tail as a bulk load.
  const live = new SceneTimeline();
  for (const event of events) live.push(event);
  assert.deepEqual(live.stateAt(Infinity), timeline.stateAt(Infinity));
});

test("playback rate does not change the state or derived pictures at a given time", () => {
  const events = recording(800);
  const direct = new SceneTimeline(events);
  const end = direct.times.at(-1);
  for (const rate of [0.25, 0.5, 1, 2]) {
    const ticking = new SceneTimeline(events);
    let time = 0;
    while (time < end) {
      time = advanceTime(time, 0.2, rate, end);
      const state = ticking.stateAt(time);
      const expected = direct.stateAt(time);
      assert.deepEqual(state, expected, `rate ${rate} at ${time}`);
      assert.equal(avatarExpression(state, time), avatarExpression(expected, time));
      assert.deepEqual(catPose(state, time), catPose(expected, time));
    }
  }
});

test("avatar expressions: talk, think, blink, idle, and sleepy on the paid fallback", () => {
  nextId = 0;
  const events = [act(10, "model_start"), act(12, "model_output", { provider: "cpa", msg: "y".repeat(54) }), act(20, "tool_start"), act(21, "tool_end"), act(40, "model_output", { provider: "openai" }), act(60, "model_output", { provider: "cpa" })];
  const timeline = new SceneTimeline(events);
  const at = t => avatarExpression(timeline.stateAt(t), t);
  assert.equal(at(11), "think", "model_start until output");
  assert.equal(at(13), "talk", "3 s of talking for a 54-character reply");
  assert.equal(at(20.5), "think", "a running tool");
  assert.ok(["idle", "blink"].includes(at(30)));
  assert.equal(at(45), "sleepy", "latest host model_output came from the paid openai provider");
  assert.equal(at(65), "idle", "back to normal once CPA serves again");
  const blinks = Array.from({ length: 4200 }, (_, i) => blinking(i / 100)).filter(Boolean).length;
  assert.ok(blinks >= 120 && blinks <= 180, `about one 0.16 s blink every 4.2 s (${blinks} samples)`);
  const exhausted = reduce(timeline.stateAt(70), wev(71, "metrics", "metrics", { values: { "cpa.codex.week": { remainingPercent: 0, accounts: 2, total: 2 } } }));
  assert.equal(onPaidFallback(exhausted), true, "a pooled Codex window at 0% is also the paid fallback");
  assert.equal(avatarExpression(exhausted, 72), "sleepy");
});

test("cat paws follow tool and output activity and the cat sleeps after 5 idle minutes", () => {
  nextId = 0;
  const timeline = new SceneTimeline([act(5, "tool_start"), act(9, "tool_end"), act(30, "model_output")]);
  const pose = (t, reduced) => catPose(timeline.stateAt(t), t, reduced);
  assert.equal(pose(5.1).pose, "tap");
  assert.equal(pose(6).pose, "typing");
  assert.notDeepEqual(pose(6.0), pose(6.15), "paws alternate while typing");
  assert.deepEqual(pose(6.0, true), pose(6.15, true), "reduced motion holds a static typing pose");
  assert.equal(pose(15).pose, "idle");
  assert.equal(pose(30 + CAT_SLEEP_SECONDS - 1).pose, "idle");
  assert.equal(pose(30 + CAT_SLEEP_SECONDS).pose, "sleepy");
  assert.equal(catPose(initialState(), CAT_SLEEP_SECONDS + 1).pose, "sleepy", "a stream with no activity dozes off too");
});
