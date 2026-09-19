/**
 * The opencode desktop app's own project list.
 *
 * The desktop app does not derive its project list from the `project` table.
 * It keeps a separate list of worktrees in `opencode.global.dat` (a flat JSON
 * key/value file under the Electron user-data directory) and creates a server
 * "instance" only for those entries:
 *
 *   "server": { "projects": { "local": [ { "worktree": "...", "expanded": true } ] },
 *               "lastProject": { "local": "..." },
 *               "recentlyClosed": {} }
 *
 * So importing sessions into the database is not enough for them to become
 * visible: the project's worktree has to be registered here too. This module
 * reads and updates that list without disturbing any other key in the file.
 */

import fsp from "node:fs/promises"
import path from "node:path"
import os from "node:os"

/** Electron's user-data directory for the desktop app. */
function userData(): string {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "ai.opencode.desktop")
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "ai.opencode.desktop")
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "ai.opencode.desktop")
}

export function globalStatePath(): string {
  return path.join(userData(), "opencode.global.dat")
}

export type DesktopProject = { worktree: string; expanded?: boolean }

type ServerState = {
  list?: unknown[]
  projects?: { local?: DesktopProject[]; [key: string]: unknown }
  lastProject?: Record<string, string>
  recentlyClosed?: Record<string, unknown>
}

/**
 * The desktop stores each value as a JSON *string* under a top-level key, so a
 * value has to be parsed and re-serialised rather than edited in place.
 */
async function readState(): Promise<Record<string, string> | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(globalStatePath(), "utf8"))
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

function parseServer(state: Record<string, string>): ServerState {
  try {
    const value = state["server"]
    if (typeof value === "string") return JSON.parse(value)
    if (value && typeof value === "object") return value as ServerState
  } catch {
    // Fall through to an empty state.
  }
  return {}
}

/** Worktrees the desktop app currently lists, in display order. */
export async function listProjects(): Promise<DesktopProject[]> {
  const state = await readState()
  if (!state) return []
  return parseServer(state).projects?.local ?? []
}

/**
 * Windows paths are compared case-insensitively and separator-agnostically so
 * `D:/x` and `d:\x` are recognised as the same worktree.
 */
function compareKey(worktree: string): string {
  const unified = worktree.replace(/\//g, "\\").replace(/\\+$/, "")
  return process.platform === "win32" ? unified.toLowerCase() : unified
}

/** The desktop stores worktrees in native platform form. */
export function toNative(worktree: string): string {
  if (process.platform !== "win32") return worktree
  return worktree.replace(/\//g, "\\")
}

export type RegisterResult = {
  added: string[]
  existing: string[]
  skipped: string[]
  total: number
  path: string
}

/**
 * Add worktrees to the desktop's project list.
 *
 * Existing entries keep their position and `expanded` flag; new ones are
 * appended. Every other key in the file is written back untouched. The file is
 * replaced atomically via a temp file so a crash cannot truncate it.
 */
export async function registerProjects(worktrees: string[]): Promise<RegisterResult> {
  const file = globalStatePath()
  const state = await readState()
  if (!state) throw new Error(`Desktop state file not found or unreadable: ${file}`)

  const server = parseServer(state)
  const current = server.projects?.local ?? []
  const seen = new Set(current.map((entry) => compareKey(entry.worktree)))

  const added: string[] = []
  const existing: string[] = []
  const skipped: string[] = []

  for (const worktree of worktrees) {
    if (!worktree || worktree === "/") {
      skipped.push(worktree)
      continue
    }
    const native = toNative(worktree)
    const key = compareKey(native)
    if (seen.has(key)) {
      existing.push(native)
      continue
    }
    seen.add(key)
    current.push({ worktree: native, expanded: false })
    added.push(native)
  }

  server.projects = { ...server.projects, local: current }
  state["server"] = JSON.stringify(server)

  const temp = file + ".tmp"
  await fsp.writeFile(temp, JSON.stringify(state), "utf8")
  await fsp.rename(temp, file)

  return { added, existing, skipped, total: current.length, path: file }
}
