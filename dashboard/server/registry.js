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

// Sidebar groups. Each group is one page; its panels contribute tabs, ordered
// by the panel's `order` and then by the order of each panel's `tabs`.
// A group is listed only when the viewer can see at least one of its panels.
export const GROUPS = Object.freeze([
  { id: "live", title: "Live", icon: "stream", order: 0 },
  { id: "openclaw", title: "OpenClaw", icon: "claw", order: 10 },
  { id: "usage", title: "Usage", icon: "gauge", order: 20 },
  { id: "adapters", title: "Adapters", icon: "bot", order: 30 },
  { id: "builds", title: "Builds", icon: "build", order: 40 },
  { id: "settings", title: "Settings", icon: "settings", order: 90 },
]);
const GROUP_IDS = new Set(GROUPS.map(group => group.id));
const TAB_ID = /^[a-z0-9-]{1,40}$/;
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
  if (panel.group !== undefined && !GROUP_IDS.has(panel.group)) {
    throw new Error(`Panel cannot be registered: dashboard/panel registration — ${panel.id} names unknown group ${panel.group}.`);
  }
  for (const tab of panel.tabs || []) {
    if (!TAB_ID.test(tab?.id || "") || !tab.title) throw new Error(`Panel cannot be registered: dashboard/panel registration — ${panel.id} has a tab without a valid ID or title.`);
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

// Panels without explicit tabs contribute one tab named after the panel.
export function tabsOf(panel) {
  return panel.tabs?.length ? panel.tabs.map(({ id, title }) => ({ id, title })) : [{ id: panel.id, title: panel.tabTitle || panel.title }];
}

// Groups that contain at least one of the given (already visibility-filtered) panels.
export function groupsFor(visiblePanels) {
  return GROUPS.filter(group => visiblePanels.some(panel => panel.group === group.id)).map(group => ({ ...group }));
}

// Strip server-side resolvers (children, run) so they never reach the browser.
// Non-admins see neither admin-only nor disabled panels; admins see every
// panel with its enabled flag so they can switch it back on.
export async function snapshot({ isAdmin = false } = {}) {
  const out = [];
  const ordered = [...panels.values()].sort((a, b) => (a.order ?? 50) - (b.order ?? 50) || a.id.localeCompare(b.id));
  for (const panel of ordered) {
    if (panel.adminOnly && !isAdmin) continue;
    const enabled = await isEnabled(panel.id);
    if (!enabled && !isAdmin) continue;
    out.push({
      id: panel.id,
      title: panel.title,
      description: panel.description ?? "",
      icon: panel.icon ?? "panel",
      group: panel.group ?? "adapters",
      order: panel.order ?? 50,
      tabs: tabsOf(panel),
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
