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

export function sessionExists(db: DatabaseSync, session: string): boolean {
  return db.prepare(`SELECT 1 FROM "session" WHERE id = ?`).get(session) !== undefined
}

function slugFor(sourceID: string): string {
  return ("imported-" + sourceID.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)).toLowerCase()
}
