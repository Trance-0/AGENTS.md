/**
 * Read-only view of opencode's own session table.
 *
 * The HTTP API is **directory-scoped**: `/session` and `/session/status` answer
 * for one project at a time, and a plugin's client is bound to the directory it
 * was instantiated for. The task queue runs a single scheduler for the whole
 * process, so asking that one client about every session reports the sessions
 * of other projects as missing — which is exactly how a live session with 21
 * messages came to be marked "session no longer exists" and dropped.
 *
 * The database has no such scoping, so it is the authoritative source for
 * whether a session exists and what it contains. It is opened read-only and
 * never written here; the busy/idle state, which is not persisted, still comes
 * from the status API.
 */

import { DatabaseSync } from "node:sqlite"
import { DB_PATH } from "./paths.ts"

export type SessionRow = {
  id: string
  title: string
  directory: string
  projectID: string
  parentID: string | null
  cost: number
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  createdAt: number
  updatedAt: number
}

/** Total tokens billed as context, ignoring cache reads. */
export function totalTokens(row: SessionRow): number {
  return row.tokens.input + row.tokens.output + row.tokens.reasoning
}

function open(): DatabaseSync | null {
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    // Never block the app's writer; a stale read is better than a stall.
    db.exec("PRAGMA busy_timeout = 2000")
    return db
  } catch {
    return null
  }
}

function toRow(raw: any): SessionRow {
  return {
    id: String(raw.id),
    title: String(raw.title ?? ""),
    // opencode stores forward slashes; callers compare against these directly.
    directory: String(raw.directory ?? ""),
    projectID: String(raw.project_id ?? ""),
    parentID: raw.parent_id ? String(raw.parent_id) : null,
    cost: Number(raw.cost ?? 0),
    tokens: {
      input: Number(raw.tokens_input ?? 0),
      output: Number(raw.tokens_output ?? 0),
      reasoning: Number(raw.tokens_reasoning ?? 0),
      cacheRead: Number(raw.tokens_cache_read ?? 0),
      cacheWrite: Number(raw.tokens_cache_write ?? 0),
    },
    createdAt: Number(raw.time_created ?? 0),
    updatedAt: Number(raw.time_updated ?? 0),
  }
}

const COLUMNS = `id, title, directory, project_id, parent_id, cost,
  tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
  time_created, time_updated`

/** One session by id, or null when it genuinely does not exist. */
export function get(sessionID: string): SessionRow | null {
  const db = open()
  if (!db) return null
  try {
    const raw = db.prepare(`SELECT ${COLUMNS} FROM "session" WHERE id = ?`).get(sessionID)
    return raw ? toRow(raw) : null
  } catch {
    return null
  } finally {
    db.close()
  }
}

/**
 * Look several sessions up at once.
 *
 * Returns a map rather than an array so a caller can tell "absent" from
 * "present", and null when the database could not be read at all — a failed
 * read must never be mistaken for every session having disappeared.
 */
export function getMany(sessionIDs: string[]): Map<string, SessionRow> | null {
  if (sessionIDs.length === 0) return new Map()
  const db = open()
  if (!db) return null
  try {
    const found = new Map<string, SessionRow>()
    const statement = db.prepare(`SELECT ${COLUMNS} FROM "session" WHERE id = ?`)
    for (const id of sessionIDs) {
      const raw = statement.get(id)
      if (raw) found.set(id, toRow(raw))
    }
    return found
  } catch {
    return null
  } finally {
    db.close()
  }
}

/** Sessions touched since `since`, newest first — the adoption candidates. */
export function recent(since: number, limit = 200): SessionRow[] {
  const db = open()
  if (!db) return []
  try {
    const rows = db
      .prepare(
        `SELECT ${COLUMNS} FROM "session"
         WHERE time_updated >= ? AND parent_id IS NULL AND time_archived IS NULL
         ORDER BY time_updated DESC LIMIT ?`,
      )
      .all(since, limit)
    return rows.map(toRow)
  } catch {
    return []
  } finally {
    db.close()
  }
}

/** Number of messages in a session, as a cheap measure of how much work it holds. */
export function messageCount(sessionID: string): number {
  const db = open()
  if (!db) return 0
  try {
    const row = db.prepare(`SELECT COUNT(*) c FROM "message" WHERE session_id = ?`).get(sessionID) as
      | { c: number }
      | undefined
    return row?.c ?? 0
  } catch {
    return 0
  } finally {
    db.close()
  }
}

export type Turn = { role: "user" | "assistant"; text: string }

/**
 * The most recent turns of a session, oldest first.
 *
 * Where `openingPrompts` says what a session was *asked* to do, this says what
 * it actually became — which is what a title has to reflect once a session has
 * drifted from its first prompt. Rows are read newest-first so the limit applies
 * to the end of the transcript, then reversed back into reading order.
 */
export function recentTurns(sessionID: string, limit = 8): Turn[] {
  const db = open()
  if (!db) return []
  try {
    const rows = db
      .prepare(
        `SELECT json_extract(m.data, '$.role') role, p.data data FROM "part" p
         JOIN "message" m ON m.id = p.message_id
         WHERE p.session_id = ?
           AND json_extract(m.data, '$.role') IN ('user', 'assistant')
           AND json_extract(p.data, '$.type') = 'text'
         ORDER BY p.time_created DESC LIMIT ?`,
      )
      .all(sessionID, limit) as Array<{ role: string; data: string }>

    return rows
      .map((row) => {
        try {
          return { role: row.role === "user" ? ("user" as const) : ("assistant" as const), text: String(JSON.parse(row.data)?.text ?? "").trim() }
        } catch {
          return { role: "user" as const, text: "" }
        }
      })
      .filter((turn) => turn.text !== "")
      .reverse()
  } catch {
    return []
  } finally {
    db.close()
  }
}

/**
 * The opening user turns of a session, oldest first.
 *
 * This is the raw material a summary is built from: the first prompts say what
 * the session was asked to do, which is what a queue entry needs to be
 * recognisable.
 */
export function openingPrompts(sessionID: string, limit = 3): string[] {
  const db = open()
  if (!db) return []
  try {
    const rows = db
      .prepare(
        `SELECT p.data FROM "part" p
         JOIN "message" m ON m.id = p.message_id
         WHERE p.session_id = ?
           AND json_extract(m.data, '$.role') = 'user'
           AND json_extract(p.data, '$.type') = 'text'
         ORDER BY p.time_created ASC LIMIT ?`,
      )
      .all(sessionID, limit) as Array<{ data: string }>

    return rows
      .map((row) => {
        try {
          return String(JSON.parse(row.data)?.text ?? "").trim()
        } catch {
          return ""
        }
      })
      .filter(Boolean)
  } catch {
    return []
  } finally {
    db.close()
  }
}
