/**
 * Durable session index.
 *
 * Holds one entry per external session seen on this device plus the state of
 * its import into opencode. A rescan diffs the live stores against the stored
 * fingerprints and classifies every entry as added / grown / unchanged /
 * missing, which is what drives lazy importing and conflict handling.
 */

import fsp from "node:fs/promises"
import path from "node:path"
import { STATE } from "./paths.ts"
import { local as localDevice } from "./device.ts"
import type { SourceKind, SourceSession } from "./sources.ts"

export type ImportState = {
  /** opencode session id this entry was imported into. */
  sessionID: string
  projectID: string
  /** How the project id was derived, for reporting. */
  projectSource?: string
  /** Fingerprint of the source file at the time of import. */
  fingerprint: string
  turns: number
  importedAt: number
  /** Device that performed the import. */
  device?: string
}

/**
 * State of this entry's upload to a PCP deployment.
 *
 * Kept separate from `imported` because the two destinations are independent:
 * a transcript can be imported into the local opencode database, pushed to the
 * remote store, or both, and each keeps its own append cursor.
 */
export type PushState = {
  /** PCP session id this entry was pushed to. */
  sessionID: string
  /** Per-session access token minted by the manager API. */
  accessToken?: string
  /** Turns already uploaded; the resume point for the next push. */
  turns: number
  /** Fingerprint of the source file at the time of the push. */
  fingerprint: string
  pushedAt: number
}

export type IndexEntry = SourceSession & {
  /** Present once the session has been imported into opencode's database. */
  imported?: ImportState
  /** Present once the session has been pushed to PCP. */
  pcp?: PushState
  /** Set when the source changed after import and a decision is pending. */
  conflict?: "grown" | "rewritten"
  /** Set when the source file disappeared. */
  missing?: boolean
}

export type Index = {
  version: 1
  updatedAt: number
  /** Device that last wrote this index. */
  device?: string
  /** Every device that has contributed entries, for cross-device reporting. */
  devices?: Record<string, { hostname: string; lastSeen: number }>
  entries: Record<string, IndexEntry>
}

export type ScanDiff = {
  added: string[]
  grown: string[]
  rewritten: string[]
  unchanged: string[]
  missing: string[]
}

function empty(): Index {
  return { version: 1, updatedAt: 0, entries: {} }
}

export async function load(): Promise<Index> {
  try {
    const parsed = JSON.parse(await fsp.readFile(STATE.sessionIndex, "utf8"))
    if (parsed?.version === 1 && parsed.entries && typeof parsed.entries === "object") return parsed as Index
  } catch {
    // Missing or corrupt index — start over; it is fully derivable from disk.
  }
  return empty()
}

export async function save(index: Index): Promise<void> {
  const device = await localDevice()
  index.updatedAt = Date.now()
  index.device = device.id
  index.devices = { ...index.devices, [device.id]: { hostname: device.hostname, lastSeen: index.updatedAt } }

  await fsp.mkdir(path.dirname(STATE.sessionIndex), { recursive: true })
  const temp = STATE.sessionIndex + ".tmp"
  await fsp.writeFile(temp, JSON.stringify(index, null, 2) + "\n", "utf8")
  await fsp.rename(temp, STATE.sessionIndex)
}

/**
 * Fold a fresh scan into the index.
 *
 * A source that grew since its import is a `grown` conflict (append-only, safe
 * to merge by importing the new tail). A source whose size shrank or whose
 * content was rewritten under the same id is a `rewritten` conflict, which can
 * only be resolved by branching into a new opencode session.
 */
export function reconcile(index: Index, scanned: SourceSession[], device?: string): ScanDiff {
  const diff: ScanDiff = { added: [], grown: [], rewritten: [], unchanged: [], missing: [] }
  const seen = new Set<string>()
  const scanningDevice = device ?? scanned[0]?.device

  for (const session of scanned) {
    seen.add(session.key)
    const existing = index.entries[session.key]

    if (!existing) {
      index.entries[session.key] = { ...session }
      diff.added.push(session.key)
      continue
    }

    // Refresh the descriptor but preserve import and push bookkeeping.
    const imported = existing.imported
    index.entries[session.key] = {
      ...session,
      ...(imported ? { imported } : {}),
      ...(existing.pcp ? { pcp: existing.pcp } : {}),
    }
    const entry = index.entries[session.key]

    if (!imported) {
      if (existing.fingerprint !== session.fingerprint) diff.grown.push(session.key)
      else diff.unchanged.push(session.key)
      continue
    }

    if (imported.fingerprint === session.fingerprint) {
      diff.unchanged.push(session.key)
      continue
    }

    const [importedSize] = imported.fingerprint.split(":")
    if (session.size >= Number(importedSize)) {
      entry.conflict = "grown"
      diff.grown.push(session.key)
    } else {
      entry.conflict = "rewritten"
      diff.rewritten.push(session.key)
    }
  }

  for (const [key, entry] of Object.entries(index.entries)) {
    if (seen.has(key)) {
      delete entry.missing
      continue
    }
    // A scan only covers the stores of the device running it, so entries
    // contributed by another device are absent by design, not missing.
    if (scanningDevice && entry.device && entry.device !== scanningDevice) continue
    entry.missing = true
    diff.missing.push(key)
  }

  return diff
}

export function stats(index: Index) {
  const byKind: Record<SourceKind | string, { total: number; imported: number }> = {}
  const byDevice: Record<string, { total: number; imported: number }> = {}
  let imported = 0
  let conflicts = 0
  let missing = 0

  for (const entry of Object.values(index.entries)) {
    const kind = (byKind[entry.kind] ??= { total: 0, imported: 0 })
    kind.total++

    const device = (byDevice[entry.device ?? "unknown"] ??= { total: 0, imported: 0 })
    device.total++

    if (entry.imported) {
      kind.imported++
      device.imported++
      imported++
    }
    if (entry.conflict) conflicts++
    if (entry.missing) missing++
  }

  return { total: Object.keys(index.entries).length, imported, conflicts, missing, byKind, byDevice }
}
