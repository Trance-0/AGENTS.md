import assert from "node:assert/strict";
import test from "node:test";
import { Viewers } from "./viewers.js";

test("browser sessions share identity across tabs and disappear after their final connection", () => {
  const viewers = new Viewers("test-secret", true);
  const identify = cookie => {
    const request = { headers: { cookie } };
    let issued;
    viewers.identify(request, { cookie(name, value, options) { issued = `${name}=${value}`; assert.equal(options.httpOnly, true); assert.equal(options.secure, true); assert.equal(options.maxAge, undefined); } }, () => {});
    return { id: request.viewerId, cookie: issued };
  };
  const first = identify();
  const secondTab = identify(first.cookie);
  assert.equal(secondTab.id, first.id);
  assert.equal(secondTab.cookie, undefined);
  const separateBrowser = identify();
  assert.notEqual(first.id, separateBrowser.id);
  const closeFirst = viewers.connect(first.id);
  const closeTab = viewers.connect(secondTab.id);
  assert.equal(viewers.count, 1);
  const closeOther = viewers.connect(separateBrowser.id);
  assert.equal(viewers.count, 2);
  closeFirst(); closeFirst();
  assert.equal(viewers.count, 2);
  closeTab();
  assert.equal(viewers.count, 1);
  const reconnect = viewers.connect(first.id);
  assert.equal(viewers.count, 2);
  reconnect(); closeOther();
  assert.equal(viewers.count, 0);
  assert.notEqual(identify(first.cookie.slice(0, -1) + "!").id, first.id);
  assert.doesNotThrow(() => identify(`dashboard.viewer=${first.id}.${"界".repeat(64)}`));
});
