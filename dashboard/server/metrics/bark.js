// Minimal Bark push for the dashboard subscription monitor.
//
// Mirrors opencode/lib/bark.ts buildURL/push: a device key plus a title and
// body render as GET https://api.day.app/<key>/<title>/<body> with optional
// presentation query params. Subscriptions send silently (level=passive) by
// default, matching the repo's Bark convention for long-running work.
import { createHash } from "node:crypto";

export const BARK_BASE = "https://api.day.app";
export const LEVELS = ["passive", "active", "timeSensitive", "critical"];

export function buildBarkUrl(key, title, body, options = {}) {
  const segments = [key, title, body].map(value => String(value ?? "").trim()).filter(value => value !== "");
  const url = new URL(BARK_BASE + "/" + segments.map(encodeURIComponent).join("/"));
  for (const field of ["level", "group", "sound", "icon"]) {
    const value = String(options[field] ?? "").trim();
    if (value !== "") url.searchParams.set(field, value);
  }
  return url.toString();
}

// Push one literal title/body to one device. Returns the delivery outcome so
// the monitor can log it without exposing the device key. Failures never throw.
export async function pushBark(key, title, body, options = {}, fetcher = fetch) {
  const result = { key: maskKey(key), ok: false, status: 0 };
  try {
    const response = await fetcher(buildBarkUrl(key, title, body, options), { method: "GET", signal: AbortSignal.timeout(15000) });
    result.ok = response.status >= 200 && response.status < 300;
    result.status = response.status;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

// Never log or echo a device key: show only a stable short prefix.
export function maskKey(key) {
  const value = String(key ?? "");
  return value ? `${value.slice(0, 4)}…` : "";
}

// Short stable identifier for a device, derived from its key, so the admin
// panel can reference a device without ever sending the key back to the browser.
export function deviceId(key) {
  return createHash("sha256").update(String(key ?? "")).digest("hex").slice(0, 12);
}
