/**
 * Config file access for the dashboard's editor.
 *
 * Exposes the opencode config documents and the plugins' own state files as
 * editable text, with validation and a line diff so a save can be previewed
 * before it is written.
 *
 * Editing `opencode.json` only takes effect when opencode restarts — it reads
 * its config once at startup — so the editor labels those files accordingly
 * rather than pretending the change is live.
 */

import fsp from "node:fs/promises"
import path from "node:path"
import { CONFIG_DIR } from "./paths.ts"

export type ConfigFile = {
  /** Stable key used by the API; also the file name. */
  name: string
  path: string
  title: string
  description: string
  /** Whether a change requires an opencode restart to take effect. */
  restart: boolean
  exists: boolean
  size: number
  modified: number | null
  /** Files opencode owns are riskier to break, so the UI warns on them. */
  owner: "opencode" | "plugin"
  /**
   * The plugin whose state this file holds, when one owns it.
   *
   * A plugin's own file is edited on that plugin's Settings tab, which keeps
   * the manager's Info tab to the opencode-wide documents.
   */
  pluginID?: string
  readOnly?: boolean
}

/**
 * The editable set, in display order.
 *
 * Deliberately a fixed list rather than a directory scan: `session-index.json`
 * is 380 KB of generated data and `package-lock.json` is npm's, so neither
 * belongs in a hand-editor.
 */
const FILES: Array<Omit<ConfigFile, "exists" | "size" | "modified">> = [
  {
    name: "opencode.json",
    path: path.join(CONFIG_DIR, "opencode.json"),
    title: "opencode.json",
    description: "Main opencode config: providers, models, plugins. Applied at startup.",
    restart: true,
    owner: "opencode",
  },
  {
    name: "opencode.jsonc",
    path: path.join(CONFIG_DIR, "opencode.jsonc"),
    title: "opencode.jsonc",
    description: "Optional JSONC overlay merged over opencode.json.",
    restart: true,
    owner: "opencode",
  },
  {
    name: "plugin-manager.json",
    path: path.join(CONFIG_DIR, "plugin-manager.json"),
    title: "plugin-manager.json",
    description: "Which plugins are enabled. Written by the toggles on this page.",
    restart: false,
    owner: "plugin",
    pluginID: "plugin-manager",
  },
  {
    name: "bark-notify.json",
    path: path.join(CONFIG_DIR, "bark-notify.json"),
    title: "bark-notify.json",
    description: "Bark devices, focus mode and per-type switches.",
    restart: false,
    owner: "plugin",
    pluginID: "bark-notify",
  },
  {
    name: "cpa-usage.json",
    path: path.join(CONFIG_DIR, "cpa-usage.json"),
    title: "cpa-usage.json",
    description: "CPA endpoint overrides. Absent means the defaults are in use.",
    restart: false,
    owner: "plugin",
    pluginID: "cpa-usage",
  },
  {
    name: "task-queue.json",
    path: path.join(CONFIG_DIR, "task-queue.json"),
    title: "task-queue.json",
    description: "Queued tasks. Absent means the queue is empty.",
    restart: false,
    owner: "plugin",
    pluginID: "task-queue",
  },
  {
    name: "session-rename.json",
    path: path.join(CONFIG_DIR, "session-rename.json"),
    title: "session-rename.json",
    description: "Rename model, prompt template and thresholds. Absent means the defaults are in use.",
    restart: false,
    owner: "plugin",
    pluginID: "session-rename",
  },
  {
    name: "device.json",
    path: path.join(CONFIG_DIR, "device.json"),
    title: "device.json",
    description: "This device's identity in the shared session index.",
    restart: false,
    owner: "plugin",
    pluginID: "session-manager",
  },
]

function describe(entry: (typeof FILES)[number]) {
  return entry
}

export async function list(): Promise<ConfigFile[]> {
  return Promise.all(
    FILES.map(async (entry) => {
      try {
        const stat = await fsp.stat(entry.path)
        return { ...describe(entry), exists: true, size: stat.size, modified: stat.mtimeMs }
      } catch {
        return { ...describe(entry), exists: false, size: 0, modified: null }
      }
    }),
  )
}

function find(name: string) {
  const entry = FILES.find((file) => file.name === name)
  if (!entry) throw new Error(`Unknown config file: ${name}`)
  return entry
}

export async function read(name: string): Promise<{ file: ConfigFile; content: string }> {
  const entry = find(name)
  let content = ""
  let exists = true
  let size = 0
  let modified: number | null = null
  try {
    content = await fsp.readFile(entry.path, "utf8")
    const stat = await fsp.stat(entry.path)
    size = stat.size
    modified = stat.mtimeMs
  } catch {
    exists = false
  }
  return { file: { ...describe(entry), exists, size, modified }, content }
}

/** JSONC tolerates comments and trailing commas; strip them before parsing. */
function stripJsonc(text: string): string {
  let out = ""
  let inString = false
  let escaped = false
  let comment: "none" | "line" | "block" = "none"

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]

    if (comment === "line") {
      if (ch === "\n") {
        comment = "none"
        out += ch
      }
      continue
    }
    if (comment === "block") {
      if (ch === "*" && next === "/") {
        comment = "none"
        i++
      }
      continue
    }
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === "/" && next === "/") {
      comment = "line"
      i++
      continue
    }
    if (ch === "/" && next === "*") {
      comment = "block"
      i++
      continue
    }
    out += ch
  }

  return out.replace(/,(\s*[}\]])/g, "$1")
}

export type Validation = { ok: true } | { ok: false; message: string; line?: number }

/** Validate content as JSON/JSONC without writing anything. */
export function validate(name: string, content: string): Validation {
  const entry = find(name)
  if (content.trim() === "") return { ok: true }

  const text = entry.name.endsWith(".jsonc") ? stripJsonc(content) : content
  try {
    JSON.parse(text)
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Node reports "at position N"; convert that to a line number for the UI.
    const match = message.match(/position (\d+)/)
    let line: number | undefined
    if (match) line = text.slice(0, Number(match[1])).split("\n").length
    return { ok: false, message, line }
  }
}

export type DiffLine = { type: "same" | "add" | "remove"; text: string; before: number | null; after: number | null }

/**
 * Line diff between the file on disk and proposed content.
 *
 * A longest-common-subsequence diff over lines — the files here are small
 * config documents, so the quadratic table is not a concern and the result is
 * minimal rather than the noisy output of a naive line-by-line comparison.
 */
export function diff(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.replace(/\r\n/g, "\n").split("\n")
  const b = after === "" ? [] : after.replace(/\r\n/g, "\n").split("\n")

  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i], before: i + 1, after: j + 1 })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: "remove", text: a[i], before: i + 1, after: null })
      i++
    } else {
      out.push({ type: "add", text: b[j], before: null, after: j + 1 })
      j++
    }
  }
  while (i < a.length) out.push({ type: "remove", text: a[i], before: ++i, after: null })
  while (j < b.length) out.push({ type: "add", text: b[j], before: null, after: ++j })

  return out
}

export type SaveResult = { written: boolean; backup: string | null; file: ConfigFile }

/**
 * Write new content, keeping a timestamped backup of the previous version.
 *
 * Refuses invalid JSON so a typo cannot leave opencode unable to start, and
 * writes through a temp file so an interrupted save cannot truncate the config.
 */
export async function write(name: string, content: string): Promise<SaveResult> {
  const entry = find(name)

  const check = validate(name, content)
  if (!check.ok) throw new Error(`Invalid JSON: ${check.message}`)

  let previous = ""
  try {
    previous = await fsp.readFile(entry.path, "utf8")
  } catch {
    // Creating the file for the first time.
  }

  let backup: string | null = null
  if (previous !== "") {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
    backup = `${entry.path}.bak-${stamp}`
    await fsp.writeFile(backup, previous, "utf8")
  }

  await fsp.mkdir(path.dirname(entry.path), { recursive: true })
  const temp = entry.path + ".tmp"
  await fsp.writeFile(temp, content, "utf8")
  await fsp.rename(temp, entry.path)

  const stat = await fsp.stat(entry.path)
  return {
    written: true,
    backup,
    file: { ...describe(entry), exists: true, size: stat.size, modified: stat.mtimeMs },
  }
}
