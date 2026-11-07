import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OpenCodeRuntime } from "./runtime.js";

async function fixture(t, handler = () => undefined) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-bridge-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const credentialsFile = path.join(root, "credentials.json");
  await fs.writeFile(credentialsFile, JSON.stringify({ username: "test", password: "secret" }));
  const calls = [];
  const config = { url: "http://127.0.0.1:4096", credentialsFile, stateDir: root, cwd: "/workspace", pathMap: { "/container": "/workspace" } };
  const fetchImpl = async (url, options) => {
    const body = options.body && JSON.parse(options.body);
    const call = { route: url.pathname, method: options.method, body, directory: url.searchParams.get("directory") };
    calls.push(call);
    assert.equal(options.headers.authorization, `Basic ${Buffer.from("test:secret").toString("base64")}`);
    const result = await handler(call, calls);
    if (result instanceof Response) return result;
    return Response.json(result ?? (url.pathname === "/session" || url.pathname === "/session/ses_test" ? { id: "ses_test", directory: "/workspace" } : url.pathname === "/permission" ? [] : {}));
  };
  const runtime = new OpenCodeRuntime(config, { fetchImpl, pollMs: 1 });
  const ensure = extra => runtime.ensureSession({ sessionKey: "test", agent: "opencode", mode: "persistent", ...extra });
  return { runtime, calls, ensure, config, fetchImpl };
}

test("sessions persist across runtime restarts and translate container directories", async t => {
  const f = await fixture(t);
  const first = await f.ensure({ cwd: "/container" });
  const restarted = new OpenCodeRuntime(f.config, { fetchImpl: f.fetchImpl });
  const second = await restarted.ensureSession({ sessionKey: "test", agent: "opencode", cwd: "/workspace", mode: "persistent" });
  assert.equal(first.agentSessionId, second.agentSessionId);
  assert.equal(f.calls.filter(c => c.route === "/session" && c.method === "POST").length, 1);
  await assert.rejects(f.ensure({ cwd: "/elsewhere" }), /working directory changed/);
});

test("resuming uses the original server session and refuses a different directory", async t => {
  const f = await fixture(t);
  assert.equal((await f.ensure({ resumeSessionId: "ses_test" })).agentSessionId, "ses_test");
  assert.equal(f.calls.filter(c => c.method === "POST").length, 0);
  const other = await fixture(t, c => c.route === "/session/ses_test" ? { id: "ses_test", directory: "/other" } : undefined);
  await assert.rejects(other.ensure({ resumeSessionId: "ses_test" }), /different working directory/);
});

test("a multi-tool loop streams progress once and waits for the final response", async t => {
  let messageId, poll = 0;
  const f = await fixture(t, c => {
    if (c.route.endsWith("prompt_async")) { messageId = c.body.messageID; return new Response(null, { status: 204 }); }
    if (c.route === "/session/status") return { ses_test: { type: "busy" } };
    if (c.route.endsWith("/message")) {
      poll++;
      return [{ info: { role: "assistant", parentID: messageId, time: { completed: 1 }, finish: poll > 1 ? "stop" : "tool-calls" }, parts: [
        { id: "thought", type: "reasoning", text: "Checking" },
        { id: "tool", type: "tool", callID: "call1", tool: "read", state: { status: poll > 1 ? "completed" : "running" } },
        ...(poll > 1 ? [{ id: "answer", type: "text", text: "Verified" }] : []),
      ] }];
    }
  });
  const handle = await f.ensure();
  // No request is running at the start; the fake becomes busy after submission.
  const original = f.runtime.request.bind(f.runtime);
  let firstStatus = true;
  f.runtime.request = (route, opts) => route === "/session/status" && firstStatus ? (firstStatus = false, Promise.resolve({})) : original(route, opts);
  await f.runtime.setConfigOption({ handle, key: "model", value: "cpa/model" });
  await f.runtime.setConfigOption({ handle, key: "variant", value: "high" });
  const events = await Array.fromAsync(f.runtime.runTurn({ handle, text: "Verify", requestId: "r1", mode: "prompt" }));
  assert.equal(events.filter(e => e.stream === "thought").length, 1);
  assert.deepEqual(events.filter(e => e.type === "tool_call").map(e => e.status), ["running", "completed"]);
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.find(e => e.stream === "output").text, "Verified");
  assert.deepEqual(f.calls.find(c => c.route.endsWith("prompt_async")).body.model, { providerID: "cpa", modelID: "model" });
  assert.equal((await f.runtime.read("test")).active, undefined);
});

test("busy desktop sessions cannot receive a competing turn or be aborted", async t => {
  const f = await fixture(t, c => c.route === "/session/status" ? { ses_test: { type: "busy" } } : undefined);
  const handle = await f.ensure();
  await assert.rejects(Array.fromAsync(f.runtime.runTurn({ handle, text: "Competing", requestId: "r2" })), /already running/);
  assert.equal(f.calls.some(c => c.route.endsWith("/abort") || c.route.endsWith("prompt_async")), false);
});

test("provider failures abort the submitted turn and keep its session", async t => {
  let messageId;
  const f = await fixture(t, c => {
    if (c.route.endsWith("prompt_async")) { messageId = c.body.messageID; return new Response(null, { status: 204 }); }
    if (c.route.endsWith("/message")) return [{ info: { role: "assistant", parentID: messageId, error: { name: "APIError" } } }];
  });
  const handle = await f.ensure();
  await assert.rejects(Array.fromAsync(f.runtime.runTurn({ handle, text: "Check", requestId: "r3" })), /APIError/);
  assert.ok(f.calls.some(c => c.route.endsWith("/abort")));
  assert.equal(f.calls.some(c => c.method === "DELETE"), false);
});

test("close retains the transcript and old handles cannot control a new session", async t => {
  const f = await fixture(t); const handle = await f.ensure();
  await f.runtime.close({ handle });
  assert.equal((await f.runtime.read("test")).closed, true);
  await assert.rejects(f.runtime.getStatus({ handle }), /no longer matches/);
  assert.equal(f.calls.some(c => c.method === "DELETE"), false);
});

test("credentials stay out of HTTP failure messages", async t => {
  const f = await fixture(t, () => new Response("secret", { status: 401 }));
  const result = await f.runtime.doctor();
  assert.equal(result.ok, false); assert.match(result.message, /HTTP 401/); assert.doesNotMatch(result.message, /secret/);
});

test("unsupported controls and unsafe server URLs are rejected explicitly", async t => {
  const f = await fixture(t); const handle = await f.ensure();
  await assert.rejects(f.runtime.setConfigOption({ handle, key: "approval_policy", value: "allow" }), /unsupported session option/);
  await assert.rejects(f.runtime.setConfigOption({ handle, key: "timeout", value: "0" }), /positive number/);
  assert.throws(() => new OpenCodeRuntime({ ...f.config, url: "http://example.test" }), /require HTTPS/);
});

test("reconnecting to an active request does not submit its prompt twice", async t => {
  const f = await fixture(t, c => {
    if (c.route === "/session/status") return { ses_test: { type: "busy" } };
    if (c.route.endsWith("/message")) return [{ info: { role: "assistant", parentID: "msg_saved", finish: "stop", time: { completed: 1 } }, parts: [{ id: "answer", type: "text", text: "Recovered" }] }];
  });
  const handle = await f.ensure();
  await f.runtime.save("test", { ...(await f.runtime.read("test")), active: { requestId: "saved", messageId: "msg_saved", startedAt: Date.now() } });
  const restarted = new OpenCodeRuntime(f.config, { fetchImpl: f.fetchImpl, pollMs: 1 });
  const events = await Array.fromAsync(restarted.runTurn({ handle, text: "Do not duplicate", requestId: "saved" }));
  assert.equal(events.find(e => e.type === "text_delta").text, "Recovered");
  assert.equal(f.calls.some(c => c.route.endsWith("prompt_async")), false);
});

test("cancellation stops server work and preserves the resumable transcript", async t => {
  const controller = new AbortController();
  const f = await fixture(t, c => {
    if (c.route.endsWith("prompt_async")) return new Response(null, { status: 204 });
    if (c.route.endsWith("/message")) { controller.abort(); return []; }
  });
  const handle = await f.ensure();
  await assert.rejects(Array.fromAsync(f.runtime.runTurn({ handle, text: "Check", requestId: "cancel", signal: controller.signal })));
  assert.ok(f.calls.some(c => c.route.endsWith("/abort")));
  assert.equal((await f.runtime.read("test")).active, undefined);
  assert.equal(f.calls.some(c => c.method === "DELETE"), false);
});

test("an expired recovered turn is aborted without losing its history", async t => {
  const f = await fixture(t); const handle = await f.ensure();
  await f.runtime.save("test", { ...(await f.runtime.read("test")), timeout: 1, active: { requestId: "expired", messageId: "msg_saved", startedAt: Date.now() - 2000 } });
  await assert.rejects(Array.fromAsync(f.runtime.runTurn({ handle, text: "Check", requestId: "expired" })), /history is retained/);
  assert.ok(f.calls.some(c => c.route.endsWith("/abort")));
});
