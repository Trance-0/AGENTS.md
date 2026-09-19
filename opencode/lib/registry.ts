/**
 * Plugin registry — the settings/status contract each personal plugin implements.
 *
 * opencode has no plugin settings UI and no hot-plug in the desktop app, so the
 * plugins provide their own. Each one registers a `PluginDescriptor` describing
 * the settings it owns and how to read its status; the manager plugin then
 * renders those descriptors as a dashboard and as tools. Adding a setting to a
 * plugin therefore needs no change to the manager.
 *
 * Two things make this work inside opencode's constraints:
 *
 *   1. opencode instantiates plugins once per project directory (40+ times on
 *      this device), so the registry is stored on `globalThis` and shared by
 *      every instance in the process rather than per-instance state.
 *   2. opencode never unloads a plugin, so "disabled" is enforced by the
 *      plugin itself: a disabled plugin still loads but gates its hooks and
 *      tools. That is soft hot-plug — no restart, effective immediately.
 */

import fsp from "node:fs/promises"
import path from "node:path"
import { CONFIG_DIR } from "./paths.ts"
import * as Logs from "./logs.ts"
import * as Versions from "./versions.ts"
import * as Marketplace from "./marketplace.ts"

/**
 * Placement of a setting within the Settings tab.
 *
 * A plugin with many settings is unreadable as one flat list, so fields may
 * name a `group`. The dashboard renders each group as a collapsed section,
 * keyed by `group`, and shows ungrouped fields first. `when` hides a field
 * until another field in the same plugin holds a given value, so a mode
 * selector can reveal only the settings that mode actually uses.
 */
type Placement = {
  /** Section title. Ungrouped fields render above every section. */
  group?: string
  /** Open this section on first paint instead of leaving it collapsed. */
  expanded?: boolean
  /** Show only while the referenced setting equals one of these values. */
  when?: { key: string; equals: string[] }
}

/** One editable setting. `key` addresses the value inside the plugin's config. */
export type Field = Placement &
  (
    | { key: string; label: string; type: "boolean"; value: boolean; description?: string }
    | { key: string; label: string; type: "string"; value: string; description?: string; placeholder?: string; secret?: boolean; multiline?: boolean }
    | { key: string; label: string; type: "number"; value: number; description?: string; min?: number; max?: number }
    | { key: string; label: string; type: "select"; value: string; options: Array<{ value: string; label: string }>; description?: string }
    /**
     * A button inside the settings list. Unlike a top-level action this sits
     * next to the fields it affects, which is what makes list management —
     * adding or removing a row — expressible as settings.
     */
    | { key: string; label: string; type: "action"; action: string; value?: string; description?: string; danger?: boolean; prompt?: string }
  )

/** A read-only status line or table shown next to the settings. */
export type StatusItem = { label: string; value: string | number; tone?: "ok" | "warn" | "error" | "muted" }

export type Tone = "ok" | "warn" | "error" | "muted"

/**
 * One row of a panel: a titled item with optional metrics and a tone.
 *
 * Panels are the structured alternative to dumping text into the transcript —
 * the dashboard renders each row as a card, coloured by `tone`, so a list of
 * models or queued tasks stays scannable instead of becoming a wall of text.
 */
export type PanelItem = {
  /** Primary label, e.g. a model id or a task title. */
  title: string
  /** Optional secondary line under the title. */
  subtitle?: string
  /** Short key/value pairs rendered as columns on the card. */
  fields?: Array<{ label: string; value: string; tone?: Tone }>
  /** Colours the card's accent. */
  tone?: Tone
  /** Used by the dashboard's filter chips; free-form, e.g. a task status. */
  group?: string
  /**
   * Makes the card open another dashboard view, e.g. the config editor.
   * `view` is a route name the dashboard knows; `arg` is its parameter.
   */
  link?: { view: string; arg?: string }
}

/** A structured, card-rendered view shown on a plugin's Info tab. */
export type Panel = {
  /** Stable key, unique within the plugin. */
  key: string
  title: string
  description?: string
  items: PanelItem[]
  /** Shown when `items` is empty. */
  empty?: string
  /** When set, the dashboard offers chips filtering items by `PanelItem.group`. */
  filters?: string[]
  /**
   * Chip selected before the user picks one. Defaults to "all".
   *
   * A long-lived queue accumulates finished tasks that are no longer
   * actionable, so it opens on the work still in flight instead.
   */
  defaultFilter?: string
  /** Freshness line, e.g. "updated 2 min ago"; usually a cache timestamp. */
  updatedAt?: number | null
  /** Action key to run from a button at the top of the panel. */
  action?: string
}

export type PluginDescriptor = {
  id: string
  title: string
  description: string
  /** Settings this plugin exposes, read fresh each call. */
  settings: () => Promise<Field[]>
  /** Apply one setting change. Must validate and persist. */
  update: (key: string, value: unknown) => Promise<void>
  /** Live status, read fresh each call. */
  status: () => Promise<StatusItem[]>
  /**
   * Structured views for the Info tab, read fresh each call.
   *
   * Must not hit the network on its own: the dashboard polls, so panels read
   * whatever the plugin last cached and leave refreshing to an action.
   */
  panels?: () => Promise<Panel[]>
  /**
   * Optional named actions surfaced as buttons. `input` is present only when
   * the action was run from a settings field carrying a `prompt`.
   */
  actions?: Record<string, { label: string; run: (input?: string) => Promise<string> }>
  /** False when the plugin cannot be disabled (the manager itself). */
  toggleable?: boolean
}

type Registry = {
  plugins: Map<string, PluginDescriptor>
  /** Cached enable/disable state, kept in sync with the state file. */
  enabled: Record<string, boolean>
  loaded: boolean
}

const KEY = Symbol.for("@dsh/opencode-plugin-registry")
const STATE_PATH = path.join(CONFIG_DIR, "plugin-manager.json")

function registry(): Registry {
  const g = globalThis as Record<symbol, unknown>
  if (!g[KEY]) g[KEY] = { plugins: new Map(), enabled: {}, loaded: false } satisfies Registry
  return g[KEY] as Registry
}

async function loadState(): Promise<void> {
  const reg = registry()
  if (reg.loaded) return
  try {
    const parsed = JSON.parse(await fsp.readFile(STATE_PATH, "utf8"))
    if (parsed?.enabled && typeof parsed.enabled === "object") {
      for (const [id, on] of Object.entries(parsed.enabled)) {
        if (typeof on === "boolean") reg.enabled[id] = on
      }
    }
  } catch {
    // No state yet: everything defaults to enabled.
  }
  reg.loaded = true
}

async function saveState(): Promise<void> {
  const reg = registry()
  await fsp.mkdir(path.dirname(STATE_PATH), { recursive: true })
  const temp = STATE_PATH + ".tmp"
  await fsp.writeFile(temp, JSON.stringify({ enabled: reg.enabled }, null, 2) + "\n", "utf8")
  await fsp.rename(temp, STATE_PATH)
}

export function statePath(): string {
  return STATE_PATH
}

/** Register a plugin's settings surface. Re-registering replaces the entry. */
export function register(descriptor: PluginDescriptor): void {
  registry().plugins.set(descriptor.id, descriptor)
}

export function list(): PluginDescriptor[] {
  return [...registry().plugins.values()].sort((a, b) => a.title.localeCompare(b.title))
}

export function get(id: string): PluginDescriptor | undefined {
  return registry().plugins.get(id)
}

/**
 * Whether a plugin's behaviour is active.
 *
 * Disabled plugins stay loaded — opencode cannot unload them — so each plugin
 * checks this before acting. Reading is synchronous so it can guard a hot path;
 * the state file is loaded once at startup by `init`.
 */
export function isEnabled(id: string): boolean {
  return registry().enabled[id] !== false
}

export async function setEnabled(id: string, enabled: boolean): Promise<void> {
  const reg = registry()
  await loadState()
  reg.enabled[id] = enabled
  await saveState()
}

/** Load persisted enable/disable state. Safe to call from every instance. */
export async function init(): Promise<void> {
  await loadState()
}

export function enabledMap(): Record<string, boolean> {
  const reg = registry()
  const out: Record<string, boolean> = {}
  for (const id of reg.plugins.keys()) out[id] = reg.enabled[id] !== false
  return out
}

/**
 * Version and marketplace state for one plugin, as the Version tab renders it.
 *
 * Read from the manifest and the marketplace cache rather than the descriptor,
 * so a plugin declares its version in exactly one place.
 */
export type VersionInfo = {
  version: string
  channel: Versions.Channel
  notes: string | null
  promotedFrom: string | null
  /** Newest published version, or null when nothing is known yet. */
  available: string | null
  updateAvailable: boolean
  /** A local beta, which by the versioning rule was never published. */
  unreleased: boolean
  releaseTag: string
  downloadURL: string | null
}

/**
 * Snapshot every registered plugin: settings, status, version and enabled state.
 * This is what both the dashboard and the manager's tools render.
 */
export async function snapshot() {
  await loadState()

  // Read once per snapshot rather than per plugin: both are small files and
  // the dashboard polls this whole payload.
  const manifest = await Versions.load().catch(() => null)
  const market = await Marketplace.status().catch(() => [] as Marketplace.Status[])

  const versionOf = (id: string): VersionInfo | null => {
    const entry = manifest?.plugins.find((p) => p.id === id)
    if (!entry) return null
    const parsed = Versions.parse(entry.version)
    const status = market.find((s) => s.pluginID === id)
    return {
      version: entry.version,
      channel: parsed === null ? "beta" : Versions.channel(parsed),
      notes: entry.notes ?? null,
      promotedFrom: entry.promotedFrom ?? null,
      available: status?.available ?? null,
      updateAvailable: status?.updateAvailable ?? false,
      unreleased: status?.unreleased ?? (parsed !== null && !Versions.isStable(parsed)),
      releaseTag: Versions.releaseTag(id, entry.version),
      downloadURL: status?.downloadURL ?? null,
    }
  }

  return Promise.all(
    list().map(async (plugin) => ({
      version: versionOf(plugin.id),
      id: plugin.id,
      title: plugin.title,
      description: plugin.description,
      enabled: isEnabled(plugin.id),
      toggleable: plugin.toggleable !== false,
      settings: await plugin.settings().catch(() => [] as Field[]),
      status: await plugin.status().catch((error) => [
        { label: "error", value: error instanceof Error ? error.message : String(error), tone: "error" as const },
      ]),
      panels: await (plugin.panels?.().catch((error) => [
        {
          key: "error",
          title: "Unavailable",
          items: [],
          empty: error instanceof Error ? error.message : String(error),
        },
      ]) ?? Promise.resolve([] as Panel[])),
      logs: Logs.read(plugin.id, 200),
      actions: Object.entries(plugin.actions ?? {}).map(([key, action]) => ({ key, label: action.label })),
    })),
  )
}
