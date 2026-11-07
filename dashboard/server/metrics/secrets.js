import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const fail = message => Object.assign(new Error(`CPA settings unavailable: dashboard/metrics encryption — ${message}.`), { status: 503 });

export class SecretStore {
  constructor(directory, keyFile) {
    this.file = path.join(directory, "cpa-credential.enc.json");
    this.keyFile = keyFile;
  }
  key() {
    let key;
    try { key = fs.readFileSync(this.keyFile); } catch { throw fail("encryption key file is not available"); }
    if (key.length !== 32) throw fail("encryption key must contain exactly 32 bytes");
    return key;
  }
  read() {
    if (!fs.existsSync(this.file)) return null;
    try {
      const envelope = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const decipher = createDecipheriv("aes-256-gcm", this.key(), Buffer.from(envelope.iv, "base64"));
      decipher.setAAD(Buffer.from("agent-dashboard:cpa:v1"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8"));
    } catch { throw fail("stored credential could not be authenticated; restore the matching encryption key"); }
  }
  save(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    cipher.setAAD(Buffer.from("agent-dashboard:cpa:v1"));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    const envelope = { version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(envelope), { mode: 0o600 });
    fs.renameSync(this.file + ".tmp", this.file);
  }
  remove() { fs.rmSync(this.file, { force: true }); }
  view() {
    const value = this.read();
    let encryptionReady = true;
    try { this.key(); } catch { encryptionReady = false; }
    return { configured: !!value, endpoint: value?.endpoint || "https://cpa.trance-0.com", encryptionReady };
  }
}
