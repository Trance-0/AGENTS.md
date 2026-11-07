import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const fail = (cause, status = 502) => Object.assign(new Error(`OpenClaw settings unavailable: dashboard/gateway connection — ${cause}.`), { status });

function deviceIdentity(file) {
  if (fs.existsSync(file)) {
    const identity = JSON.parse(fs.readFileSync(file, "utf8"));
    const publicKey = crypto.createPublicKey(identity.privateKey).export({ type: "spki", format: "der" }).subarray(-32);
    if (identity.publicKey !== publicKey.toString("base64url") || identity.id !== crypto.createHash("sha256").update(publicKey).digest("hex")) throw fail("stored device identity is inconsistent", 503);
    return identity;
  }
  const keys = crypto.generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const identity = { id: crypto.createHash("sha256").update(publicKey).digest("hex"), publicKey: publicKey.toString("base64url"), privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }) };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(identity), { mode: 0o600, flag: "wx" });
  return identity;
}

// A separate paired device belongs to the dashboard, never to a browser session.
export function createGatewayClient({ endpoint, token, identityFile, WebSocketImpl = globalThis.WebSocket, timeoutMs = 12000 }) {
  return (method, params = {}) => new Promise((resolve, reject) => {
    if (!token) return reject(fail("gateway credential is not configured", 503));
    let identity, socket;
    try {
      identity = deviceIdentity(identityFile);
      const url = new URL(endpoint); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocketImpl(url);
    } catch { return reject(fail("device identity or gateway endpoint could not be opened", 503)); }
    let done = false, connecting = false;
    const finish = (error, result) => {
      if (done) return; done = true; clearTimeout(timer);
      socket.close(); error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(fail("request timed out after 12 seconds")), timeoutMs);
    socket.addEventListener("error", () => finish(fail("WebSocket transport failed")));
    socket.addEventListener("close", () => finish(fail("gateway closed before the request completed")));
    socket.addEventListener("message", event => {
      let message; try { message = JSON.parse(event.data); } catch { return finish(fail("gateway returned malformed JSON")); }
      if (message.event === "connect.challenge" && !connecting) {
        connecting = true;
        const nonce = message.payload?.nonce;
        if (typeof nonce !== "string" || !nonce) return finish(fail("gateway challenge has no nonce"));
        const signedAt = Date.now(), scopes = ["operator.read", "operator.write", "operator.admin"];
        const payload = ["v3", identity.id, "gateway-client", "backend", "operator", scopes.join(","), String(signedAt), token, nonce, "node", ""].join("|");
        const signature = crypto.sign(null, Buffer.from(payload), identity.privateKey).toString("base64url");
        socket.send(JSON.stringify({ type: "req", id: "connect", method: "connect", params: {
          minProtocol: 3, maxProtocol: 3, client: { id: "gateway-client", displayName: "Agent Dashboard", version: "1", platform: "node", mode: "backend" },
          role: "operator", scopes, auth: { token }, device: { id: identity.id, publicKey: identity.publicKey, signature, signedAt, nonce },
        } }));
      }
      if (message.type !== "res") return;
      if (!message.ok) {
        const cause = String(message.error?.message || message.error?.code || "request rejected").replaceAll(token, "[redacted]").slice(0, 300);
        return finish(fail(cause, message.id === "connect" ? 503 : 400));
      }
      if (message.id === "connect") socket.send(JSON.stringify({ type: "req", id: "operation", method, params }));
      else if (message.id === "operation") finish(null, message.payload);
    });
  });
}
