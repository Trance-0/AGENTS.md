import assert from "node:assert/strict";
import test from "node:test";
import { GROUPS, groupsFor, registerPanel, snapshot, tabsOf } from "./registry.js";

test("panels group into ordered sidebar pages with tab metadata", async () => {
  registerPanel({ id: "zeta", title: "Zeta", group: "usage", order: 30 });
  registerPanel({ id: "alpha", title: "Alpha", group: "usage", order: 10, tabs: [{ id: "alpha-one", title: "One" }, { id: "alpha-two", title: "Two" }] });
  registerPanel({ id: "secret", title: "Secret", group: "openclaw", adminOnly: true });
  registerPanel({ id: "loose", title: "Loose" });
  assert.throws(() => registerPanel({ id: "bad", title: "Bad", group: "nowhere" }), /unknown group nowhere/);
  assert.throws(() => registerPanel({ id: "bad", title: "Bad", group: "usage", tabs: [{ id: "Bad Tab", title: "x" }] }), /valid ID/);
  assert.deepEqual(GROUPS.map(group => group.id), ["live", "openclaw", "usage", "adapters", "canvas", "builds", "settings"]);
  const member = await snapshot({ isAdmin: false });
  assert.deepEqual(member.map(panel => panel.id), ["alpha", "zeta", "loose"], "sorted by order, admin-only hidden");
  assert.deepEqual(member.find(panel => panel.id === "alpha").tabs, [{ id: "alpha-one", title: "One" }, { id: "alpha-two", title: "Two" }]);
  assert.deepEqual(member.find(panel => panel.id === "zeta").tabs, [{ id: "zeta", title: "Zeta" }], "a panel without tabs contributes one");
  assert.equal(member.find(panel => panel.id === "loose").group, "adapters", "ungrouped panels land in Adapters");
  assert.deepEqual(groupsFor(member).map(group => group.id), ["usage", "adapters"]);
  const admin = await snapshot({ isAdmin: true });
  assert.deepEqual(groupsFor(admin).map(group => group.id), ["openclaw", "usage", "adapters"]);
  assert.deepEqual(tabsOf({ id: "x", title: "X", tabTitle: "Short" }), [{ id: "x", title: "Short" }]);
  for (const panel of admin) assert.ok(!("data" in panel) && !("run" in panel));
});
