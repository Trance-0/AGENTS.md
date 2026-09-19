/**
 * Scanners for the external coding-agent session stores on this device.
 *
 * Each scanner returns `SourceSession` descriptors cheaply (stat + a bounded
 * head read) so indexing thousands of transcripts stays fast; the full turn
 * list is only materialised when a session is actually read or imported.
 *
 * Formats understood:
 *   claude — ~/.claude/projects/<slug>/<uuid>.jsonl, plain JSONL
 *   codex  — ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, plain JSONL
 *   dsh    — ~/.dsh/sessions/<slug>/<uuid>/session.v2.jsonl.zstd,
 *            one or more concatenated zstd frames of JSONL
 */

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import zlib from "node:zlib"
import { SOURCES } from "./paths.ts"
import { local as localDevice } from "./device.ts"

export type SourceKind = "claude" | "codex" | "dsh"

export type Turn = {
  role: "user" | "assistant"
  text: string
  time?: number
}

export type SourceSession = {
  /** Stable key: `<kind>:<native session id>`. */
  key: string
  kind: SourceKind
  /** Native session id as recorded by the originating tool. */
  nativeID: string
  file: string
  /** Working directory the session ran in, when recorded. */
  directory: string
  /**
   * Git remote recorded in the transcript, when the tool captured one. This is
   * what lets a session from another device resolve to the right project even
   * though its directory does not exist here.
   */
  remote: string | null
  /** Branch recorded in the transcript, for reporting only. */
  branch: string | null
  /** Identifier of the device whose store this session was read from. */
  device: string
  title: string
  model: string
  created: number
  modified: number
  size: number
  /** `size:mtimeMs` — changes whenever the transcript grows. */
  fingerprint: string
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Sessions above this size are indexed but never fully parsed by default. */
export const LARGE_FILE_BYTES = 64 * 1024 * 1024

async function walk(dir: string, suffix: string): Promise<string[]> {
  const out: string[] = []
  async function recurse(current: string) {
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await recurse(full)
      else if (entry.name.endsWith(suffix)) out.push(full)
    }
  }
  await recurse(dir)
  return out
}

/** Read at most `bytes` from the head of a file. */
async function head(file: string, bytes: number): Promise<string> {
  const handle = await fsp.open(file, "r")
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead).toString("utf8")
  } finally {
    await handle.close()
  }
}

function parseLines(text: string): any[] {
  const out: any[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // A truncated trailing line is expected when reading a bounded head.
    }
  }
  return out
}

/**
 * dsh writes each append as its own zstd frame, so the file is a concatenation
 * of frames rather than a single stream. Decode them one at a time, stopping
 * once `limitBytes` of output has been produced.
 */
function decodeZstdFrames(buffer: Buffer, limitBytes = Infinity): string {
  let out = ""
  let pos = 0
  while (pos < buffer.length && out.length < limitBytes) {
    const next = buffer.indexOf(ZSTD_MAGIC, pos + 4)
    const end = next < 0 ? buffer.length : next
    try {
      out += zlib.zstdDecompressSync(buffer.subarray(pos, end)).toString("utf8")
    } catch {
      break
    }
    if (next < 0) break
    pos = next
  }
  return out
}

/**
 * Turns whose text is entirely tool-injected scaffolding rather than something
 * the user typed. All three tools prepend these to the transcript, so they must
 * be skipped when choosing a title.
 */
const SYNTHETIC = [
  /^<environment_context>/,
  /^<permissions instructions>/,
  /^<app-context>/,
  /^<skills_instructions>/,
  /^<collaboration_mode/,
  /^<turn_aborted>/,
  /^<user_instructions>/,
  /^<system-reminder>/,
  /^<INSTRUCTIONS>/,
  /^#\s*AGENTS\.md instructions/i,
  /^Caveat: The messages below were generated/i,
  /^<command-name>/,
  /^<local-command-stdout>/,
  /^<recommended_plugins>/,
  /^<plugin_instructions>/,
]

function isSynthetic(text: string): boolean {
  const trimmed = text.trimStart()
  if (trimmed === "") return true
  return SYNTHETIC.some((pattern) => pattern.test(trimmed))
}

/** Condense a user turn into a one-line session title. */
function titleFrom(text: string): string {
  const stripped = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return stripped.slice(0, 120)
}

/** Pick the first genuine user turn as the session title. */
function titleOf(turns: Turn[]): string {
  for (const turn of turns) {
    if (turn.role !== "user" || isSynthetic(turn.text)) continue
    const title = titleFrom(turn.text)
    if (title) return title
  }
  return "(untitled)"
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

function claudeText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((block: any) => block && (block.type === "text" || block.type === "output_text"))
    .map((block: any) => (typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n")
}

function claudeSummary(records: any[]) {
  let directory = ""
  let model = ""
  let created = 0
  let sessionID = ""
  let branch = ""
  for (const record of records) {
    if (!record || typeof record !== "object") continue
    if (typeof record.sessionId === "string" && !sessionID) sessionID = record.sessionId
    if (typeof record.cwd === "string" && record.cwd && !directory) directory = record.cwd
    if (typeof record.gitBranch === "string" && record.gitBranch && !branch) branch = record.gitBranch
    if (!created && typeof record.timestamp === "string") created = Date.parse(record.timestamp) || 0
    const message = record.message
    if (!message) continue
    if (typeof message.model === "string" && message.model && !model) model = message.model
  }
  // Claude Code records the branch but never the remote.
  return { directory, model, created, title: titleOf(claudeTurns(records)), sessionID, remote: "", branch }
}

export function claudeTurns(records: any[]): Turn[] {
  const turns: Turn[] = []
  for (const record of records) {
    if (!record || (record.type !== "user" && record.type !== "assistant")) continue
    const message = record.message
    if (!message) continue
    const role = message.role
    if (role !== "user" && role !== "assistant") continue
    const text = claudeText(message.content).trim()
    if (!text) continue
    turns.push({ role, text, time: Date.parse(record.timestamp) || undefined })
  }
  return turns
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

function codexText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((block: any) => block && (block.type === "input_text" || block.type === "output_text" || block.type === "text"))
    .map((block: any) => (typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n")
}

function codexSummary(records: any[]) {
  let directory = ""
  let model = ""
  let created = 0
  let sessionID = ""
  let remote = ""
  let branch = ""
  for (const record of records) {
    if (!record || typeof record !== "object") continue
    if (record.type === "session_meta") {
      const payload = record.payload ?? {}
      sessionID = payload.session_id || payload.id || sessionID
      directory = payload.cwd || directory
      created = Date.parse(payload.timestamp || record.timestamp) || created
      // Codex is the only source that records the remote, which makes its
      // sessions resolvable to a project from any device.
      if (payload.git?.repository_url) remote = String(payload.git.repository_url)
      if (payload.git?.branch) branch = String(payload.git.branch)
    }
    if (record.type === "turn_context" && record.payload?.model && !model) model = String(record.payload.model)
  }
  return { directory, model, created, title: titleOf(codexTurns(records)), sessionID, remote, branch }
}

export function codexTurns(records: any[]): Turn[] {
  const turns: Turn[] = []
  for (const record of records) {
    if (record?.type !== "response_item") continue
    const payload = record.payload
    if (!payload || payload.type !== "message") continue
    const role = payload.role
    if (role !== "user" && role !== "assistant") continue
    const text = codexText(payload.content).trim()
    if (!text) continue
    turns.push({ role, text, time: Date.parse(record.timestamp) || undefined })
  }
  return turns
}

// ---------------------------------------------------------------------------
// dsh
// ---------------------------------------------------------------------------

function dshMessageText(data: any): string {
  const content = data?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((block: any) => block && block.type === "text")
    .map((block: any) => (typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n")
}

function dshSummary(records: any[]) {
  let directory = ""
  let model = ""
  let created = 0
  let title = ""
  let sessionID = ""
  for (const record of records) {
    if (!record || typeof record !== "object") continue
    if (record.type === "session") {
      sessionID = record.id || sessionID
      directory = record.cwd || directory
      created = record.createdAt || created
    }
    if (record.type === "request/header" && !model) {
      const config = record.data?.header?.config
      if (config?.model) model = String(config.model)
    }
    // dsh records the agent-generated title directly; prefer it when present.
    if (record.type === "session/title" && !title) {
      const candidate = typeof record.data === "string" ? record.data : record.data?.title
      if (typeof candidate === "string" && candidate.trim()) title = titleFrom(candidate)
    }
  }
  return { directory, model, created, title: title || titleOf(dshTurns(records)), sessionID, remote: "", branch: "" }
}

export function dshTurns(records: any[]): Turn[] {
  const turns: Turn[] = []
  for (const record of records) {
    if (record?.type === "user/message") {
      const text = dshMessageText(record.data).trim()
      if (text) turns.push({ role: "user", text, time: record.time })
      continue
    }
    // Assistant turns nest the payload one level deeper under `data.message`.
    if (record?.type === "assistant/message" || record?.type === "response/message") {
      const text = dshMessageText(record.data?.message ?? record.data).trim()
      if (text) turns.push({ role: "assistant", text, time: record.time })
    }
  }
  return turns
}

// ---------------------------------------------------------------------------
// Unified scan / read
// ---------------------------------------------------------------------------

const HEAD_BYTES = 256 * 1024

async function describe(file: string, kind: SourceKind, device: string): Promise<SourceSession | null> {
  let stat: fs.Stats
  try {
    stat = await fsp.stat(file)
  } catch {
    return null
  }
  if (stat.size === 0) return null

  let records: any[]
  if (kind === "dsh") {
    const handle = await fsp.open(file, "r")
    try {
      const buffer = Buffer.alloc(Math.min(HEAD_BYTES, stat.size))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      records = parseLines(decodeZstdFrames(buffer.subarray(0, bytesRead), HEAD_BYTES))
    } finally {
      await handle.close()
    }
  } else {
    records = parseLines(await head(file, HEAD_BYTES))
  }
  if (records.length === 0) return null

  const summary = kind === "claude" ? claudeSummary(records) : kind === "codex" ? codexSummary(records) : dshSummary(records)

  const nativeID = summary.sessionID || path.basename(path.dirname(file)) || path.basename(file).replace(/\.\w+$/, "")

  return {
    // The native session id is a UUID/ULID, so it stays unique across devices;
    // the device is recorded separately rather than folded into the key so the
    // same session observed from a synced store is not double-imported.
    key: `${kind}:${nativeID}`,
    kind,
    nativeID,
    file,
    directory: summary.directory,
    remote: summary.remote || null,
    branch: summary.branch || null,
    device,
    title: summary.title || "(untitled)",
    model: summary.model,
    created: summary.created || stat.birthtimeMs || stat.mtimeMs,
    modified: stat.mtimeMs,
    size: stat.size,
    fingerprint: `${stat.size}:${stat.mtimeMs}`,
  }
}

/** Enumerate every session in every known external store. */
export async function scanAll(): Promise<SourceSession[]> {
  const device = (await localDevice()).id
  const jobs: Array<Promise<SourceSession | null>> = []

  for (const file of await walk(SOURCES.claude, ".jsonl")) jobs.push(describe(file, "claude", device))
  for (const file of await walk(SOURCES.codex, ".jsonl")) jobs.push(describe(file, "codex", device))
  for (const file of await walk(SOURCES.codexArchived, ".jsonl")) jobs.push(describe(file, "codex", device))
  for (const file of await walk(SOURCES.dsh, ".zstd")) jobs.push(describe(file, "dsh", device))

  const settled = await Promise.all(jobs)
  const sessions = settled.filter((entry): entry is SourceSession => entry !== null)

  // A session id can appear twice (e.g. a Codex rollout that was also archived);
  // keep whichever copy has the most content.
  const byKey = new Map<string, SourceSession>()
  for (const session of sessions) {
    const existing = byKey.get(session.key)
    if (!existing || session.size > existing.size) byKey.set(session.key, session)
  }
  return [...byKey.values()].sort((a, b) => b.modified - a.modified)
}

/** Fully parse one session's transcript into normalised turns. */
export async function readTurns(session: SourceSession, limitBytes = LARGE_FILE_BYTES): Promise<Turn[]> {
  let text: string
  if (session.kind === "dsh") {
    const buffer = await fsp.readFile(session.file)
    text = decodeZstdFrames(buffer, limitBytes)
  } else if (session.size > limitBytes) {
    text = await head(session.file, limitBytes)
  } else {
    text = await fsp.readFile(session.file, "utf8")
  }

  const records = parseLines(text)
  if (session.kind === "claude") return claudeTurns(records)
  if (session.kind === "codex") return codexTurns(records)
  return dshTurns(records)
}
