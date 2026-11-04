import assert from "node:assert/strict";
import test from "node:test";
import { hostReply } from "./gateway-response.js";

const completion = content => ({ id: "chatcmpl_example", choices: [{ message: { content }, finish_reason: "stop" }] });

test("gateway HTTP 200 error completions are rejected rather than recorded as host replies", () => {
  assert.throws(() => hostReply(completion('LLM request rejected: messages.1.content.0: Invalid `signature` in `thinking` block')), /stored thinking signature/);
  assert.throws(() => hostReply(completion("\u26a0\uFE0F API rate limit reached. Please try again later.")), /rate limit/);
  assert.throws(() => hostReply(completion("\u26a0\uFE0F Agent failed before reply: private error")), /provider failure/);
  assert.throws(() => hostReply({ error: { message: "secret" } }), /provider failure/);
  assert.throws(() => hostReply({ choices: [{ finish_reason: "error", message: { content: "failure" } }] }), /provider failure/);
  assert.throws(() => hostReply(completion(" ")), /no assistant text/);
  assert.deepEqual(hostReply(completion(" Hello viewers! ")), { text: "Hello viewers!", runId: "chatcmpl_example" });
  assert.equal(hostReply(completion("We discussed an invalid signature earlier; the stream is ready now.")).text.startsWith("We discussed"), true);
});
