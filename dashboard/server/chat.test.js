import assert from "node:assert/strict";
import test from "node:test";

test("chat records gateway-reported rejection as a warning, never a host answer", async t => {
  Object.assign(process.env, { OIDC_ISSUER: "https://issuer.example", OIDC_CLIENT_ID: "test", OIDC_CLIENT_SECRET: "test", SESSION_SECRET: "test", OPENCLAW_TOKEN: "test-token" });
  const { createChat } = await import("./chat.js");
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ choices: [{ message: { content: 'LLM request rejected: messages.1.content.0: Invalid `signature` in `thinking` block PRIVATE_DETAIL' } }] }), { status: 200 }));
  const events = [];
  const broadcast = { active: { id: "recording" }, publish(event) { events.push(event); return { id: events.length }; } };
  const send = createChat(broadcast);
  let status;
  send({ body: { message: "Hello" }, session: { user: { sub: "test-user", name: "Viewer" } } }, { status(code) { status = code; return this; }, json() {} });
  assert.equal(status, 202);
  for (let attempt = 0; attempt < 30 && !events.some(event => event.level === "warn"); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  const warnings = events.filter(event => event.level === "warn");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].msg, /stored thinking signature/);
  assert.ok(!events.some(event => event.msg.startsWith("LLM request rejected:")));
  assert.ok(!JSON.stringify(events).includes("PRIVATE_DETAIL"));
});
