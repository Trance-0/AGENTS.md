import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";

import { SubscriptionStore, renderTemplate, defaults, normalize, view } from "./metrics/subscriptions.js";
import { detectResetFields, readResetState, resolveMapping } from "./metrics/reset-fields.js";
import { effective5h, pool5h, isDepleted, nextAvailable, SubscriptionMonitor } from "./metrics/subscription-monitor.js";
import { buildBarkUrl, maskKey } from "./metrics/bark.js";

const window = (className, remainingPercent, resetsAt = null) => ({ label: className, remainingPercent, resetsAt, windowSeconds: className === "fiveHour" ? 18000 : 604800 });
const account = (id, fiveHour, weekly) => ({ id, provider: "codex", label: `codex account ${id}`, windows: [window("fiveHour", fiveHour), window("week", weekly)], reset: {} });

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-subscription-"));
  const keyFile = path.join(directory, "key"); fs.writeFileSync(keyFile, randomBytes(32), { mode: 0o400 });
  return { directory, keyFile, close: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test("subscription config is encrypted at rest and round-trips", () => {
  const f = fixture();
  try {
    const store = new SubscriptionStore(f.directory, f.keyFile);
    store.save({ devices: [{ id: "", label: "iPhone", key: "super-secret-bark-key", enabled: true }], types: { depleted: { enabled: true, title: "", body: "" } } });
    const serialized = fs.readFileSync(store.file, "utf8");
    assert.ok(!serialized.includes("super-secret-bark-key"));
    assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
    assert.equal(store.read().devices[0].key, "super-secret-bark-key");
  } finally { f.close(); }
});

test("view() masks device keys and exposes stable ids only", () => {
  const f = fixture();
  try {
    const store = new SubscriptionStore(f.directory, f.keyFile);
    store.save({ devices: [{ label: "iPhone", key: "k1", enabled: true }], types: {} });
    const seen = view(store.read());
    assert.equal(seen.devices.length, 1);
    assert.equal(seen.devices[0].id.length, 12);
    assert.equal(seen.devices[0].label, "iPhone");
    assert.ok(!JSON.stringify(seen).includes("k1"));
    assert.equal(store.read().devices[0].key, "k1", "the server-side document still holds the real key");
  } finally { f.close(); }
});

test("a blank device key keeps the stored key matched by id", () => {
  const f = fixture();
  try {
    const store = new SubscriptionStore(f.directory, f.keyFile);
    store.save({ devices: [{ label: "iPhone", key: "keep-me", enabled: true }], types: {} });
    const id = store.read().devices[0].id;
    store.save({ devices: [{ id, label: "iPhone (renamed)", key: "", enabled: true }], types: {} });
    const after = store.read();
    assert.equal(after.devices.length, 1);
    assert.equal(after.devices[0].key, "keep-me");
    assert.equal(after.devices[0].label, "iPhone (renamed)");
    // A new device with no key and no matching id is dropped.
    store.save({ devices: [{ id: "", label: "Ghost", key: "", enabled: true }], types: {} });
    assert.equal(store.read().devices.length, 0);
  } finally { f.close(); }
});

test("renderTemplate substitutes placeholders and drops empty lines", () => {
  assert.equal(renderTemplate("Codex <account>\npool <pool5h>%", { account: "codex account 2", pool5h: "400" }), "Codex codex account 2\npool 400%");
  assert.equal(renderTemplate("title\n<account>\nbody", {}), "title\nbody");
  assert.equal(renderTemplate("keep <unknown_token>", {}), "keep <unknown_token>");
});

test("normalize enforces one-line device keys and valid level", () => {
  assert.throws(() => normalize({ devices: [{ key: "a\nb" }] }), /one line/);
  assert.equal(normalize({ level: "nope" }).level, "passive");
  assert.equal(defaults().level, "passive");
});

test("reset field detection and state read", () => {
  const mapping = detectResetFields([{ reset: { reset_ticked: false, reset_requested: true, reset_expires_at: "2026-11-20T00:00:00Z", reset_arrived_at: 1764028800 } }]);
  assert.equal(mapping.ticked, "reset_ticked");
  assert.equal(mapping.requested, "reset_requested");
  assert.equal(mapping.arrivedAt, "reset_arrived_at");
  assert.equal(mapping.expiresAt, "reset_expires_at");
  const state = readResetState({ reset: { reset_ticked: false, reset_requested: true, reset_expires_at: "2026-11-20T00:00:00Z", reset_arrived_at: 1764028800 } }, mapping);
  assert.equal(state.ticked, false);
  assert.equal(state.requested, true);
  assert.equal(state.arrivedAt, 1764028800000);
  assert.equal(state.expiresAt, Date.parse("2026-11-20T00:00:00Z"));
  assert.deepEqual(resolveMapping({ ticked: "a", requested: "b", arrivedAt: "c", expiresAt: "d" }, { ticked: "override" }), { ticked: "override", requested: "b", arrivedAt: "c", expiresAt: "d" });
});

test("effective 5h is capped by weekly; pool sums it across accounts", () => {
  assert.equal(effective5h(account("a", 100, 5)), 5, "5h 100% beside weekly 5% counts 5%");
  assert.equal(effective5h(account("a", 20, 100)), 20);
  assert.equal(effective5h(account("a", null, 40)), 40);
  const snapshot = { accounts: [account("a", 100, 100), account("b", 100, 100), account("c", 100, 100), account("d", 100, 100)] };
  assert.equal(pool5h(snapshot).percent, 400, "four full accounts read 400%");
  assert.equal(pool5h({ accounts: [account("a", 100, 5)] }).percent, 5);
  assert.equal(isDepleted(account("a", 0, 100)), true);
  assert.equal(isDepleted(account("a", 100, 100)), false);
  const soon = Date.now() + 1000; const later = Date.now() + 2000;
  assert.equal(nextAvailable({ windows: [window("fiveHour", 0, soon), window("week", 100, later)] }), soon);
});

test("monitor pushes newCredits on a depleted → available transition", async () => {
  let snapshot = { updatedAt: Date.now(), accounts: [account("a", 0, 100)] };
  const pushes = [];
  const monitor = new SubscriptionMonitor({
    subscriptions: { read: () => ({ devices: [{ id: "x", label: "i", key: "k", enabled: true }], types: { newCredits: { enabled: true, title: "credits", body: "<account> <pool5h>" }, depleted: { enabled: true, title: "gone", body: "" }, pool5h: { enabled: false, title: "", body: "" }, resetArrived: { enabled: false, title: "", body: "" }, resetRequested: { enabled: false, title: "", body: "" } }, level: "passive", group: "g" }) },
    quota: { refresh: async () => {}, snapshot: () => snapshot },
    secrets: { read: () => ({}) },
    isEnabled: async () => true,
    push: async (key, title, body) => { pushes.push({ title, body }); return { key: "masked", ok: true, status: 200 }; },
  });
  assert.deepEqual(await monitor.tick(), []);
  snapshot = { updatedAt: Date.now(), accounts: [account("a", 100, 100)] };
  await monitor.tick();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, "credits");
  assert.match(pushes[0].body, /codex account a 100/);
});

test("bark url and key masking never expose the device key", () => {
  const url = buildBarkUrl("secret-key", "Title", "Body", { level: "passive", group: "g" });
  assert.match(url, /^https:\/\/api\.day\.app\/secret-key\/Title\/Body\?level=passive&group=g$/);
  assert.equal(maskKey("secret-key"), "secr…");
});
