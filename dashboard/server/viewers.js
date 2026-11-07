import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export class Viewers {
  constructor(secret, secure) {
    this.secret = secret;
    this.secure = secure;
    this.connections = new Map();
  }

  identify(req, res, next) {
    const value = (req.headers.cookie || "").split(";").map(part => part.trim()).find(part => part.startsWith("dashboard.viewer="))?.slice("dashboard.viewer=".length);
    const [id, signature = ""] = (value || "").split(".");
    const sign = value => createHmac("sha256", this.secret).update(value).digest("hex");
    const expected = sign(id || "");
    const valid = /^[a-f0-9-]{36}$/.test(id || "") && /^[a-f0-9]{64}$/.test(signature) && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    req.viewerId = valid ? id : randomUUID();
    if (!valid) res.cookie("dashboard.viewer", `${req.viewerId}.${sign(req.viewerId)}`, { httpOnly: true, secure: this.secure, sameSite: "lax", path: "/" });
    next();
  }

  get count() { return this.connections.size; }

  connect(id) {
    this.connections.set(id, (this.connections.get(id) || 0) + 1);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      const remaining = this.connections.get(id) - 1;
      if (remaining) this.connections.set(id, remaining);
      else this.connections.delete(id);
    };
  }
}
