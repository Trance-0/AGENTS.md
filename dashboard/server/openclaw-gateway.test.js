import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGatewayClient } from "./openclaw-gateway.js";

class FakeSocket extends EventTarget {
  constructor() { super(); queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ event: "connect.challenge", payload: { nonce: "challenge" } }) }))); }
  send(raw) {
    const message = JSON.parse(raw);
    if (message.method === "connect") {
      const p = message.params;
      const payload = ["v3", p.device.id, "gateway-client", "backend", "operator", p.scopes.join(","), p.device.signedAt, p.auth.token, "challenge", "node", ""].join("|");
      const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(p.device.publicKey, "base64url")]), format: "der", type: "spki" });
      assert.ok(crypto.verify(null, Buffer.from(payload), pub, Buffer.from(p.device.signature, "base64url")));
      assert.ok(p.scopes.includes("operator.read")); assert.ok(p.scopes.includes("operator.write"));
    }
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "res", id: message.id, ok: true, payload: message.method === "connect" ? {} : { jobs: [] } }) })));
  }
  close() {}
}
test("gateway client signs challenge with a persistent private device identity", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-device-")), identityFile = path.join(dir, "device.json");
  try {
    const call = createGatewayClient({ endpoint: "http://127.0.0.1:1", token: "fixture-token", identityFile, WebSocketImpl: FakeSocket });
    assert.deepEqual(await call("cron.list"), { jobs: [] }); const before = fs.readFileSync(identityFile, "utf8");
    await call("cron.list"); assert.equal(fs.readFileSync(identityFile, "utf8"), before); assert.equal(fs.statSync(identityFile).mode & 0o777, 0o600);
    await assert.rejects(createGatewayClient({ endpoint: "http://127.0.0.1", token: "", identityFile })("cron.list"), { status: 503 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
