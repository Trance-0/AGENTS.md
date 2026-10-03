/**
 * Per-plugin logging: a live in-memory tail and a durable daily file.
 *
 * The dashboard shows each plugin's activity on its own Logging tab, so lines
 * have to be attributable to one plugin and readable after the fact. opencode's
 * own log is a single shared stream the dashboard cannot read back, so plugins
 * append here as well.
 *
 * Two stores, because they answer different questions:
 *
 *   - **The buffer** is what is happening now. It lives on `globalThis` for the
 *     same reason the registry does — opencode instantiates a plugin once per
 *     project directory, and all those instances share one process and one
 *     dashboard — and is capped, so it costs nothing at rest.
 *   - **The files** are what happened before. A buffer dies with the process,
 *     which is precisely when a log matters most: the run that ended badly is
 *     the one worth reading. One file per plugin per day, at
 *     `<data>/plugin-logs/<plugin>/<plugin>-<YYYY-MM-DD>.log`.
 *
 * The file format follows the repository's logging convention: one record per
 * line, `<ISO timestamp> <LEVEL> <message>`, so it stays greppable. A message
 * containing newlines is indented on continuation lines, which keeps "a record
 * starts at column zero" true and lets a reader — or `grep -v '^ '` — separate
 * records without parsing.
 */

import fs from "node:fs"
import path from "node:path"
import { LOG_DIR } from "./paths.ts"

const KEY = Symbol.for("@dsh/opencode-plugin-logs")
const LIMIT = 300

/** Files older than this are deleted on the first write of each day. */
const RETENTION_DAYS = 30

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

/* ------------------------------------------------------------------ *
 * File side
 * ------------------------------------------------------------------ */

/** Local calendar date, not UTC: "today's log" means the reader's today. */
export function dayOf(at: number | Date = Date.now()): string {
  const d = at instanceof Date ? at : new Date(at)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** A plugin id is used as a directory name, so it must not escape the root. */
function safeID(pluginID: string): string {
  return pluginID.replace(/[^a-zA-Z0-9._-]/g, "-")
}

export function logDir(pluginID: string): string {
  return path.join(LOG_DIR, safeID(pluginID))
}

export function logFile(pluginID: string, day = dayOf()): string {
  return path.join(logDir(pluginID), `${safeID(pluginID)}-${day}.log`)
}

const FILE_RE = /^(.+)-(\d{4}-\d{2}-\d{2})\.log$/

/** Days this plugin has a log for, newest first. */
export function days(pluginID: string): string[] {
  let names: string[]
  try {
    names = fs.readdirSync(logDir(pluginID))
  } catch {
    return []
  }
  const found: string[] = []
  for (const name of names) {
    const match = FILE_RE.exec(name)
    if (match) found.push(match[2])
  }
  return found.sort().reverse()
}

/** Drop logs past the retention window; failures are never fatal. */
function prune(pluginID: string): void {
  const cutoff = dayOf(Date.now() - RETENTION_DAYS * 86_400_000)
  for (const day of days(pluginID)) {
    if (day >= cutoff) continue
    try {
      fs.rmSync(logFile(pluginID, day), { force: true })
    } catch {
      // A log that cannot be deleted is not worth failing a write over.
    }
  }
}

/** The day each plugin last wrote, so pruning runs once per day per plugin. */
const lastDay = new Map<string, string>()

function formatLine(entry: Entry): string {
  // Continuation lines are indented so a record always starts at column zero.
  const body = entry.message.replace(/\r?\n/g, "\n    ")
  return `${new Date(entry.at).toISOString()} ${entry.level.toUpperCase().padEnd(5)} ${body}\n`
}

function append(pluginID: string, entry: Entry): void {
  const day = dayOf(entry.at)
  try {
    if (lastDay.get(pluginID) !== day) {
      fs.mkdirSync(logDir(pluginID), { recursive: true })
      lastDay.set(pluginID, day)
      prune(pluginID)
    }
    fs.appendFileSync(logFile(pluginID, day), formatLine(entry), "utf8")
  } catch {
    // Logging must never break the thing being logged: a full disk or a
    // read-only data directory degrades to the in-memory buffer alone.
  }
}

const LINE_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(INFO|WARN|ERROR)\s+([\s\S]*)$/

/**
 * Read back one day's file.
 *
 * Continuation lines are folded into the record above them, which is what the
 * indentation is for: a multi-line message is one entry, not several malformed
 * ones.
 */
export function readDay(pluginID: string, day: string, limit = 2000): Entry[] {
  let text: string
  try {
    text = fs.readFileSync(logFile(pluginID, day), "utf8")
  } catch {
    return []
  }

  const entries: Entry[] = []
  for (const raw of text.split("\n")) {
    if (raw === "") continue
    const match = LINE_RE.exec(raw)
    if (match) {
      const at = Date.parse(match[1])
      entries.push({
        at: Number.isFinite(at) ? at : Date.now(),
        level: match[2].toLowerCase() as Level,
        message: match[3],
      })
      continue
    }
    // A continuation of the record above, or a line written by something that
    // did not follow the format; either way it belongs to the previous entry.
    const previous = entries[entries.length - 1]
    if (previous) previous.message += "\n" + raw.replace(/^ {4}/, "")
  }

  return entries.slice(-limit)
}

/* ------------------------------------------------------------------ *
 * Buffer side
 * ------------------------------------------------------------------ */

/** Append one line to a plugin's buffer and to today's file. */
export function log(pluginID: string, message: string, level: Level = "info"): void {
  const entry: Entry = { at: Date.now(), level, message }

  const s = store()
  const lines = s.get(pluginID) ?? []
  lines.push(entry)
  if (lines.length > LIMIT) lines.splice(0, lines.length - LIMIT)
  s.set(pluginID, lines)

  append(pluginID, entry)
}

/** Recent lines from the live buffer, newest last. */
export function read(pluginID: string, limit = LIMIT): Entry[] {
  const lines = store().get(pluginID) ?? []
  return lines.slice(-limit)
}

/**
 * Clear the live buffer. The files are deliberately left alone: an operator
 * clearing a noisy view should not destroy the record of what happened.
 */
export function clear(pluginID: string): void {
  store().delete(pluginID)
}
