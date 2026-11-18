// Subscription configuration: Bark devices, per-alarm templates, and the reset
// field mapping. The whole document is encrypted at rest (AES-256-GCM) with the
// same master key as the CPA management credential, because Bark device keys
// are push credentials. The browser never sees a device key back.
import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { deviceId } from "./bark.js";

const fail = (status, message) => Object.assign(new Error(message), { status });
const AAD = Buffer.from("agent-dashboard:subscription:v1");

export const TYPE_IDS = ["depleted", "newCredits", "pool5h", "resetArrived", "resetRequested"];

export const TYPE_LABELS = {
  depleted: "Codex account depleted",
  newCredits: "Codex new credits arrived",
  pool5h: "5-hour pool status",
  resetArrived: "Reset arrived",
  resetRequested: "Reset requested",
};

export const TEMPLATE_KEYS = ["account", "provider", "reset", "expire", "pool5h", "week", "accounts", "time"];

function defaultTypes() {
  return {
    depleted: { enabled: false, title: "⚠️ Codex account depleted", body: "<account> is out of credits. Earliest next credits: <reset>. 5h pool now <pool5h>%." },
    newCredits: { enabled: false, title: "✅ Codex credits arrived", body: "<account> has new credits. 5h pool now <pool5h>%." },
    pool5h: { enabled: false, title: "Codex 5h pool", body: "5h pool <pool5h>% across <accounts> accounts · weekly <week>%." },
    resetArrived: { enabled: false, title: "🔁 Reset arrived", body: "Reset arrived on <account>: expires <expire>." },
    resetRequested: { enabled: false, title: "🔁 Reset requested", body: "Reset requested on <account> but the tick is missing; credits will change to the current 5h pool (<pool5h>%)." },
  };
}

export function defaults() {
  return {
    devices: [],
    types: defaultTypes(),
    resetFields: { ticked: "", requested: "", arrivedAt: "", expiresAt: "" },
    level: "passive",
    group: "agent-dashboard",
  };
}

// Render <placeholder> tokens. Unknown tokens are left verbatim so a typo stays
// visible; a known key with no value renders empty and its line is dropped.
export function renderTemplate(template, context) {
  return String(template ?? "")
    .replace(/<([a-z0-9_]+)>/g, (whole, key) => (TEMPLATE_KEYS.includes(key) ? String(context[key] ?? "") : whole))
    .split("\n")
    .filter(line => line.trim() !== "")
    .join("\n")
    .trim();
}

const text = (value, max, label) => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed.length > max) throw fail(400, `Subscriptions not saved: dashboard/subscription validation — ${label} is too long (${max} characters max).`);
  return trimmed;
};

const oneLine = (value, max, label) => {
  const trimmed = text(value, max, label);
  if (/[\r\n]/.test(trimmed)) throw fail(400, `Subscriptions not saved: dashboard/subscription validation — ${label} must be one line.`);
  return trimmed;
};

// Coerce an already-resolved document (real device keys present) into shape.
export function normalize(value) {
  const next = defaults();
  if (!value || typeof value !== "object") return next;

  for (const device of value.devices || []) {
    if (!device || typeof device !== "object") continue;
    const key = oneLine(device.key, 4096, "Bark device key");
    if (!key) continue;
    next.devices.push({ id: deviceId(key), label: text(device.label, 60, "device label"), key, enabled: device.enabled !== false });
  }

  for (const id of TYPE_IDS) {
    const raw = value.types?.[id];
    if (raw && typeof raw === "object") {
      next.types[id] = {
        enabled: raw.enabled === true,
        title: text(raw.title, 120, `${TYPE_LABELS[id]} title`) || next.types[id].title,
        body: text(raw.body, 500, `${TYPE_LABELS[id]} message`) || next.types[id].body,
      };
    }
  }

  if (value.resetFields && typeof value.resetFields === "object") {
    for (const concept of ["ticked", "requested", "arrivedAt", "expiresAt"]) {
      next.resetFields[concept] = text(value.resetFields[concept], 80, `reset field "${concept}"`);
    }
  }

  if (["passive", "active", "timeSensitive", "critical"].includes(value.level)) next.level = value.level;
  next.group = text(value.group, 80, "Bark group") || "agent-dashboard";

  return next;
}

// Public-safe view: device keys are replaced by a stable id + label only.
export function view(value, detectedResetFields = null) {
  const config = value ?? defaults();
  return {
    devices: config.devices.map(({ id, label, enabled }) => ({ id, label, enabled })),
    types: config.types,
    resetFields: config.resetFields,
    level: config.level,
    group: config.group,
    detectedResetFields,
    note: "Bark device keys are stored encrypted and never returned to the browser; leave a key blank to keep it.",
  };
}

export class SubscriptionStore {
  constructor(directory, keyFile) {
    this.file = path.join(directory, "subscription.enc.json");
    this.keyFile = keyFile;
  }
  key() {
    let key;
    try { key = fs.readFileSync(this.keyFile); } catch { throw fail(503, "Subscriptions unavailable: dashboard/subscription encryption — encryption key file is not available."); }
    if (key.length !== 32) throw fail(503, "Subscriptions unavailable: dashboard/subscription encryption — encryption key must contain exactly 32 bytes.");
    return key;
  }
  read() {
    if (!fs.existsSync(this.file)) return defaults();
    try {
      const envelope = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const decipher = createDecipheriv("aes-256-gcm", this.key(), Buffer.from(envelope.iv, "base64"));
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      return normalize(JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8")));
    } catch (error) {
      if (error.status) throw error;
      throw fail(503, "Subscriptions unavailable: dashboard/subscription encryption — stored configuration could not be authenticated; restore the matching encryption key.");
    }
  }
  // Merge the browser's view back onto the stored document. A device whose key
  // is blank keeps its stored key (matched by id); a non-blank key replaces it.
  save(patch) {
    const current = this.read();
    const storedById = new Map(current.devices.map(device => [device.id, device.key]));
    const devices = [];
    for (const raw of patch?.devices || []) {
      if (!raw || typeof raw !== "object") continue;
      const key = oneLine(raw.key, 4096, "Bark device key");
      const resolved = key || storedById.get(String(raw.id || "")) || "";
      if (!resolved) continue;
      devices.push({ id: deviceId(resolved), label: text(raw.label, 60, "device label"), key: resolved, enabled: raw.enabled !== false });
    }
    const next = normalize({ ...patch, devices });
    this.write(next);
    return next;
  }
  write(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    cipher.setAAD(AAD);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    const envelope = { version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(envelope), { mode: 0o600 });
    fs.renameSync(this.file + ".tmp", this.file);
  }
}
