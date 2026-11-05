// Hot-pluggable panel registry.
//
// Panels self-describe their settings and status, so adding a panel never
// changes the dashboard core. Disabling a panel is a soft toggle
// (Registry.isEnabled) — a disabled panel gates its own routes and actions
// with no restart. snapshot() strips server-side resolvers before the payload
// reaches the browser.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const panels = new Map();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(process.env.NODE_ENV === "production" ? "/app/data" : path.join(__dirname, "panels"), "panels-state.json");

async function readState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeState(state) {
  try {
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // Best-effort: losing the toggle state degrades to defaults, never a crash.
  }
}

export function registerPanel(panel) {
  if (!panel?.id || !panel?.title) {
    throw new Error("Panel cannot be registered: dashboard/panel registration — panel ID or title is missing.");
  }
  panels.set(panel.id, panel);
}

export function getPanel(id) {
  return panels.get(id);
}

export async function isEnabled(id) {
  const state = await readState();
  return state[id]?.enabled !== false; // enabled by default
}

export async function setEnabled(id, enabled) {
  if (!panels.has(id)) {
    throw new Error(`Panel state cannot be changed: dashboard/panel lookup — ${id} is not registered.`);
  }
  const state = await readState();
  state[id] = { ...state[id], enabled: Boolean(enabled) };
  await writeState(state);
}

// Strip server-side resolvers (children, run) so they never reach the browser.
// Non-admins see neither admin-only nor disabled panels; admins see every
// panel with its enabled flag so they can switch it back on.
export async function snapshot({ isAdmin = false } = {}) {
  const out = [];
  for (const panel of panels.values()) {
    if (panel.adminOnly && !isAdmin) continue;
    const enabled = await isEnabled(panel.id);
    if (!enabled && !isAdmin) continue;
    out.push({
      id: panel.id,
      title: panel.title,
      description: panel.description ?? "",
      icon: panel.icon ?? "panel",
      enabled,
      adminOnly: panel.adminOnly === true,
      settings: await safeCall(panel.settings),
      status: await safeCall(panel.status),
    });
  }
  return out;
}

async function safeCall(fn) {
  if (typeof fn !== "function") {
    return [];
  }
  try {
    return (await fn()) ?? [];
  } catch {
    return [];
  }
}
