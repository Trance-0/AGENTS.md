import { Index, DB, Identity, Desktop, Registry, PCP, Logs, Archive, Progress, Transfer, DirectorySync, LARGE_FILE_BYTES, readTurns, scanAll, localDevice, DATA_DIR, path, fsp, tool, PLUGIN_ID, SWEEP_KEY, MAX_TURNS, RESCAN_INTERVAL_MS, summarize, SOURCE_LABEL, REVIEW_STATE, REVIEW_LIMIT, PROJECT_STATUS, projectStatus, EXPORT_DIR, reviewState, normalize, splitInput } from "./session-manager-common.ts"
import type { Plugin, Logger, IndexEntry } from "./session-manager-common.ts"
import type { createSessionOperations } from "./session-manager-operations.ts"

export function createSessionHooks(operations: ReturnType<typeof createSessionOperations>, log: Logger): Awaited<ReturnType<Plugin>> {
  const { projectBacklog, resolverFor, importOne, pushOne, pendingImports, pendingPushes, importBatch, pushBatch, archiveBatch, legacyArchiveBatch, importArchive, legacyImportArchive, sweep } = operations
  return {
    /**
     * A finished session is the moment its transcript stops changing, which is
     * exactly when re-indexing is worth doing — and when opencode is idle
     * enough to afford it.
     */
    event: async ({ event }) => {
      if (!Registry.isEnabled(PLUGIN_ID)) return
      if (event.type !== "session.idle") return
      await sweep("idle")
    },
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
                // What this scan changed, kept separate from the index totals:
                // spreading `counts` over these silently replaced `missing`
                // with the index-wide figure, so the scan reported a number it
                // had not just measured.
                changed: {
                  added: diff.added.length,
                  grown: diff.grown.length,
                  rewritten: diff.rewritten.length,
                  unchanged: diff.unchanged.length,
                  missing: diff.missing.length,
                },
                ...counts,
                pending: [...diff.added, ...diff.grown, ...diff.rewritten].slice(0, 25),
              },
              null,
              2,
            ),
          }
        },
      }),

      session_search: tool({
        description:
          "Search the full text of every opencode session — both natively created ones and imported Claude Code, " +
          "Codex and dsh transcripts — for sessions whose conversation contains all the given terms. " +
          'Quote a phrase ("rate limit") to match it as a unit. Unlike session_list, which only matches titles ' +
          "and directories, this reads the message bodies. Results are ranked by how often a session matched.",
        args: {
          query: tool.schema.string().describe('Terms to find, all of which must appear. Use "quotes" for a phrase.'),
          project: tool.schema.string().optional().describe("Restrict to one project id (see session_projects)."),
          source: tool.schema
            .enum(["opencode", "claude", "codex", "dsh"])
            .optional()
            .describe("Restrict to one source; 'opencode' means natively created sessions."),
          limit: tool.schema.number().int().min(1).max(200).optional().describe("Max sessions (default 40)."),
        },
        async execute(args) {
          const terms = DB.parseQuery(args.query)
          if (terms.length === 0) throw new Error("Enter at least one term to search for")

          const db = DB.open(true)
          let hits: DB.SearchHit[]
          try {
            hits = DB.search(db, args.query, {
              projectID: args.project,
              source: args.source,
              limit: args.limit,
            })
          } finally {
            db.close()
          }

          return {
            title: hits.length ? `${hits.length} sessions match ${terms.map((t) => `"${t}"`).join(" + ")}` : "No matches",
            output: JSON.stringify(
              {
                terms,
                matched: hits.length,
                sessions: hits.map((hit) => ({
                  sessionID: hit.sessionID,
                  title: hit.title,
                  project: hit.projectName,
                  projectID: hit.projectID,
                  source: hit.source,
                  matches: hit.matches,
                  updated: new Date(hit.updated).toISOString().slice(0, 16).replace("T", " "),
                  directory: hit.directory || null,
                  snippet: hit.snippet,
                })),
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
            // Both titles are searched: a Codex session is known to its user
            // by the name Codex shows, which is not the one derived from the
            // transcript.
            .filter((entry) =>
              needle
                ? `${entry.title} ${entry.sourceTitle ?? ""} ${entry.directory}`.toLowerCase().includes(needle)
                : true,
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

      pcp_status: tool({
        description: "Check PCP connectivity using the configured scoped token.",
        args: {},
        async execute() {
          const config = await PCP.resolveConfig()
          const result = await PCP.probe(config)
          return { title: "PCP connected", output: JSON.stringify({ baseURL: config.baseURL, tree: result }, null, 2) }
        },
      }),

      pcp_push: tool({
        description: "Push one indexed external session to PCP. Retries are idempotent by device/kind/native session key.",
        args: {
          key: tool.schema.string().describe("Session key from session_list."),
          force: tool.schema.boolean().optional().describe("Replay every turn into a fresh remote cursor."),
        },
        async execute(args) {
          const config = await PCP.resolveConfig()
          const index = await Index.load()
          const entry = index.entries[args.key]
          if (!entry) throw new Error(`Unknown session key: ${args.key}`)

          const result = await pushOne(entry, config, args.force === true)
          await Index.save(index)

          return { title: `${result.status}: ${entry.title}`, output: JSON.stringify(result, null, 2) }
        },
      }),

      session_export: tool({
        description:
          "Write indexed transcripts to a local .tar.gz archive: one JSON file per session holding its " +
          "descriptor and normalised turns, plus a manifest. Needs no server or database to read back, so " +
          "this is the destination to use for a backup or to move sessions onto a machine with nothing set up.",
        args: {
          file: tool.schema.string().optional().describe("Archive path. Omit for a timestamped file in the configured folder."),
          source: tool.schema.enum(["claude", "codex", "dsh"]).optional().describe("Restrict to one source store."),
          pendingOnly: tool.schema
            .boolean()
            .optional()
            .describe("Export only transcripts not yet imported at their current length (default false)."),
          limit: tool.schema.number().int().min(1).optional().describe("Max sessions to write."),
        },
        async execute(args, context) {
          const config = await PCP.resolveConfig()
          const device = await localDevice()
          const index = await Index.load()
          Index.reconcile(index, await scanAll(), device.id)
          await Index.save(index)

          const candidates = (args.pendingOnly ? pendingImports(index, args.source) : Object.values(index.entries))
            .filter((entry) => !entry.missing)
            .filter((entry) => (args.source ? entry.kind === args.source : true))
            .sort((a, b) => b.modified - a.modified)
          const planned = args.limit ? candidates.slice(0, args.limit) : candidates

          const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")
          const file = args.file || path.join(config.exportDir || EXPORT_DIR, `sessions-${device.id}-${stamp}.tar.gz`)

          const result = await archiveBatch(
            file,
            planned,
            (done, total) =>
              context.metadata({
                title: `Archiving history ${done}/${total}`,
                metadata: { progress: done, total },
              }),
            () => context.abort.aborted,
          )

          return {
            title: `Wrote ${result.sessions} sessions to ${path.basename(result.file)}`,
            output: JSON.stringify(result, null, 2),
          }
        },
      }),

      pcp_sync: tool({
        description: "Push every indexed session whose transcript has not yet reached PCP, resuming from each session's remote cursor.",
        args: {
          dryRun: tool.schema.boolean().optional().describe("Report the plan without uploading."),
          limit: tool.schema.number().int().min(1).optional().describe("Max sessions to push this pass."),
        },
        async execute(args, context) {
          const config = await PCP.resolveConfig()
          const device = await localDevice()
          const index = await Index.load()
          Index.reconcile(index, await scanAll(), device.id)

          const pending = pendingPushes(index)
          const planned = args.limit ? pending.slice(0, args.limit) : pending

          if (args.dryRun) {
            await Index.save(index)
            return {
              title: `${planned.length} sessions pending for PCP`,
              output: JSON.stringify({ dryRun: true, pending: planned.length, sessions: planned.slice(0, 40).map(summarize) }, null, 2),
            }
          }

          const { tally, results } = await pushBatch(
            index,
            config,
            planned,
            (done, total, counts) =>
              context.metadata({
                title: `Pushing ${done}/${total}: ${planned[done - 1]!.title.slice(0, 60)}`,
                metadata: { progress: done, total, ...counts },
              }),
            () => context.abort.aborted,
          )

          return {
            title: `Pushed ${tally.pushed} sessions to PCP`,
            output: JSON.stringify({ planned: planned.length, ...tally, results: results.slice(0, 40) }, null, 2),
          }
        },
      }),

      session_sync_all: tool({
        description:
          "Scan every source store and import all pending sessions into opencode in one pass. " +
          "Use dryRun first to see the plan. Progress is written to the opencode log as it goes. " +
          "Filter by source or cap the count to keep the first run manageable.",
        args: {
          dryRun: tool.schema.boolean().optional().describe("Report the plan without writing (default false)."),
          source: tool.schema.enum(["claude", "codex", "dsh"]).optional().describe("Restrict to one source store."),
          limit: tool.schema.number().int().min(1).optional().describe("Max sessions to import this pass."),
        },
        async execute(args, context) {
          const device = await localDevice()
          const index = await Index.load()
          const scanned = await scanAll()
          Index.reconcile(index, scanned, device.id)

          const pending = pendingImports(index, args.source)
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

          const { tally, failures } = await importBatch(
            index,
            planned,
            (done, total, counts) =>
              context.metadata({
                title: `Importing ${done}/${total}: ${planned[done - 1]!.title.slice(0, 60)}`,
                metadata: { progress: done, total, ...counts },
              }),
            () => context.abort.aborted,
          )
          const counts = Index.stats(index)

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
