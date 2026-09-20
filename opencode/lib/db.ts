/**
 * Direct writer for opencode's SQLite store.
 *
 * opencode exposes no session-import API, so imported transcripts are written
 * straight into `opencode.db` using the same row shapes the app produces. Rows
 * are only ever inserted, never updated or deleted, and every import runs in a
 * transaction so a failure leaves nothing half-written.
 *
 * The database is opened in WAL mode, which permits one writer alongside the
 * running app's readers. Writes still take the write lock, so `busy_timeout` is
 * set to wait rather than fail when opencode happens to be committing.
 */

import { DatabaseSync } from "node:sqlite"
import { DB_PATH } from "./paths.ts"
import { messageID, partID, sessionID } from "./id.ts"
import * as Identity from "./project-identity.ts"
import type { ProjectIdentity } from "./project-identity.ts"
import type { Turn } from "./sources.ts"

export type ImportTarget = ProjectIdentity

/** Opened lazily so merely loading the plugin never touches the database. */
export function open(readOnly = false): DatabaseSync {
  const db = new DatabaseSync(DB_PATH, { readOnly })
  if (!readOnly) db.exec("PRAGMA busy_timeout = 15000")
  return db
}

/**
 * Resolve the opencode project for a session's working directory.
 *
 * Delegates to the shared identity resolver so that sessions recorded on other
 * devices — whose directories may not exist here — still merge onto the right
 * project via their recorded git remote, falling back to the directory name.
 */
export async function resolveProject(directory: string, recordedRemote?: string | null): Promise<ImportTarget> {
  return Identity.resolve({ directory, recordedRemote })
}

/**
 * Create the project row and register the session's directory against it.
 *
 * A project accumulates one `project_directory` row per distinct working
 * directory, so the same project observed at different paths (a worktree, or a
 * checkout on another device) lists all of them under one project.
 */
export function ensureProject(db: DatabaseSync, target: ImportTarget): void {
  const existing = db.prepare(`SELECT id, worktree FROM "project" WHERE id = ?`).get(target.projectID) as
    | { id: string; worktree: string }
    | undefined
  const now = Date.now()

  if (!existing) {
    db.prepare(
      `INSERT INTO "project" (id, worktree, vcs, name, time_created, time_updated, sandboxes)
       VALUES (?, ?, ?, ?, ?, ?, '[]')`,
    ).run(
      target.projectID,
      target.worktree || "/",
      target.source === "remote" || target.source === "root-commit" ? "git" : null,
      target.name || null,
      now,
      now,
    )
  }

  if (target.projectID === "global" || !target.directory) return

  const dir = db
    .prepare(`SELECT directory FROM "project_directory" WHERE project_id = ? AND directory = ?`)
    .get(target.projectID, target.directory)
  if (!dir) {
    db.prepare(
      `INSERT INTO "project_directory" (project_id, directory, type, strategy, time_created) VALUES (?, ?, NULL, NULL, ?)`,
    ).run(target.projectID, target.directory, now)
  }
}

export type ImportedSession = {
  sessionID: string
  projectID: string
  turns: number
}

/**
 * Build the `message.data` payload for one turn.
 *
 * opencode validates these on read: user messages require `agent` and `model`,
 * assistant messages additionally require a `parentID` pointing at the user
 * message they answer. Imported turns carry zero cost and zero tokens.
 */
function messageData(turn: Turn, time: number, parent: string, target: ImportTarget, providerID: string, modelID: string) {
  if (turn.role === "user") {
    return {
      role: "user",
      time: { created: time },
      agent: "build",
      model: { providerID, modelID },
    }
  }
  return {
    parentID: parent,
    role: "assistant",
    mode: "build",
    agent: "build",
    path: { cwd: target.directory, root: target.worktree },
    cost: 0,
    tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } },
    modelID,
    providerID,
    time: { created: time, completed: time },
    finish: "stop",
  }
}

/**
 * Assistant messages must reference a parent user message, so a transcript that
 * opens with an assistant turn gets a synthetic user turn in front of it.
 */
function normalizeTurns(turns: Turn[], source: string): Turn[] {
  const first = turns.findIndex((turn) => turn.role === "user")
  if (first === 0 || turns.length === 0) return turns
  return [{ role: "user", text: `(imported from ${source}; original prompt not recorded)`, time: turns[0]?.time }, ...turns]
}

/**
 * Write one transcript as a new opencode session.
 *
 * Each turn becomes a message row plus a single text part, matching the shape
 * opencode writes for plain text turns. Assistant messages carry the token and
 * path metadata the reader expects; imported sessions report zero cost.
 */
export function importSession(
  db: DatabaseSync,
  input: {
    target: ImportTarget
    title: string
    turns: Turn[]
    created: number
    model: string
    source: string
    sourceID: string
    /** Device whose store the transcript came from. */
    device: string
    branch?: string | null
  },
): ImportedSession {
  const { target } = input
  const turns = normalizeTurns(input.turns, input.source)
  const created = input.created || Date.now()
  const ses = sessionID(created)
  const version = "1.18.31"

  const providerID = "imported"
  const modelID = input.model || input.source

  db.exec("BEGIN IMMEDIATE")
  try {
    ensureProject(db, target)

    let last = created
    const rows: Array<{ id: string; time: number; data: string }> = []
    const parts: Array<{ id: string; message: string; time: number; data: string }> = []
    let parent = ""

    for (const [offset, turn] of turns.entries()) {
      const time = turn.time && turn.time >= created ? turn.time : created + offset
      last = Math.max(last, time)
      const msg = messageID(time)

      if (turn.role === "user") parent = msg
      rows.push({ id: msg, time, data: JSON.stringify(messageData(turn, time, parent, target, providerID, modelID)) })
      parts.push({
        id: partID(time),
        message: msg,
        time,
        data: JSON.stringify({ type: "text", text: turn.text }),
      })
    }

    db.prepare(
      `INSERT INTO "session"
        (id, project_id, workspace_id, parent_id, slug, directory, path, title, version,
         summary_additions, summary_deletions, summary_files, cost,
         tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
         agent, model, metadata, time_created, time_updated)
       VALUES (?, ?, NULL, NULL, ?, ?, '', ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'build', ?, ?, ?, ?)`,
    ).run(
      ses,
      target.projectID,
      slugFor(input.sourceID),
      target.directory,
      input.title.slice(0, 200),
      version,
      JSON.stringify({ id: modelID, providerID }),
      // Provenance travels with the session so a later scan on any device can
      // tell where an imported transcript originally came from.
      JSON.stringify({
        imported: {
          source: input.source,
          sourceID: input.sourceID,
          device: input.device,
          directory: target.directory,
          remote: target.remote,
          branch: input.branch ?? null,
          projectSource: target.source,
          at: Date.now(),
        },
      }),
      created,
      last,
    )

    const message = db.prepare(
      `INSERT INTO "message" (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`,
    )
    for (const row of rows) message.run(row.id, ses, row.time, row.time, row.data)

    const part = db.prepare(
      `INSERT INTO "part" (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    for (const row of parts) part.run(row.id, row.message, ses, row.time, row.time, row.data)

    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }

  return { sessionID: ses, projectID: target.projectID, turns: turns.length }
}

/** Append new turns to an already-imported session (the `grown` merge path). */
export function appendTurns(
  db: DatabaseSync,
  input: { sessionID: string; target: ImportTarget; turns: Turn[]; model: string; source: string },
): number {
  if (input.turns.length === 0) return 0

  const existing = db.prepare(`SELECT time_updated FROM "session" WHERE id = ?`).get(input.sessionID) as
    | { time_updated: number }
    | undefined
  if (!existing) throw new Error(`Session ${input.sessionID} is no longer in the database`)

  const providerID = "imported"
  const modelID = input.model || input.source
  let last = existing.time_updated

  // An appended assistant turn needs a parent; fall back to the session's last
  // user message when the new tail does not start with one.
  const lastUser = db
    .prepare(
      `SELECT id FROM "message" WHERE session_id = ? AND json_extract(data, '$.role') = 'user'
       ORDER BY time_created DESC LIMIT 1`,
    )
    .get(input.sessionID) as { id: string } | undefined

  db.exec("BEGIN IMMEDIATE")
  try {
    const message = db.prepare(
      `INSERT INTO "message" (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`,
    )
    const part = db.prepare(
      `INSERT INTO "part" (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`,
    )

    let parent = lastUser?.id ?? ""
    for (const [offset, turn] of input.turns.entries()) {
      const time = turn.time && turn.time > last ? turn.time : last + offset + 1
      last = Math.max(last, time)
      const msg = messageID(time)

      if (turn.role === "user") parent = msg
      message.run(
        msg,
        input.sessionID,
        time,
        time,
        JSON.stringify(messageData(turn, time, parent, input.target, providerID, modelID)),
      )
      part.run(partID(time), msg, input.sessionID, time, time, JSON.stringify({ type: "text", text: turn.text }))
    }

    db.prepare(`UPDATE "session" SET time_updated = ? WHERE id = ?`).run(last, input.sessionID)
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }

  return input.turns.length
}

export function countTurns(db: DatabaseSync, session: string): number {
  const row = db.prepare(`SELECT COUNT(*) c FROM "message" WHERE session_id = ?`).get(session) as { c: number }
  return row.c
}

/**
 * Where a session came from.
 *
 * `opencode` means the session was created by opencode itself; anything else is
 * a transcript this plugin imported, tagged with the tool that recorded it.
 * Imported sessions carry their provenance in `metadata.imported`.
 */
export type SessionSource = "opencode" | "claude" | "codex" | "dsh" | string

export type ProjectRow = {
  id: string
  name: string
  worktree: string
  sessions: number
  /** Every working directory registered against this project. */
  directories: string[]
  lastActivity: number
  /** Session count per source, e.g. `{ opencode: 3, codex: 12 }`. */
  bySource: Record<SessionSource, number>
}

export type SessionRow = {
  id: string
  title: string
  directory: string
  source: SessionSource
  /** Device the transcript was recorded on; null for native sessions. */
  device: string | null
  created: number
  updated: number
  turns: number
}

/** `metadata.imported.source` is the tool that recorded an imported transcript. */
const SOURCE_SQL = `COALESCE(json_extract(s.metadata,'$.imported.source'), 'opencode')`

/**
 * Every project that owns at least one session, newest activity first.
 *
 * This reads opencode's own tables rather than the session index, so natively
 * created sessions are listed alongside imported ones. The index only knows
 * about transcripts this plugin imported, which is why a count taken from it
 * disagrees with what opencode actually holds.
 */
export function listProjects(db: DatabaseSync): ProjectRow[] {
  const rows = db
    .prepare(
      `SELECT p.id AS id, p.name AS name, p.worktree AS worktree,
              COUNT(s.id) AS sessions, MAX(s.time_updated) AS last
       FROM "project" p JOIN "session" s ON s.project_id = p.id
       GROUP BY p.id ORDER BY last DESC`,
    )
    .all() as Array<{ id: string; name: string | null; worktree: string; sessions: number; last: number | null }>

  const sources = db
    .prepare(`SELECT s.project_id AS id, ${SOURCE_SQL} AS source, COUNT(*) AS n FROM "session" s GROUP BY s.project_id, source`)
    .all() as Array<{ id: string; source: string; n: number }>

  const directories = db
    .prepare(`SELECT project_id AS id, directory FROM "project_directory" ORDER BY time_created`)
    .all() as Array<{ id: string; directory: string }>

  const bySource = new Map<string, Record<string, number>>()
  for (const row of sources) {
    const entry = bySource.get(row.id) ?? {}
    entry[row.source] = row.n
    bySource.set(row.id, entry)
  }

  const dirs = new Map<string, string[]>()
  for (const row of directories) {
    const list = dirs.get(row.id) ?? []
    list.push(row.directory)
    dirs.set(row.id, list)
  }

  return rows.map((row) => ({
    id: row.id,
    name: row.name || basename(row.worktree) || row.id,
    worktree: row.worktree,
    sessions: row.sessions,
    directories: dirs.get(row.id) ?? [],
    lastActivity: row.last ?? 0,
    bySource: bySource.get(row.id) ?? {},
  }))
}

/** Sessions belonging to one project, newest first. Loaded on expand. */
export function listSessions(db: DatabaseSync, projectID: string, limit = 200): SessionRow[] {
  const rows = db
    .prepare(
      `SELECT s.id AS id, s.title AS title, s.directory AS directory,
              ${SOURCE_SQL} AS source,
              json_extract(s.metadata,'$.imported.device') AS device,
              s.time_created AS created, s.time_updated AS updated,
              (SELECT COUNT(*) FROM "message" m WHERE m.session_id = s.id) AS turns
       FROM "session" s WHERE s.project_id = ?
       ORDER BY s.time_updated DESC LIMIT ?`,
    )
    .all(projectID, limit) as SessionRow[]
  return rows
}

/** Counts for the status line, taken from opencode's tables. */
export function counts(db: DatabaseSync): { sessions: number; projects: number; bySource: Record<string, number> } {
  const sessions = (db.prepare(`SELECT COUNT(*) c FROM "session"`).get() as { c: number }).c
  const projects = (db.prepare(`SELECT COUNT(*) c FROM "project"`).get() as { c: number }).c
  const rows = db
    .prepare(`SELECT ${SOURCE_SQL} AS source, COUNT(*) AS n FROM "session" s GROUP BY source`)
    .all() as Array<{ source: string; n: number }>
  const bySource: Record<string, number> = {}
  for (const row of rows) bySource[row.source] = row.n
  return { sessions, projects, bySource }
}

function basename(value: string): string {
  const parts = value.replace(/[\\/]+$/, "").split(/[\\/]/)
  return parts[parts.length - 1] ?? ""
}

export type SearchHit = {
  sessionID: string
  title: string
  projectID: string
  projectName: string
  source: SessionSource
  directory: string
  updated: number
  /** How many text parts in this session matched every term. */
  matches: number
  /** Text around the first match, for showing why the session matched. */
  snippet: string
}

export type SearchOptions = {
  /** Restrict to one project. */
  projectID?: string
  /** Restrict to one source, e.g. only native opencode sessions. */
  source?: SessionSource
  /** Max sessions returned (default 40). */
  limit?: number
}

/** `%` and `_` are LIKE wildcards; `\` escapes them via the ESCAPE clause. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/**
 * Split a query into terms, honouring "quoted phrases".
 *
 * Quoting is what lets a phrase containing a space be searched as one unit
 * rather than as unrelated words that happen to appear in the same message.
 */
export function parseQuery(query: string): string[] {
  const terms: string[] = []
  for (const match of query.matchAll(/"([^"]+)"|(\S+)/g)) {
    const term = (match[1] ?? match[2] ?? "").trim()
    if (term) terms.push(term)
  }
  // More than a handful of terms is a pathological query, not a useful one.
  return terms.slice(0, 8)
}

/** Text around the first match, with the match roughly centred. */
function snippetFor(text: string, term: string, width = 160): string {
  const at = text.toLowerCase().indexOf(term.toLowerCase())
  if (at === -1) return text.slice(0, width).replace(/\s+/g, " ").trim()

  const start = Math.max(0, at - Math.floor((width - term.length) / 2))
  const end = Math.min(text.length, start + width)
  const body = text.slice(start, end).replace(/\s+/g, " ").trim()
  return (start > 0 ? "…" : "") + body + (end < text.length ? "…" : "")
}

/**
 * Find sessions whose transcript contains every term.
 *
 * Searches the text parts of opencode's own message store, so it covers
 * natively created sessions as well as imported transcripts. Terms are ANDed
 * across the session rather than within a single message: a session discussing
 * two things in separate turns is still the session being looked for.
 *
 * This is a plain scan. At the scale opencode reaches — tens of thousands of
 * parts, tens of megabytes — it answers in well under a second, and an FTS
 * index would mean maintaining a shadow table inside a database this plugin
 * does not own.
 */
export function search(db: DatabaseSync, query: string, options: SearchOptions = {}): SearchHit[] {
  const terms = parseQuery(query)
  if (terms.length === 0) return []

  const limit = Math.max(1, Math.min(options.limit ?? 40, 200))
  const conditions: string[] = [`json_extract(p.data,'$.type') = 'text'`]
  const params: Array<string | number> = []

  for (const term of terms) {
    conditions.push(`lower(json_extract(p.data,'$.text')) LIKE lower(?) ESCAPE '\\'`)
    params.push(`%${escapeLike(term)}%`)
  }
  if (options.projectID) {
    conditions.push(`s.project_id = ?`)
    params.push(options.projectID)
  }
  if (options.source) {
    conditions.push(`${SOURCE_SQL} = ?`)
    params.push(options.source)
  }

  // Rank by how often a session matched, then by recency: a passing mention
  // should not outrank the session that actually worked on the thing.
  const rows = db
    .prepare(
      `SELECT p.session_id AS sessionID, COUNT(*) AS matches,
              s.title AS title, s.directory AS directory, s.time_updated AS updated,
              s.project_id AS projectID, pr.name AS projectName, pr.worktree AS worktree,
              ${SOURCE_SQL} AS source
       FROM "part" p
       JOIN "session" s ON s.id = p.session_id
       LEFT JOIN "project" pr ON pr.id = s.project_id
       WHERE ${conditions.join(" AND ")}
       GROUP BY p.session_id
       ORDER BY matches DESC, s.time_updated DESC
       LIMIT ?`,
    )
    .all(...params, limit) as Array<{
    sessionID: string
    matches: number
    title: string | null
    directory: string | null
    updated: number
    projectID: string
    projectName: string | null
    worktree: string | null
    source: string
  }>

  // The snippet comes from the earliest part matching the first term, which is
  // where a reader looks to judge whether this is the session they meant.
  const excerpt = db.prepare(
    `SELECT json_extract(data,'$.text') AS text FROM "part"
     WHERE session_id = ? AND json_extract(data,'$.type') = 'text'
       AND lower(json_extract(data,'$.text')) LIKE lower(?) ESCAPE '\\'
     ORDER BY time_created LIMIT 1`,
  )

  return rows.map((row) => {
    const found = excerpt.get(row.sessionID, `%${escapeLike(terms[0])}%`) as { text: string } | undefined
    return {
      sessionID: row.sessionID,
      title: row.title || "(untitled)",
      projectID: row.projectID,
      projectName: row.projectName || basename(row.worktree ?? "") || row.projectID,
      source: row.source,
      directory: row.directory ?? "",
      updated: row.updated,
      matches: row.matches,
      snippet: found?.text ? snippetFor(found.text, terms[0]) : "",
    }
  })
}

export function sessionExists(db: DatabaseSync, session: string): boolean {
  return db.prepare(`SELECT 1 FROM "session" WHERE id = ?`).get(session) !== undefined
}

function slugFor(sourceID: string): string {
  return ("imported-" + sourceID.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)).toLowerCase()
}

/**
 * Copy the database aside before the first structural edit of a run.
 *
 * Renaming a project is trivially reversible, but merging re-points every
 * session row and cannot be undone from the UI, so a snapshot is taken first.
 * WAL mode means the `-wal` sidecar holds committed pages that are not yet in
 * the main file; `VACUUM INTO` writes a consistent copy of the whole database
 * rather than a torn file, which a plain file copy would risk.
 */
export function backup(db: DatabaseSync): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const target = `${DB_PATH}.${stamp}.backup`
  db.prepare(`VACUUM INTO ?`).run(target)
  return target
}

/** Rename a project as shown in the UI. Does not move any session. */
export function renameProject(db: DatabaseSync, projectID: string, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) throw new Error("Project name cannot be empty")
  if (trimmed.length > 200) throw new Error("Project name is too long (max 200 characters)")

  const existing = db.prepare(`SELECT 1 FROM "project" WHERE id = ?`).get(projectID)
  if (!existing) throw new Error(`Unknown project: ${projectID}`)

  db.prepare(`UPDATE "project" SET name = ?, time_updated = ? WHERE id = ?`).run(trimmed, Date.now(), projectID)
}

/**
 * Register another working directory against a project.
 *
 * This is what makes the same repository checked out at a second path — or a
 * remote URL recorded by a session from another device — resolve into the
 * project the user already has, instead of splitting into a new one.
 */
export function addProjectDirectory(db: DatabaseSync, projectID: string, directory: string): void {
  const trimmed = directory.trim()
  if (!trimmed) throw new Error("Directory cannot be empty")

  const existing = db.prepare(`SELECT 1 FROM "project" WHERE id = ?`).get(projectID)
  if (!existing) throw new Error(`Unknown project: ${projectID}`)

  const already = db
    .prepare(`SELECT 1 FROM "project_directory" WHERE project_id = ? AND directory = ?`)
    .get(projectID, trimmed)
  if (already) throw new Error(`${trimmed} is already registered on this project`)

  db.prepare(
    `INSERT INTO "project_directory" (project_id, directory, type, strategy, time_created) VALUES (?, ?, NULL, NULL, ?)`,
  ).run(projectID, trimmed, Date.now())
}

export type MergeResult = { moved: number; directories: number; backup: string; from: string; into: string }

/**
 * Move every session from one project into another, then drop the empty source.
 *
 * Sessions are re-pointed rather than copied, so nothing is duplicated and no
 * transcript is lost. The source project's directories are carried over too,
 * which is what stops a later import from recreating the project that was just
 * merged away.
 */
export function mergeProjects(db: DatabaseSync, fromID: string, intoID: string): MergeResult {
  if (fromID === intoID) throw new Error("Cannot merge a project into itself")

  const from = db.prepare(`SELECT id, name, worktree FROM "project" WHERE id = ?`).get(fromID) as
    | { id: string; name: string | null; worktree: string }
    | undefined
  const into = db.prepare(`SELECT id, name, worktree FROM "project" WHERE id = ?`).get(intoID) as
    | { id: string; name: string | null; worktree: string }
    | undefined
  if (!from) throw new Error(`Unknown project: ${fromID}`)
  if (!into) throw new Error(`Unknown project: ${intoID}`)

  // Re-pointing session rows is not reversible from the dashboard.
  const saved = backup(db)

  db.exec("BEGIN IMMEDIATE")
  try {
    const moved = db.prepare(`UPDATE "session" SET project_id = ? WHERE project_id = ?`).run(intoID, fromID)
      .changes as number

    // Carry directories across, skipping any the target already claims.
    const directories = db
      .prepare(`SELECT directory, type, strategy FROM "project_directory" WHERE project_id = ?`)
      .all(fromID) as Array<{ directory: string; type: string | null; strategy: string | null }>
    const claimed = db.prepare(`SELECT 1 FROM "project_directory" WHERE project_id = ? AND directory = ?`)
    const insert = db.prepare(
      `INSERT INTO "project_directory" (project_id, directory, type, strategy, time_created) VALUES (?, ?, ?, ?, ?)`,
    )
    let carried = 0
    const now = Date.now()
    for (const row of directories) {
      if (claimed.get(intoID, row.directory)) continue
      insert.run(intoID, row.directory, row.type, row.strategy, now)
      carried++
    }

    db.prepare(`DELETE FROM "project_directory" WHERE project_id = ?`).run(fromID)
    db.prepare(`DELETE FROM "project" WHERE id = ?`).run(fromID)
    db.prepare(`UPDATE "project" SET time_updated = ? WHERE id = ?`).run(now, intoID)

    db.exec("COMMIT")
    return { moved, directories: carried, backup: saved, from: fromID, into: intoID }
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}
