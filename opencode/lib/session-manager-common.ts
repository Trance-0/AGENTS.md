/**
 * session-manager — unify every coding-agent session across devices.
 *
 * Ports the dsh `session-sync` / codex `session-importer` plugins. It indexes
 * the Claude Code, Codex and dsh session stores, watches them for changes, and
 * lazily imports transcripts into opencode's own database on request.
 *
 * Design notes:
 *   - The index (`~/.config/opencode/session-index.json`) is the source of
 *     truth for what exists and what has been imported. It is cheap to rebuild.
 *   - Every entry records the device it was observed on, so an index shared
 *     between machines never reports another device's sessions as missing.
 *   - Projects merge on the git remote URL when one is known — which is what
 *     lets the same repository checked out at different paths on different
 *     devices collapse into one project — and on the directory name otherwise.
 *   - Imports are lazy: `session_scan` only records what changed; rows are
 *     written when `session_import` or `session_sync_all` asks for them.
 *   - An append-only source that grew after import merges its new tail into the
 *     existing session. A source rewritten under the same id branches into a
 *     new session so nothing is silently rewritten.
 *   - Transcripts go to three independent destinations, each with its own
 *     cursor: opencode's database, a PCP deployment, and a local `.tar.gz`.
 *     The archive is the only one readable with no server and no database,
 *     which is what makes it the usable form of a backup.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import * as Index from "./index-store.ts"
import * as DB from "./db.ts"
import * as Identity from "./project-identity.ts"
import * as Desktop from "./desktop.ts"
import * as Registry from "./registry.ts"
import * as PCP from "./pcp.ts"
import * as Logs from "./logs.ts"
import * as Archive from "./archive.ts"
import * as Progress from "./progress.ts"
import * as Transfer from "./session-transfer.ts"
import * as DirectorySync from "./directory-sync.ts"
import { LARGE_FILE_BYTES, readTurns, scanAll } from "./sources.ts"
import { local as localDevice } from "./device.ts"
import { DATA_DIR } from "./paths.ts"
import type { IndexEntry } from "./index-store.ts"
import path from "node:path"
import fsp from "node:fs/promises"

type Logger = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void

const PLUGIN_ID = "session-manager"

/** Shared across every instance of this plugin in the process. */
const SWEEP_KEY = Symbol.for("@dsh/opencode-session-manager-sweep")

/** Bound the number of turns copied from a single transcript. */
const MAX_TURNS = 4000

/** Minimum gap between background sweeps. */
const RESCAN_INTERVAL_MS = 10 * 60 * 1000

/**
 * Where a `.tar.gz` export lands when the user names no directory.
 *
 * Under the data directory rather than the config one: an archive is a dump of
 * operational data, and must not travel when the config is copied to another
 * machine — which is the very thing the archive itself is for.
 */
const EXPORT_DIR = path.join(DATA_DIR, "session-exports")

function summarize(entry: IndexEntry) {
  return {
    key: entry.key,
    kind: entry.kind,
    device: entry.device,
    title: entry.title,
    // The name the originating tool shows, when it keeps one of its own.
    // Codex titles a thread with a summary that never appears in the
    // transcript, so without this the session is unfindable by the only name
    // the user knows it by.
    sourceTitle: entry.sourceTitle ?? null,
    directory: entry.directory,
    remote: entry.remote ?? null,
    branch: entry.branch ?? null,
    model: entry.model || null,
    modified: new Date(entry.modified).toISOString(),
    sizeKB: Math.round(entry.size / 1024),
    imported: entry.imported ? entry.imported.sessionID : null,
    project: entry.imported ? entry.imported.projectID : null,
    conflict: entry.conflict ?? null,
    missing: entry.missing ?? false,
  }
}

/** How each session source is labelled on a card. */
const SOURCE_LABEL: Record<string, string> = {
  opencode: "opencode",
  claude: "Claude Code",
  codex: "Codex",
  dsh: "dsh",
}

/**
 * The chips offered over the projects tree, worst state first.
 *
 * "Which projects still owe an import" is the question the tree is usually
 * asked, and answering it previously meant expanding every project in turn.
 */
const PROJECT_STATUS = ["conflict", "pending", "synced"] as const

function projectStatus(state: { pending: number; conflicts: number }): (typeof PROJECT_STATUS)[number] {
  if (state.conflicts > 0) return "conflict"
  if (state.pending > 0) return "pending"
  return "synced"
}

/**
 * Why one transcript is still awaiting review.
 *
 * `rewritten` is the only one that loses something on import — it branches into
 * a new session rather than merging — so it is worth naming separately from a
 * transcript that merely grew. `empty` is a source file with no bytes in it,
 * which an import can only skip; without its own name it would sit under
 * "pending" forever, making that count permanently unreachable.
 */
const REVIEW_STATE = ["rewritten", "grown", "pending", "empty"] as const

/** Rows the pending table shows before it starts truncating. */
const REVIEW_LIMIT = 200

function reviewState(entry: IndexEntry): (typeof REVIEW_STATE)[number] {
  if (entry.conflict === "rewritten") return "rewritten"
  if (entry.conflict === "grown") return "grown"
  if (entry.emptyAt === entry.fingerprint) return "empty"
  return "pending"
}

/** Compare paths the way the two stores spell them: either slash, either case. */
function normalize(directory: string): string {
  return directory.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

/**
 * Split a panel control's `"<input>=<value>"` argument.
 *
 * The dashboard prefixes a control's `input` onto the value the user supplied,
 * so a project id arrives joined to the new name. Only the first `=` separates
 * them: a value may legitimately contain more (a remote URL with a query).
 */
function splitInput(input?: string): [string, string] {
  if (!input) return ["", ""]
  const at = input.indexOf("=")
  if (at === -1) return [input.trim(), ""]
  return [input.slice(0, at).trim(), input.slice(at + 1).trim()]
}


export { Index, DB, Identity, Desktop, Registry, PCP, Logs, Archive, Progress, Transfer, DirectorySync, LARGE_FILE_BYTES, readTurns, scanAll, localDevice, DATA_DIR, path, fsp, tool, PLUGIN_ID, SWEEP_KEY, MAX_TURNS, RESCAN_INTERVAL_MS, summarize, SOURCE_LABEL, REVIEW_STATE, REVIEW_LIMIT, PROJECT_STATUS, projectStatus, EXPORT_DIR, reviewState, normalize, splitInput }
export type { Plugin, Logger, IndexEntry }
