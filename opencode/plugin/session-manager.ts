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
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import * as Index from "../lib/index-store.ts"
import * as DB from "../lib/db.ts"
import * as Identity from "../lib/project-identity.ts"
import * as Desktop from "../lib/desktop.ts"
import * as Registry from "../lib/registry.ts"
import { LARGE_FILE_BYTES, readTurns, scanAll } from "../lib/sources.ts"
import { local as localDevice } from "../lib/device.ts"
import type { IndexEntry } from "../lib/index-store.ts"

type Logger = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void

/** Bound the number of turns copied from a single transcript. */
const MAX_TURNS = 4000

function summarize(entry: IndexEntry) {
  return {
    key: entry.key,
    kind: entry.kind,
    device: entry.device,
    title: entry.title,
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

export const SessionManager: Plugin = async ({ client, directory }) => {
  await Registry.init()

  const log: Logger = (level, message, extra) => {
    client.app
      .log({ body: { service: "session-manager", level, message, ...(extra ? { extra } : {}) } })
      .catch(() => {})
  }

  Registry.register({
    id: "session-manager",
    title: "Session Manager",
    description: "Index Claude Code, Codex and dsh transcripts and import them into opencode.",
    async settings() {
      return []
    },
    async update(key) {
      throw new Error(`session-manager has no editable settings (${key})`)
    },
    async status() {
      const index = await Index.load()
      const counts = Index.stats(index)
      const device = await localDevice()
      return [
        { label: "indexed", value: counts.total, tone: "muted" },
        { label: "imported", value: counts.imported, tone: counts.imported > 0 ? "ok" : "muted" },
        { label: "pending", value: counts.total - counts.imported, tone: counts.total > counts.imported ? "warn" : "muted" },
        { label: "conflicts", value: counts.conflicts, tone: counts.conflicts > 0 ? "error" : "muted" },
        { label: "device", value: device.id, tone: "muted" },
      ]
    },
    actions: {
      scan: {
        label: "Rescan stores",
        async run() {
          if (!Registry.isEnabled("session-manager")) return "session-manager is disabled"
          const device = await localDevice()
          const index = await Index.load()
          const scanned = await scanAll()
          const diff = Index.reconcile(index, scanned, device.id)
          await Index.save(index)
          return `scanned ${scanned.length}; ${diff.added.length} new, ${diff.grown.length} grown`
        },
      },
    },
  })

  /**
   * Build a resolver primed with every remote the index has seen.
   *
   * Sharing learned remotes across the whole index is what keeps sessions that
   * ran in one directory from splitting between a remote-keyed project and a
   * name-keyed one just because only some tools record the remote.
   */
  async function resolverFor(index: Index.Index) {
    const resolver = Identity.createResolver()
    await resolver.learn(Object.values(index.entries))
    return resolver
  }

  /** Index one source session into opencode, or merge/branch if already there. */
  async function importOne(
    entry: IndexEntry,
    resolver: ReturnType<typeof Identity.createResolver>,
    force: boolean,
  ) {
    const turns = (await readTurns(entry, LARGE_FILE_BYTES)).slice(0, MAX_TURNS)
    if (turns.length === 0) return { key: entry.key, status: "empty" as const }

    // The remote recorded in the transcript is what lets a session captured on
    // another device resolve onto the same project as its local counterparts.
    const target = await resolver.identify(entry.directory || directory)
    const db = DB.open()
    try {
      // Already imported and unchanged, unless the caller insists.
      if (entry.imported && !force && !entry.conflict && DB.sessionExists(db, entry.imported.sessionID)) {
        return { key: entry.key, status: "skipped" as const, sessionID: entry.imported.sessionID }
      }

      // Append-only growth merges the new tail into the existing session.
      if (entry.imported && entry.conflict === "grown" && DB.sessionExists(db, entry.imported.sessionID)) {
        const already = entry.imported.turns
        const tail = turns.slice(already)
        if (tail.length === 0) {
          entry.imported.fingerprint = entry.fingerprint
          delete entry.conflict
          return { key: entry.key, status: "up-to-date" as const, sessionID: entry.imported.sessionID }
        }
        const added = DB.appendTurns(db, {
          sessionID: entry.imported.sessionID,
          target,
          turns: tail,
          model: entry.model,
          source: entry.kind,
        })
        entry.imported.turns = turns.length
        entry.imported.fingerprint = entry.fingerprint
        delete entry.conflict
        log("info", `merged ${added} new turns into ${entry.imported.sessionID}`, { key: entry.key })
        return { key: entry.key, status: "merged" as const, sessionID: entry.imported.sessionID, added }
      }

      // Everything else (new, rewritten, or forced) becomes a fresh session.
      const branched = Boolean(entry.imported)
      const result = DB.importSession(db, {
        target,
        title: entry.title,
        turns,
        created: entry.created,
        model: entry.model,
        source: entry.kind,
        sourceID: entry.nativeID,
        device: entry.device,
        branch: entry.branch,
      })
      entry.imported = {
        sessionID: result.sessionID,
        projectID: result.projectID,
        projectSource: target.source,
        fingerprint: entry.fingerprint,
        turns: turns.length,
        importedAt: Date.now(),
        device: entry.device,
      }
      delete entry.conflict
      log("info", `imported ${entry.key} as ${result.sessionID}`, { turns: turns.length, project: target.projectID })
      return {
        key: entry.key,
        status: branched ? ("branched" as const) : ("imported" as const),
        sessionID: result.sessionID,
        projectID: result.projectID,
        projectSource: target.source,
        turns: turns.length,
      }
    } finally {
      db.close()
    }
  }

  return {
    tool: {
      session_scan: tool({
        description:
          "Rescan the Claude Code, Codex and dsh session stores on this device and refresh the session index. " +
          "Reports what was added, what grew since it was last imported, what was rewritten, and what disappeared. " +
          "This never writes to opencode's database — run session_import or session_sync_all to do that.",
        args: {},
        async execute() {
          const device = await localDevice()
          const index = await Index.load()
          const scanned = await scanAll()
          const diff = Index.reconcile(index, scanned, device.id)
          await Index.save(index)

          const counts = Index.stats(index)
          log("info", "scan complete", { total: counts.total, added: diff.added.length })

          return {
            title: `Indexed ${counts.total} sessions`,
            output: JSON.stringify(
              {
                device: { id: device.id, hostname: device.hostname },
                scanned: scanned.length,
                added: diff.added.length,
                grown: diff.grown.length,
                rewritten: diff.rewritten.length,
                unchanged: diff.unchanged.length,
                missing: diff.missing.length,
                ...counts,
                pending: [...diff.added, ...diff.grown, ...diff.rewritten].slice(0, 25),
              },
              null,
              2,
            ),
          }
        },
      }),

      session_list: tool({
        description:
          "List indexed sessions, newest first. Filter by source (claude, codex, dsh), by whether they have been " +
          "imported into opencode, or by a substring match on the title or directory.",
        args: {
          source: tool.schema.enum(["claude", "codex", "dsh"]).optional().describe("Restrict to one source store."),
          imported: tool.schema.boolean().optional().describe("true for imported only, false for not-yet-imported."),
          search: tool.schema.string().optional().describe("Case-insensitive substring of the title or directory."),
          limit: tool.schema.number().int().min(1).max(200).optional().describe("Max rows (default 30)."),
        },
        async execute(args) {
          const index = await Index.load()
          const needle = args.search?.toLowerCase() ?? ""

          const rows = Object.values(index.entries)
            .filter((entry) => (args.source ? entry.kind === args.source : true))
            .filter((entry) => (args.imported === undefined ? true : Boolean(entry.imported) === args.imported))
            .filter((entry) =>
              needle ? `${entry.title} ${entry.directory}`.toLowerCase().includes(needle) : true,
            )
            .sort((a, b) => b.modified - a.modified)

          const limit = args.limit ?? 30
          return {
            title: `${rows.length} matching sessions`,
            output: JSON.stringify(
              { matched: rows.length, showing: Math.min(limit, rows.length), sessions: rows.slice(0, limit).map(summarize) },
              null,
              2,
            ),
          }
        },
      }),

      session_read: tool({
        description:
          "Read the transcript of one indexed session by its key (as reported by session_list, e.g. 'codex:0199...'). " +
          "Returns normalised user/assistant turns without importing anything.",
        args: {
          key: tool.schema.string().describe("Session key from session_list."),
          limit: tool.schema.number().int().min(1).max(500).optional().describe("Max turns to return (default 40)."),
          offset: tool.schema.number().int().min(0).optional().describe("Turn offset to start from."),
        },
        async execute(args) {
          const index = await Index.load()
          const entry = index.entries[args.key]
          if (!entry) throw new Error(`Unknown session key: ${args.key}`)

          const turns = await readTurns(entry, LARGE_FILE_BYTES)
          const offset = args.offset ?? 0
          const limit = args.limit ?? 40

          return {
            title: entry.title,
            output: JSON.stringify(
              {
                ...summarize(entry),
                totalTurns: turns.length,
                turns: turns.slice(offset, offset + limit).map((turn) => ({
                  role: turn.role,
                  text: turn.text.length > 4000 ? turn.text.slice(0, 4000) + "\n…[truncated]" : turn.text,
                })),
              },
              null,
              2,
            ),
          }
        },
      }),

      session_import: tool({
        description:
          "Import one indexed session into opencode's database so it appears in the session picker. " +
          "A source that only grew since its last import merges its new turns into the existing session; " +
          "a source that was rewritten branches into a new session instead of overwriting.",
        args: {
          key: tool.schema.string().describe("Session key from session_list."),
          force: tool.schema.boolean().optional().describe("Re-import even if unchanged, creating a new session."),
        },
        async execute(args) {
          const index = await Index.load()
          const entry = index.entries[args.key]
          if (!entry) throw new Error(`Unknown session key: ${args.key}`)
          if (entry.missing) throw new Error(`Source file for ${args.key} no longer exists`)

          const result = await importOne(entry, await resolverFor(index), args.force === true)
          await Index.save(index)

          return { title: `${result.status}: ${entry.title}`, output: JSON.stringify(result, null, 2) }
        },
      }),

      session_sync_all: tool({
        description:
          "Scan every source store and import all pending sessions into opencode in one pass. " +
          "Use dryRun first to see the plan. Progress is written to the opencode log as it goes. " +
          "Filter by source or by a minimum turn count to keep the first run manageable.",
        args: {
          dryRun: tool.schema.boolean().optional().describe("Report the plan without writing (default false)."),
          source: tool.schema.enum(["claude", "codex", "dsh"]).optional().describe("Restrict to one source store."),
          minTurns: tool.schema.number().int().min(0).optional().describe("Skip sessions with fewer turns (default 2)."),
          limit: tool.schema.number().int().min(1).optional().describe("Max sessions to import this pass."),
        },
        async execute(args, context) {
          const device = await localDevice()
          const index = await Index.load()
          const scanned = await scanAll()
          Index.reconcile(index, scanned, device.id)

          const minTurns = args.minTurns ?? 2
          const pending = Object.values(index.entries)
            .filter((entry) => !entry.missing)
            .filter((entry) => (args.source ? entry.kind === args.source : true))
            .filter((entry) => !entry.imported || entry.conflict)
            .sort((a, b) => b.modified - a.modified)

          const planned = args.limit ? pending.slice(0, args.limit) : pending

          if (args.dryRun) {
            await Index.save(index)
            return {
              title: `${planned.length} sessions pending`,
              output: JSON.stringify(
                {
                  dryRun: true,
                  pending: planned.length,
                  byKind: planned.reduce<Record<string, number>>((acc, entry) => {
                    acc[entry.kind] = (acc[entry.kind] ?? 0) + 1
                    return acc
                  }, {}),
                  sessions: planned.slice(0, 40).map(summarize),
                },
                null,
                2,
              ),
            }
          }

          const tally = { imported: 0, merged: 0, branched: 0, skipped: 0, empty: 0, failed: 0 }
          const failures: Array<{ key: string; error: string }> = []
          const resolver = await resolverFor(index)

          for (const [position, entry] of planned.entries()) {
            if (context.abort.aborted) break

            context.metadata({
              title: `Importing ${position + 1}/${planned.length}: ${entry.title.slice(0, 60)}`,
              metadata: { progress: position + 1, total: planned.length, ...tally },
            })

            try {
              const result = await importOne(entry, resolver, false)
              if (result.status === "empty") tally.empty++
              else if (result.status === "merged") tally.merged++
              else if (result.status === "branched") tally.branched++
              else if (result.status === "imported") tally.imported++
              else tally.skipped++
            } catch (error) {
              tally.failed++
              const message = error instanceof Error ? error.message : String(error)
              failures.push({ key: entry.key, error: message })
              log("warn", `import failed for ${entry.key}: ${message}`)
            }

            // Persist incrementally so an interrupted run does not redo work.
            if (position % 20 === 19) await Index.save(index)
          }

          await Index.save(index)
          const counts = Index.stats(index)
          log("info", "sync complete", { ...tally })

          return {
            title: `Synced ${tally.imported + tally.merged + tally.branched} sessions`,
            output: JSON.stringify({ planned: planned.length, ...tally, failures: failures.slice(0, 20), index: counts }, null, 2),
          }
        },
      }),

      session_projects: tool({
        description:
          "Group the indexed sessions into projects the way an import would, showing how sessions from different " +
          "devices and different directories merge. Projects are keyed by git remote when one is known, then by " +
          "root commit, then by directory name.",
        args: {
          resolve: tool.schema
            .boolean()
            .optional()
            .describe("Consult git for directories present on this device (slower, more accurate). Default true."),
        },
        async execute(args) {
          const index = await Index.load()
          const entries = Object.values(index.entries)

          type Group = {
            projectID: string
            source: string
            remote: string | null
            name: string
            sessions: number
            imported: number
            devices: Set<string>
            directories: Set<string>
          }
          const groups = new Map<string, Group>()

          // Learn every recorded remote first so sessions that ran in the same
          // directory without one still resolve to the same project.
          const resolver = Identity.createResolver({ consultGit: args.resolve !== false })
          await resolver.learn(entries)

          for (const entry of entries) {
            const identity = await resolver.identify(entry.directory)

            const group = groups.get(identity.projectID) ?? {
              projectID: identity.projectID,
              source: identity.source,
              remote: identity.remote,
              name: identity.name,
              sessions: 0,
              imported: 0,
              devices: new Set<string>(),
              directories: new Set<string>(),
            }
            group.sessions++
            if (entry.imported) group.imported++
            if (entry.device) group.devices.add(entry.device)
            if (entry.directory) group.directories.add(entry.directory)
            groups.set(identity.projectID, group)
          }

          const rows = [...groups.values()]
            .sort((a, b) => b.sessions - a.sessions)
            .map((group) => ({
              projectID: group.projectID,
              name: group.name,
              mergedBy: group.source,
              remote: group.remote,
              sessions: group.sessions,
              imported: group.imported,
              devices: [...group.devices],
              directories: [...group.directories],
            }))

          return {
            title: `${rows.length} projects across ${entries.length} sessions`,
            output: JSON.stringify(
              {
                projects: rows.length,
                sessions: entries.length,
                mergedBy: rows.reduce<Record<string, number>>((acc, row) => {
                  acc[row.mergedBy] = (acc[row.mergedBy] ?? 0) + 1
                  return acc
                }, {}),
                multiDirectory: rows.filter((row) => row.directories.length > 1).length,
                multiDevice: rows.filter((row) => row.devices.length > 1).length,
                items: rows,
              },
              null,
              2,
            ),
          }
        },
      }),

      session_register_projects: tool({
        description:
          "Make imported projects visible in the opencode desktop app. The desktop keeps its own project list in " +
          "opencode.global.dat rather than reading the database, so a project only appears once its worktree is " +
          "registered there. Adds every project that owns imported sessions; existing entries are left untouched. " +
          "Restart the desktop app afterwards to see them.",
        args: {
          dryRun: tool.schema.boolean().optional().describe("Report what would be added without writing."),
          onlyExisting: tool.schema
            .boolean()
            .optional()
            .describe("Skip worktrees that no longer exist on this device (default true)."),
          minSessions: tool.schema.number().int().min(1).optional().describe("Only register projects with at least this many sessions (default 1)."),
        },
        async execute(args) {
          const db = DB.open(true)
          let rows: Array<{ worktree: string; name: string | null; n: number }>
          try {
            rows = db
              .prepare(
                `SELECT p.worktree AS worktree, p.name AS name, COUNT(s.id) AS n
                 FROM "project" p JOIN "session" s ON s.project_id = p.id
                 WHERE p.id != 'global'
                 GROUP BY p.id ORDER BY n DESC`,
              )
              .all() as typeof rows
          } finally {
            db.close()
          }

          const minSessions = args.minSessions ?? 1
          const candidates = rows.filter((row) => row.n >= minSessions)

          // A worktree that no longer exists would show as a dead entry, so it
          // is skipped unless the caller asks for everything.
          const checkExists = args.onlyExisting !== false
          const live: typeof candidates = []
          const gone: typeof candidates = []
          for (const row of candidates) {
            if (!checkExists) {
              live.push(row)
              continue
            }
            try {
              await (await import("node:fs/promises")).access(row.worktree)
              live.push(row)
            } catch {
              gone.push(row)
            }
          }

          const already = new Set(
            (await Desktop.listProjects()).map((entry) => entry.worktree.replace(/\//g, "\\").toLowerCase()),
          )
          const pending = live.filter((row) => !already.has(Desktop.toNative(row.worktree).toLowerCase()))

          if (args.dryRun) {
            return {
              title: `${pending.length} projects would be registered`,
              output: JSON.stringify(
                {
                  dryRun: true,
                  statePath: Desktop.globalStatePath(),
                  alreadyRegistered: already.size,
                  wouldAdd: pending.map((row) => ({ worktree: row.worktree, name: row.name, sessions: row.n })),
                  skippedMissingWorktree: gone.map((row) => row.worktree),
                },
                null,
                2,
              ),
            }
          }

          const result = await Desktop.registerProjects(live.map((row) => row.worktree))
          log("info", `registered ${result.added.length} desktop projects`, { total: result.total })

          return {
            title: `Registered ${result.added.length} projects (${result.total} total)`,
            output: JSON.stringify(
              {
                ...result,
                skippedMissingWorktree: gone.map((row) => row.worktree),
                note: "Restart the opencode desktop app for these to appear.",
              },
              null,
              2,
            ),
          }
        },
      }),

      session_status: tool({
        description:
          "Report the session index: where each source store lives, how many sessions each holds, how many have " +
          "been imported into opencode, and which entries have unresolved conflicts.",
        args: {},
        async execute() {
          const device = await localDevice()
          const index = await Index.load()
          const counts = Index.stats(index)
          const conflicts = Object.values(index.entries).filter((entry) => entry.conflict)

          const db = DB.open(true)
          let dbSessions = 0
          let dbProjects = 0
          try {
            dbSessions = (db.prepare(`SELECT COUNT(*) c FROM "session"`).get() as { c: number }).c
            dbProjects = (db.prepare(`SELECT COUNT(*) c FROM "project"`).get() as { c: number }).c
          } finally {
            db.close()
          }

          return {
            title: `${counts.imported}/${counts.total} imported`,
            output: JSON.stringify(
              {
                device: { id: device.id, hostname: device.hostname, platform: device.platform },
                knownDevices: index.devices ?? {},
                indexUpdatedAt: index.updatedAt ? new Date(index.updatedAt).toISOString() : null,
                ...counts,
                opencode: { sessions: dbSessions, projects: dbProjects },
                conflicts: conflicts.slice(0, 20).map(summarize),
              },
              null,
              2,
            ),
          }
        },
      }),
    },
  }
}
