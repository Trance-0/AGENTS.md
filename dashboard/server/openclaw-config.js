// OpenClaw config editor backing store.
//
// The live `openclaw.json` sits in a dedicated host directory. OpenClaw mounts
// that directory read-only (it can read but never rewrite its own config); the
// dashboard mounts it read-write so administrators can edit it from the
// browser. OpenClaw hot-reloads the file when it changes.
//
// Secret-looking string values are masked before the config reaches the
// browser and restored from the current file on save, so a browser round trip
// never needs (or learns) a credential. Env SecretRefs ({source, id}) are
// ordinary objects and stay editable.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const REDACTED = "__dashboard_redacted__";
const SECRET_KEY = /(token|secret|password|passwd|apikey|api_key|cookie|credential|privatekey|private_key)$/i;
const MAX_BYTES = 512 * 1024;

const sha256 = text => crypto.createHash("sha256").update(text).digest("hex");
const fail = (status, message) => Object.assign(new Error(message), { status });

export function redact(value, key = "") {
  if (Array.isArray(value)) return value.map(item => redact(item, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  if (typeof value === "string" && value && SECRET_KEY.test(key)) return REDACTED;
  return value;
}

// Replace every REDACTED placeholder with the value stored at the same path in
// the current file. A placeholder with no stored original is rejected rather
// than written literally.
export function restore(next, current, trail = "") {
  if (next === REDACTED) {
    if (typeof current !== "string") throw fail(400, `Config cannot be saved: dashboard/openclaw config — masked value at ${trail || "(root)"} has no stored original; enter a value or an env SecretRef.`);
    return current;
  }
  if (Array.isArray(next)) return next.map((item, i) => restore(item, Array.isArray(current) ? current[i] : undefined, `${trail}[${i}]`));
  if (next && typeof next === "object") {
    const base = current && typeof current === "object" && !Array.isArray(current) ? current : {};
    return Object.fromEntries(Object.entries(next).map(([k, v]) => [k, restore(v, base[k], trail ? `${trail}.${k}` : k)]));
  }
  return next;
}

export class OpenClawConfigStore {
  constructor({ file, backupDir, keep = 20 }) {
    Object.assign(this, { file, backupDir, keep });
  }

  read() {
    let text;
    try { text = fs.readFileSync(this.file, "utf8"); }
    catch (error) { throw fail(503, `Config unavailable: dashboard/openclaw config — shared config file cannot be read (${error.code || "unknown"}).`); }
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { throw fail(500, "Config unavailable: dashboard/openclaw config — the live file is not valid JSON; fix it on the host."); }
    return { text, config: parsed, hash: sha256(text), modifiedAt: fs.statSync(this.file).mtime.toISOString() };
  }

  view() {
    const { config, hash, modifiedAt } = this.read();
    return { config: redact(config), hash, modifiedAt };
  }

  save(text, baseHash) {
    if (typeof text !== "string" || !text.trim()) throw fail(400, "Config cannot be saved: dashboard/openclaw config — the request has no config text.");
    if (Buffer.byteLength(text) > MAX_BYTES) throw fail(413, "Config cannot be saved: dashboard/openclaw config — config exceeds 512 KiB.");
    let next;
    try { next = JSON.parse(text); }
    catch (error) { throw fail(400, `Config cannot be saved: dashboard/openclaw config — invalid JSON (${error.message}).`); }
    if (!next || typeof next !== "object" || Array.isArray(next)) throw fail(400, "Config cannot be saved: dashboard/openclaw config — the top level must be a JSON object.");
    const current = this.read();
    if (baseHash !== current.hash) throw fail(409, "Config cannot be saved: dashboard/openclaw config — the file changed after it was loaded; reload and reapply the edit.");
    const merged = restore(next, current.config);
    const output = `${JSON.stringify(merged, null, 2)}\n`;
    if (output === current.text) return { ...this.view(), changed: false };

    fs.mkdirSync(this.backupDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[-:.]/g, "");
    fs.writeFileSync(path.join(this.backupDir, `openclaw-${stamp}-${current.hash.slice(0, 12)}.json`), current.text, { mode: 0o600 });
    const backups = fs.readdirSync(this.backupDir).filter(name => /^openclaw-.*\.json$/.test(name)).sort();
    for (const name of backups.slice(0, Math.max(0, backups.length - this.keep))) fs.rmSync(path.join(this.backupDir, name));

    // Same-directory temp file + rename: OpenClaw sees either the old or the new
    // file, never a partial write. The directory (not the file) is bind-mounted,
    // so the renamed inode is visible inside the OpenClaw container.
    const temp = path.join(path.dirname(this.file), `.openclaw.json.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
    try {
      fs.writeFileSync(temp, output, { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch (error) {
      fs.rmSync(temp, { force: true });
      throw fail(503, `Config cannot be saved: dashboard/openclaw config — shared config file is not writable (${error.code || "unknown"}).`);
    }
    return { ...this.view(), changed: true };
  }
}
