/**
 * Per-plugin log buffer.
 *
 * The dashboard shows each plugin's recent activity on its own Logging tab, so
 * the lines have to be attributable to one plugin and readable after the fact.
 * opencode's own log is a single shared stream that the dashboard cannot read
 * back, so plugins append here as well.
 *
 * Like the registry this lives on `globalThis`: opencode instantiates plugins
 * once per project directory, and all of those instances share one process and
 * one dashboard. The buffer is capped and in-memory — it is a live tail, not an
 * audit trail, so it costs nothing at rest and disappears with the process.
 */

const KEY = Symbol.for("@dsh/opencode-plugin-logs")
const LIMIT = 300

export type Level = "info" | "warn" | "error"

export type Entry = {
  /** Epoch milliseconds, formatted for display by the dashboard. */
  at: number
  level: Level
  message: string
}

type Store = Map<string, Entry[]>

function store(): Store {
  const g = globalThis as Record<symbol, unknown>
  if (!g[KEY]) g[KEY] = new Map<string, Entry[]>()
  return g[KEY] as Store
}

/** Append one line to a plugin's buffer, dropping the oldest past the cap. */
export function log(pluginID: string, message: string, level: Level = "info"): void {
  const s = store()
  const lines = s.get(pluginID) ?? []
  lines.push({ at: Date.now(), level, message })
  if (lines.length > LIMIT) lines.splice(0, lines.length - LIMIT)
  s.set(pluginID, lines)
}

/** Recent lines, newest last. */
export function read(pluginID: string, limit = LIMIT): Entry[] {
  const lines = store().get(pluginID) ?? []
  return lines.slice(-limit)
}

export function clear(pluginID: string): void {
  store().delete(pluginID)
}
