/** Portable session records. Source paths are observations, never ownership. */
import { createHash, randomUUID } from "node:crypto"
import fsp from "node:fs/promises"
import path from "node:path"
import type { DatabaseSync, SQLInputValue } from "node:sqlite"
import * as Archive from "./archive.ts"
import * as DB from "./db.ts"
import * as Index from "./index-store.ts"
import * as Identity from "./project-identity.ts"
import { readTurns } from "./sources.ts"
import type { IndexEntry } from "./index-store.ts"
import type { Handle } from "./progress.ts"

type Row = Record<string, SQLInputValue>
type RecordEntry = { table: string; row: Row }
type SourceRecord = { descriptor: Record<string, unknown>; raw?: string; turns?: Array<{ role: "user" | "assistant"; text: string; time?: number }>; unavailable?: boolean }
type Stored = RecordEntry | { source: SourceRecord } | { operation: { id: string; action: string; at: number; outcome: string } }
// Deliberately excludes accounts, credentials, shared-session secrets and permissions.
const TABLES = ["project", "project_directory", "workspace", "session", "message", "part",
  "session_input", "session_message", "session_context_epoch", "todo", "event_sequence", "event"] as const
const HISTORY = "plugin_session_archive_history"
const quote = (s: string) => '"' + s.replace(/"/g, '""') + '"'
const hash = (s: string) => createHash("sha256").update(s).digest("hex")
const error = (cause: string) => new Error(`Session transfer stopped: session-manager/archive — ${cause}`)
function columns(db: DatabaseSync, table: string) {
  return db.prepare(`PRAGMA table_info(${quote(table)})`).all() as unknown as Array<{ name: string; pk: number }>
}
function init(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${HISTORY} (hash TEXT PRIMARY KEY, payload TEXT NOT NULL)`)
}
function remember(db: DatabaseSync, record: Stored) {
  const payload = JSON.stringify(record)
  db.prepare(`INSERT OR IGNORE INTO ${HISTORY} VALUES (?, ?)`).run(hash(payload), payload)
}
function* records(db: DatabaseSync): Generator<RecordEntry> {
  for (const table of TABLES) {
    if (!columns(db, table).length) continue
    let where = ""
    // Event aggregates unrelated to sessions are not session history.
    if (table === "event" || table === "event_sequence") where = ' WHERE aggregate_id IN (SELECT id FROM session)'
    for (const row of db.prepare(`SELECT * FROM ${quote(table)}${where}`).iterate()) yield { table, row: row as Row }
  }
}

/** A device may already have imported the same external session under another ID. */
const identities = new WeakMap<DatabaseSync, Map<string, string>>()
function reconcileSourceIDs(db: DatabaseSync, incoming: RecordEntry[]): RecordEntry[] {
  const ids = identities.get(db) ?? new Map<string, string>()
  identities.set(db, ids)
  const readMetadata = (value: SQLInputValue | undefined): Record<string, unknown> => {
    try { return JSON.parse(String(value ?? "{}")) } catch { return {} }
  }
  const sessions = incoming.filter((r) => r.table === "session")
  for (const { row } of sessions) {
    const meta = readMetadata(row.metadata).imported as Record<string, unknown> | undefined
    if (!meta?.source || !meta.sourceID || !meta.device) continue
    const existing = db.prepare(`SELECT id FROM session WHERE json_extract(metadata,'$.imported.source') = ? AND json_extract(metadata,'$.imported.sourceID') = ? AND json_extract(metadata,'$.imported.device') = ?`)
      .get(String(meta.source), String(meta.sourceID), String(meta.device)) as { id: string } | undefined
    if (!existing || existing.id === row.id) continue
    ids.set(String(row.id), existing.id)
    // Compare full part payloads, not turn counts. Repeated messages consume
    // distinct target slots so identical text appearing twice stays twice.
    const target = db.prepare('SELECT * FROM message WHERE session_id = ? ORDER BY time_created, id').all(existing.id) as Row[]
    const available = new Map<string, Row[]>()
    const signature = (data: SQLInputValue | undefined, parts: Row[]) => JSON.stringify([
      readMetadata(data).role,
      parts.map((p) => readMetadata(p.data)),
    ])
    for (const message of target) {
      const parts = db.prepare('SELECT * FROM part WHERE message_id = ? ORDER BY id').all(message.id!) as Row[]
      const key = signature(message.data, parts)
      available.set(key, [...(available.get(key) ?? []), message])
    }
    for (const record of incoming.filter((r) => r.table === "message" && r.row.session_id === row.id)) {
      const parts = incoming.filter((r) => r.table === "part" && r.row.message_id === record.row.id).map((r) => r.row).sort((a, b) => String(a.id).localeCompare(String(b.id)))
      const match = available.get(signature(record.row.data, parts))?.shift()
      if (!match) continue
      ids.set(String(record.row.id), String(match.id))
      const targetParts = db.prepare('SELECT * FROM part WHERE message_id = ? ORDER BY id').all(match.id!) as Row[]
      parts.forEach((p, i) => { if (targetParts[i]) ids.set(String(p.id), String(targetParts[i]!.id)) })
    }
  }
  function rewrite(value: unknown): unknown {
    if (typeof value === "string") return ids.get(value) ?? value
    if (Array.isArray(value)) return value.map(rewrite)
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)]))
    return value
  }
  return incoming.map(({ table, row }) => ({ table, row: Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (typeof value !== "string") return [key, value]
    if (key === "data" || key === "metadata") {
      try { return [key, JSON.stringify(rewrite(JSON.parse(value)))] } catch { return [key, value] }
    }
    return [key, ids.get(value) ?? value]
  })) }))
}

/** Merge identities, not array positions or turn counts. All revisions remain in history. */
export function mergeRecords(db: DatabaseSync, incoming: RecordEntry[]) {
  init(db)
  const tally = { imported: 0, merged: 0, skipped: 0 }
  db.exec("BEGIN IMMEDIATE")
  try {
    for (const record of incoming) remember(db, record)
    incoming = reconcileSourceIDs(db, incoming)
    for (const table of TABLES) {
      const schema = columns(db, table)
      if (!schema.length && incoming.some((r) => r.table === table)) throw error(`target schema lacks ${table}`)
      const keys = schema.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name)
      for (const record of incoming.filter((r) => r.table === table)) {
        if (!keys.length || keys.some((k) => record.row[k] == null)) throw error(`invalid identity for ${table}`)
        const names = Object.keys(record.row).filter((k) => schema.some((c) => c.name === k))
        const predicate = keys.map((k) => `${quote(k)} = ?`).join(" AND ")
        const values = keys.map((k) => record.row[k]!)
        const existing = db.prepare(`SELECT * FROM ${quote(table)} WHERE ${predicate}`).get(...values) as Row | undefined
        remember(db, record)
        if (existing) {
          remember(db, { table, row: existing })
          if (names.every((k) => record.row[k] === existing[k])) { tally.skipped++; continue }
          // Existing history wins a timestamp tie, but the incoming revision is
          // retained and travels on the next export rather than being discarded.
          const changed = Number(record.row.time_updated ?? record.row.time_created ?? record.row.seq ?? 0)
          const current = Number(existing.time_updated ?? existing.time_created ?? existing.seq ?? 0)
          if (changed <= current) { tally.skipped++; continue }
          const fields = names.filter((k) => !keys.includes(k))
          db.prepare(`UPDATE ${quote(table)} SET ${fields.map((k) => `${quote(k)} = ?`).join(",")} WHERE ${predicate}`)
            .run(...fields.map((k) => record.row[k]!), ...values)
          tally.merged++
        } else {
          db.prepare(`INSERT INTO ${quote(table)} (${names.map(quote).join(",")}) VALUES (${names.map(() => "?").join(",")})`)
            .run(...names.map((k) => record.row[k]!))
          tally.imported++
        }
      }
    }
    db.exec("COMMIT")
    return tally
  } catch (e) { db.exec("ROLLBACK"); throw e }
}

/** Export current records plus immutable revisions previously imported or observed. */
export async function exportArchive(db: DatabaseSync, file: string, sources: IndexEntry[],
  report: (done: number, total: number) => void = () => {}, aborted: () => boolean = () => false) {
  init(db)
  db.exec("BEGIN")
  let count = 0, sessions = 0
  const current = new Set<string>()
  try {
    for (const r of records(db)) { remember(db, r); current.add(hash(JSON.stringify(r))); count++; if (r.table === "session") sessions++ }
    db.exec("COMMIT")
  }
  catch (e) { db.exec("ROLLBACK"); throw e }
  const failures: Array<{ key: string; error: string }> = []
  for (const [i, source] of sources.entries()) {
    if (aborted()) throw error("export cancelled before completion")
    report(i, sources.length)
    // PCP credentials and device-specific import cursors are not portable identities.
    const { pcp: _pcp, imported: _imported, ...descriptor } = source
    let record: SourceRecord = { descriptor }
    try {
      const raw = await fsp.readFile(source.file)
      // Chunk raw provider history so SQLite/V8 never parses a giant JSON
      // parameter. The chunks retain every byte, including large tool output.
      const chunkSize = 512 * 1024
      const rawHash = hash(raw.toString("base64"))
      for (let offset = 0; offset < raw.length; offset += chunkSize) {
        remember(db, { source: { descriptor: { key: source.key, device: source.device, rawHash, offset, totalBytes: raw.length }, raw: raw.subarray(offset, offset + chunkSize).toString("base64") } })
      }
      record = { descriptor: { ...descriptor, rawHash },
        ...(source.imported || source.size > 1024 * 1024 ? {} : { turns: await readTurns(source, 1024 * 1024) }) }
    } catch {
      record.unavailable = true
      // Preserve the descriptor and earlier payload even after a drive or device disappears.
      failures.push({ key: source.key, error: "Source pointer unavailable; retained prior archive records and descriptor" })
    }
    remember(db, { source: record })
  }
  const historyCount = (db.prepare(`SELECT COUNT(*) n FROM ${HISTORY}`).get() as { n: number }).n
  const completion: Stored = { operation: { id: randomUUID(), action: "export", at: Date.now(), outcome: `completed: ${sessions} sessions` } }
  const completionJSON = JSON.stringify(completion)
  const result = await Archive.writeTarGz(file, (async function* () {
    let i = 0
    for (const row of db.prepare(`SELECT hash, payload FROM ${HISTORY} ORDER BY hash`).iterate()) {
      const r = row as { hash: string; payload: string }
      if (aborted()) throw error("export cancelled before completion")
      yield { name: `${current.has(r.hash) ? "records" : "history"}/${r.hash}.json`, data: r.payload }
      report(++i, historyCount)
    }
    yield { name: `history/${hash(completionJSON)}.json`, data: completionJSON }
    yield { name: "manifest.json", data: JSON.stringify({ version: 2, exportedAt: new Date().toISOString(),
      layout: "record-files", sessions, records: count, revisions: historyCount + 1, failures }) }
  })())
  remember(db, completion)
  return { file, ...result, sessions, failures }
}

/** Import raw database records; archived source payloads remain exportable without source paths. */
export async function importArchive(db: DatabaseSync, file: string, handle: Handle) {
  init(db)
  // Record-file archives validate in a streaming first pass, then merge by
  // dependency order. No complete archive is retained in the JavaScript heap.
  let layout = false
  for await (const entry of Archive.readTarGz(file, 8 * 1024 ** 3)) {
    if (entry.name.startsWith("records/") || entry.name.startsWith("history/")) {
      const payload = entry.data.toString()
      if (!entry.name.endsWith(`/${hash(payload)}.json`)) throw error("archive history checksum mismatch")
      JSON.parse(payload)
    }
    if (entry.name === "manifest.json") layout = JSON.parse(entry.data.toString()).layout === "record-files"
  }
  if (layout) {
    const tally = { imported: 0, merged: 0, skipped: 0, empty: 0, failed: 0 }
    const batch: RecordEntry[] = []
    for await (const entry of Archive.readTarGz(file, 8 * 1024 ** 3)) {
      if (entry.name.startsWith("records/")) batch.push(JSON.parse(entry.data.toString()) as RecordEntry)
    }
    handle.step(0, batch.length, "Merging database identities")
    // Only current database rows are batched. Raw provider payloads and retained
    // revisions never accumulate in memory with the database records.
    const result = mergeRecords(db, batch)
    Object.assign(tally, result)
    batch.length = 0
    for await (const entry of Archive.readTarGz(file, 8 * 1024 ** 3)) {
      if (entry.name.startsWith("history/")) remember(db, JSON.parse(entry.data.toString()) as Stored)
    }
    handle.log(`Merged full-history archive: ${tally.imported} inserted, ${tally.merged} updated, ${tally.skipped} unchanged`)
    return tally
  }
  const entries: Array<{ name: string; data: Buffer }> = []
  for await (const entry of Archive.readTarGz(file)) entries.push(entry)
  const manifest = entries.find((e) => e.name === "manifest.json")
  if (!manifest || JSON.parse(manifest.data.toString()).version !== 2) throw error("full-history import requires a version 2 archive")
  const database = entries.find((e) => e.name === "database.json")
  if (!database) throw error("archive lacks database.json")
  if (JSON.parse(manifest.data.toString()).databaseHash !== hash(database.data.toString())) throw error("database checksum mismatch")
  const parsed = JSON.parse(database.data.toString()) as { records: RecordEntry[] }
  if (!Array.isArray(parsed.records) || parsed.records.some((r) => !TABLES.includes(r.table as typeof TABLES[number]) || !r.row)) throw error("invalid database record set")
  // Validate the entire archive before the first write; a broken history
  // member must not leave a partially restored database.
  for (const entry of entries.filter((e) => e.name.startsWith("history/"))) {
    const payload = entry.data.toString("utf8")
    if (entry.name !== `history/${hash(payload)}.json`) throw error("archive history checksum mismatch")
    JSON.parse(payload)
  }
  handle.step(0, entries.length, "Merging complete session records")
  const tally = mergeRecords(db, parsed.records)
  let done = 0
  for (const entry of entries) {
    if (entry.name.startsWith("history/")) {
      const payload = entry.data.toString("utf8")
      if (entry.name !== `history/${hash(payload)}.json`) throw error("archive history checksum mismatch")
      remember(db, JSON.parse(payload) as Stored)
    }
    handle.step(++done, entries.length, `Restoring history ${done}/${entries.length}`)
    if (done % 100 === 0) { handle.log(`Restored ${done}/${entries.length} history records`); await new Promise((r) => setTimeout(r, 0)) }
  }
  // Materialize source-only sessions as text for compatibility; their complete
  // original payload is retained even when the provider has no OpenCode converter.
  const stored = db.prepare(`SELECT payload FROM ${HISTORY}`).all() as Array<{ payload: string }>
  const latest = new Map<string, SourceRecord>()
  for (const r of stored) {
    const record = JSON.parse(r.payload) as { source?: SourceRecord }
    const source = record.source
    if (!source?.turns?.length) continue
    const identity = JSON.stringify([source.descriptor.device, source.descriptor.kind, source.descriptor.nativeID ?? source.descriptor.key])
    const previous = latest.get(identity)
    if (!previous || Number(source.descriptor.modified) > Number(previous.descriptor.modified)) latest.set(identity, source)
  }
  for (const source of latest.values()) {
    const d = source.descriptor
    const kind = String(d.kind ?? "archive")
    const id = String(d.nativeID ?? String(d.key).slice(kind.length + 1))
    const device = String(d.device ?? "archive")
    const exists = db.prepare(`SELECT id FROM session WHERE json_extract(metadata,'$.imported.source') = ? AND json_extract(metadata,'$.imported.sourceID') = ? AND json_extract(metadata,'$.imported.device') = ?`).get(kind, id, device) as { id: string } | undefined
    if (exists) {
      const parts = db.prepare(`SELECT p.data FROM message m JOIN part p ON p.message_id = m.id WHERE m.session_id = ? ORDER BY m.time_created, m.id, p.id`).all(exists.id) as Array<{ data: string }>
      const text = parts.map((p) => JSON.parse(p.data) as { type?: string; text?: string }).filter((p) => p.type === "text").map((p) => p.text)
      // Only proven prefixes may be extended. Equal counts do not imply equal
      // contents; divergent histories remain intact in the revision store.
      if (text.length < source.turns!.length && text.every((t, i) => t === source.turns![i]?.text)) {
        const target = Identity.resolveOffline({ directory: String(d.directory ?? ""), recordedRemote: typeof d.remote === "string" ? d.remote : null })
        DB.appendTurns(db, { sessionID: exists.id, target, turns: source.turns!.slice(text.length), model: String(d.model ?? ""), source: kind })
        tally.merged++
      }
      continue
    }
    const target = Identity.resolveOffline({ directory: String(d.directory ?? ""), recordedRemote: typeof d.remote === "string" ? d.remote : null })
    DB.importSession(db, { target, title: String(d.sourceTitle || d.title || id), turns: source.turns!,
      created: Number(d.created) || Date.now(), model: String(d.model ?? ""), source: kind, sourceID: id, device })
    tally.imported++
  }
  handle.log(`Merged archive records: ${tally.imported} inserted, ${tally.merged} updated, ${tally.skipped} unchanged`)
  return { ...tally, empty: 0, failed: 0 }
}

export async function exportLocal(file: string, _planned: IndexEntry[], report?: (done: number, total: number) => void, aborted?: () => boolean) {
  const db = DB.open()
  try {
    init(db)
    remember(db, { operation: { id: randomUUID(), action: "export", at: Date.now(), outcome: "started" } })
    const result = await exportArchive(db, file, Object.values((await Index.load()).entries), report, aborted)
    remember(db, { operation: { id: randomUUID(), action: "export", at: Date.now(), outcome: `completed: ${result.sessions} sessions` } })
    return result
  } catch (e) {
    remember(db, { operation: { id: randomUUID(), action: "export", at: Date.now(), outcome: `failed: ${e instanceof Error ? e.message : String(e)}` } })
    throw e
  } finally { db.close() }
}
export async function importLocal(file: string, handle: Handle) {
  const db = DB.open()
  try {
    init(db)
    const result = await importArchive(db, file, handle)
    remember(db, { operation: { id: randomUUID(), action: "import", at: Date.now(), outcome: JSON.stringify(result) } })
    return result
  } catch (e) {
    remember(db, { operation: { id: randomUUID(), action: "import", at: Date.now(), outcome: `failed: ${e instanceof Error ? e.message : String(e)}` } })
    throw e
  } finally { db.close() }
}

/** Incremental directory transfer. Archives are reserved for explicit export. */
export async function publishDirectory(db: DatabaseSync, root: string, device: string,
  report: (done: number, total: number) => void = () => {}) {
  init(db)
  const sessions = db.prepare('SELECT * FROM session ORDER BY id').all() as Row[]
  const safe = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 80) || "unnamed"
  async function put(relative: string, payload: string) {
    const file = path.join(root, relative)
    if (await fsp.readFile(file, "utf8").catch(() => "") === payload) return
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
    await fsp.writeFile(temp, payload)
    await fsp.rename(temp, file)
  }
  let written = 0
  for (const session of sessions) {
    const id = String(session.id)
    const project = db.prepare('SELECT * FROM project WHERE id = ?').get(session.project_id!) as Row
    const projectFolder = `${safe(String(project.name || project.worktree || "project").split(/[\\/]/).pop()!)}-${hash(String(project.id)).slice(0, 10)}`
    const items: RecordEntry[] = [{ table: "project", row: project }]
    for (const table of TABLES.filter((t) => t !== "project")) {
      if (!columns(db, table).length) continue
      let rows: Row[] = []
      if (table === "project_directory") rows = db.prepare('SELECT * FROM project_directory WHERE project_id = ?').all(session.project_id!) as Row[]
      else if (table === "workspace") rows = session.workspace_id ? db.prepare('SELECT * FROM workspace WHERE id = ?').all(session.workspace_id) as Row[] : []
      else if (table === "session") rows = [session]
      else if (table === "event" || table === "event_sequence") rows = db.prepare(`SELECT * FROM ${quote(table)} WHERE aggregate_id = ?`).all(id) as Row[]
      else rows = db.prepare(`SELECT * FROM ${quote(table)} WHERE session_id = ?`).all(id) as Row[]
      for (const row of rows) items.push({ table, row })
    }
    const payload = JSON.stringify({ version: 1, device, records: items })
    // Immutable revisions let devices publish independently without overwriting
    // each other's updates or using a shared mutable cursor.
    const digest = hash(payload)
    await put(path.join("projects", projectFolder, "imported", safe(id), `${safe(device)}-${digest}.json`), payload)
    for (const record of items) remember(db, record)
    report(++written, sessions.length)
    if (written % 10 === 0) await new Promise((r) => setTimeout(r, 0))
  }
  // Original provider payloads, superseded records and operation history are
  // independent of paths and remain available on a newly configured device.
  for (const row of db.prepare(`SELECT hash,payload FROM ${HISTORY}`).iterate()) {
    const r = row as { hash: string; payload: string }
    const record = JSON.parse(r.payload) as RecordEntry
    // Current records are already present in their project/session revision;
    // only superseded records need another entry in the retained-history tree.
    if (record.table && record.row) {
      const schema = columns(db, record.table)
      const keys = schema.filter((c) => c.pk).map((c) => c.name)
      if (keys.length) {
        const current = db.prepare(`SELECT * FROM ${quote(record.table)} WHERE ${keys.map((k) => `${quote(k)} = ?`).join(" AND ")}`).get(...keys.map((k) => record.row[k]!))
        if (current && hash(JSON.stringify({ table: record.table, row: current })) === r.hash) continue
      }
    }
    await put(path.join(record.table ? "conflicts" : "history", r.hash.slice(0, 2), `${r.hash}.json`), r.payload)
  }
  return written
}

export async function readDirectoryFile(db: DatabaseSync, file: string) {
  const payload = await fsp.readFile(file, "utf8")
  const parsed = JSON.parse(payload)
  if (Array.isArray(parsed.records) && parsed.version === 1) return mergeRecords(db, parsed.records)
  // History is content-addressed and cannot silently change beneath a cursor.
  if (path.basename(file) !== `${hash(payload)}.json`) throw error("directory history checksum mismatch")
  init(db)
  remember(db, parsed as Stored)
  const source = parsed.source as SourceRecord | undefined
  if (source?.turns?.length) {
    const d = source.descriptor
    const kind = String(d.kind ?? "archive")
    const nativeID = String(d.nativeID ?? String(d.key).slice(kind.length + 1))
    const device = String(d.device ?? "archive")
    const exists = db.prepare(`SELECT id FROM session WHERE json_extract(metadata,'$.imported.source') = ? AND json_extract(metadata,'$.imported.sourceID') = ? AND json_extract(metadata,'$.imported.device') = ?`).get(kind, nativeID, device)
    if (!exists) {
      const target = Identity.resolveOffline({ directory: String(d.directory ?? ""), recordedRemote: typeof d.remote === "string" ? d.remote : null })
      DB.importSession(db, { target, title: String(d.sourceTitle || d.title || nativeID), turns: source.turns,
        created: Number(d.created) || Date.now(), model: String(d.model ?? ""), source: kind, sourceID: nativeID, device })
      return { imported: 1, merged: 0, skipped: 0 }
    }
  }
  return { imported: 0, merged: 0, skipped: 1 }
}
