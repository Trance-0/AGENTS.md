import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { OpenClawTasks, mountOpenClawTasks, taskHash } from "./openclaw-tasks.js";

const job = id => ({ id, name: `Task ${id}`, enabled: false, schedule: { kind: "every", everyMs: 60000 }, sessionTarget: "isolated", wakeMode: "now", payload: { kind: "agentTurn", message: "A private prompt", model: "example/model" }, state: {} });
test("all jobs are paginated including disabled jobs; runtime changes do not invalidate edits", async () => {
  const calls = [], one = job("one"), two = job("two");
  const tasks = new OpenClawTasks(async (method, args) => {
    calls.push([method, args]);
    return args.offset === 0 ? { jobs: [one], hasMore: true, nextOffset: 1 } : { jobs: [two], hasMore: false };
  });
  const found = await tasks.list(); assert.equal(found.length, 2); assert.equal(calls[0][1].includeDisabled, true); assert.equal(calls[1][1].offset, 1);
  assert.equal(taskHash(one), taskHash({ ...one, state: { lastRunAtMs: 123 } }));
  assert.notEqual(taskHash(one), taskHash({ ...one, enabled: true }));
});
test("task edits reject stale snapshots, read-only injection and serialize competing mutations", async () => {
  let current = job("one"); const calls = [];
  const tasks = new OpenClawTasks(async (method, args) => {
    if (method === "cron.list") return { jobs: [current] };
    calls.push(method); if (method === "cron.update") current = { ...current, ...args.patch }; return current;
  });
  const baseHash = taskHash(current);
  const results = await Promise.allSettled([
    tasks.mutate("update", "one", { baseHash, task: { name: "Changed" } }),
    tasks.mutate("update", "one", { baseHash, task: { name: "Stale" } }),
  ]);
  assert.equal(results[0].status, "fulfilled"); assert.equal(results[1].reason.status, 409); assert.deepEqual(calls, ["cron.update"]);
  await assert.rejects(tasks.mutate("update", "one", { baseHash: taskHash(current), task: { state: { runningAtMs: 0 } } }), /read-only/);
  await assert.rejects(tasks.mutate("update", "missing", { baseHash, task: {} }), { status: 404 });
});
test("tasks are admin-only and every mutation requires CSRF; disabled settings block reads", async () => {
  let enabled = true, mutations = 0;
  const app = express();
  const auth = (req, res, next) => req.get("x-user") ? next() : res.sendStatus(401);
  const admin = (req, res, next) => req.get("x-user") === "admin" ? next() : res.sendStatus(403);
  const csrf = (req, res, next) => req.get("x-dashboard-request") === "1" ? next() : res.sendStatus(403);
  mountOpenClawTasks(app, { list: async () => [job("one")], mutate: async () => { mutations++; return { ok: true }; } }, { requireAuth: auth, requireAdmin: admin, requireCsrf: csrf, isEnabled: () => enabled });
  const server = app.listen(0, "127.0.0.1"); await new Promise(r => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}/api/admin/openclaw-tasks`;
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { "x-user": "viewer" } })).status, 403);
    for (const method of ["POST", "PUT", "DELETE"]) {
      assert.equal((await fetch(url + (method === "POST" ? "" : "/one"), { method, headers: { "x-user": "admin", "content-type": "application/json" }, body: "{}" })).status, 403);
    }
    const result = await fetch(url + "/one", { method: "PUT", headers: { "x-user": "admin", "x-dashboard-request": "1", "content-type": "application/json" }, body: "{}" }); assert.equal(result.status, 200); assert.equal(mutations, 1);
    enabled = false; assert.equal((await fetch(url, { headers: { "x-user": "admin" } })).status, 404);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
