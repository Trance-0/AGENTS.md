import assert from "node:assert/strict";
import test from "node:test";
import { CONTROLS_IDLE_MS, CONTROLS_LEAVE_MS, PLAYBACK_RATES, advanceTime, controlsShouldHide, formatRate, normalizeRate, stepRate } from "../public/player.js";

test("playback rates normalize stored values and step within the offered list", () => {
  assert.deepEqual(PLAYBACK_RATES, [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]);
  assert.equal(normalizeRate("1.5"), 1.5);
  assert.equal(normalizeRate(0.25), 0.25);
  for (const invalid of [null, undefined, "", "fast", 3, 0, -1, NaN, "1.1"]) assert.equal(normalizeRate(invalid), 1);
  assert.equal(stepRate(1, 1), 1.25);
  assert.equal(stepRate(1, -1), 0.75);
  assert.equal(stepRate(2, 1), 2);
  assert.equal(stepRate(0.25, -1), 0.25);
  assert.equal(stepRate("bogus", 1), 1.25);
  assert.equal(formatRate(0.5), "0.5x");
});

test("replay time advances by wall-clock elapsed times the rate and clamps to the recording", () => {
  assert.equal(advanceTime(10, 1, 1, 100), 11);
  assert.equal(advanceTime(10, 1, 2, 100), 12);
  assert.equal(advanceTime(10, 2, 0.25, 100), 10.5);
  assert.equal(advanceTime(99, 1, 2, 100), 100);
  assert.equal(advanceTime(10, -5, 2, 100), 10);
  assert.equal(advanceTime(10, 1, 7, 100), 11, "unsupported rates fall back to 1x");
  // Events at t <= time become visible, so 2x reaches the event at 20 s after 5 s of wall clock.
  let time = 10;
  for (let tick = 0; tick < 25; tick++) time = advanceTime(time, 0.2, 2, 100);
  assert.ok(Math.abs(time - 20) < 1e-9);
});

test("controls auto-hide only while playing and never over a menu, keyboard focus, or scrub", () => {
  const playing = { playing: true, pointerInside: true, idleMs: CONTROLS_IDLE_MS };
  assert.equal(controlsShouldHide(playing), true);
  assert.equal(controlsShouldHide({ ...playing, idleMs: CONTROLS_IDLE_MS - 1 }), false);
  assert.equal(controlsShouldHide({ ...playing, playing: false, idleMs: 60000 }), false);
  assert.equal(controlsShouldHide({ ...playing, menuOpen: true }), false);
  assert.equal(controlsShouldHide({ ...playing, keyboardFocus: true }), false);
  assert.equal(controlsShouldHide({ ...playing, scrubbing: true }), false);
  assert.equal(controlsShouldHide({ playing: true, pointerInside: false, idleMs: CONTROLS_LEAVE_MS }), true);
  assert.equal(controlsShouldHide({ playing: true, pointerInside: false, idleMs: CONTROLS_LEAVE_MS - 1 }), false);
  assert.ok(CONTROLS_LEAVE_MS < CONTROLS_IDLE_MS);
});

test("chat moderation removes the live copy of a deleted chat message", async () => {
  const { applyModeration, isChat } = await import("../public/player.js");
  const events = [{ id: 1, kind: "chat", msg: "bad", author: "A" }, { id: 2, kind: "log", msg: "x" }];
  applyModeration(events, { id: 3, kind: "log", moderation: { op: "chat_delete", target: 2 } });
  assert.equal(events[1].deleted, undefined, "only chat messages are removed");
  applyModeration(events, { id: 4, kind: "log", moderation: { op: "chat_delete", target: 1 } });
  assert.deepEqual([events[0].msg, events[0].author, events.filter(isChat).length], ["", undefined, 0]);
});
