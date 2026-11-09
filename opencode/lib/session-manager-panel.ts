import { Index, DB, Identity, Desktop, Registry, PCP, Logs, Archive, Progress, Transfer, DirectorySync, LARGE_FILE_BYTES, readTurns, scanAll, localDevice, DATA_DIR, path, fsp, tool, PLUGIN_ID, SWEEP_KEY, MAX_TURNS, RESCAN_INTERVAL_MS, summarize, SOURCE_LABEL, REVIEW_STATE, REVIEW_LIMIT, PROJECT_STATUS, projectStatus, EXPORT_DIR, reviewState, normalize, splitInput } from "./session-manager-common.ts"
import type { Plugin, Logger, IndexEntry } from "./session-manager-common.ts"
import type { createSessionOperations } from "./session-manager-operations.ts"

export function registerSessionPanel(operations: ReturnType<typeof createSessionOperations>, log: Logger, client: Parameters<Plugin>[0]["client"]) {
  const { projectBacklog, resolverFor, importOne, pushOne, pendingImports, pendingPushes, importBatch, pushBatch, archiveBatch, legacyArchiveBatch, importArchive, legacyImportArchive, sweep } = operations
  Registry.register({
    id: "session-manager",
    title: "Session Manager",
    description: "Index Claude Code, Codex and dsh transcripts and import them into opencode.",
    async settings() {
      const syncConfig = await DirectorySync.config()
      const config = await PCP.resolveConfig()
      const index = await Index.load()
      const counts = Index.stats(index)

      // Transcripts that decoded to nothing are subtracted: they are neither
      // imported nor importable, so counting them as owed leaves a figure that
      // never reaches zero no matter how often the button is pressed.
      const pending = counts.total - counts.imported - counts.empty
      const unpushed = Object.values(index.entries).filter(
        (entry) => !entry.missing && (!entry.pcp || entry.pcp.fingerprint !== entry.fingerprint),
      ).length

      return [
        { group: "Directory sync", expanded: true, key: "sync.directory", label: "Sync folder", type: "string", value: syncConfig.directory },
        { group: "Directory sync", key: "sync.mode", label: "Sync mode", type: "select", value: syncConfig.mode,
          options: [{ value: "manual", label: "Manual — no active merge" }, { value: "local", label: "Local only — merge local AI agent stores" }, { value: "directory", label: "Directory — merge configured folder only" }, { value: "auto", label: "Auto — local agents and optional directory" }],
          description: "Directory layout: projects/<name-id>/imported/<session-id>/<device-revision>.json; retained conflicts, raw provider records and operation history are content-addressed under history/. One-time .tar.gz export is separate. The remote folder defaults to blank." },
        { group: "Directory sync", key: "sync-directory", label: "Sync / read folder now", type: "action", action: "sync-directory" },
        // Indexing is maintenance, so it lives with the settings rather than
        // on the Info tab, which is for reading.
        {
          key: "scan",
          label: "Rescan stores",
          type: "action",
          action: "scan",
          description:
            `Re-reads the Claude Code, Codex and dsh stores. Runs on its own after a session finishes and ` +
            `every ${RESCAN_INTERVAL_MS / 60000} minutes; this forces one now. ` +
            `Currently ${counts.total} transcripts, ${counts.imported} imported.`,
        },
        // Importing and pushing are the plugin's two bulk operations, and both
        // were previously reachable only by asking a model to call the tool.
        // They are the reason the settings page exists, so they belong here.
        {
          group: "Import from Claude Code, Codex and dsh",
          expanded: true,
          key: "import-all",
          label: pending > 0 ? `Import ${pending} pending sessions` : "Import pending sessions",
          type: "action",
          action: "import-all",
          description:
            pending > 0
              ? `${pending} indexed transcripts are not in opencode yet. Importing scans first, then writes ` +
                `every one of them into opencode's database; sessions with fewer than two turns are skipped.`
              : "Every indexed transcript is already in opencode. Rescan first if a new one should have appeared.",
        },
        // The offline destination. Unlike PCP this needs no server, which is
        // what makes it the one usable as a backup or to carry work onto a
        // machine that has nothing set up yet.
        {
          group: "Export to a local archive",
          expanded: true,
          key: "exportDir",
          label: "Archive folder",
          type: "string",
          value: config.exportDir,
          placeholder: EXPORT_DIR,
          description: `Where the .tar.gz is written. Empty uses ${EXPORT_DIR}.`,
        },
        {
          group: "Export to a local archive",
          key: "archive-all",
          label: "Export complete session history to .tar.gz",
          type: "action",
          action: "archive-all",
          description:
            "Exports native and imported OpenCode sessions, messages, tool records, events, source payloads and retained revisions. Unavailable source pointers remain recorded.",
        },
        {
          group: "Export to a local archive",
          key: "import-archive",
          label: "Import from .tar.gz…",
          type: "action",
          action: "import-archive",
          prompt: "Path to the archive. Leave empty for the newest one in the folder above.",
          description:
            "Imports a full-history version 2 archive. Stable record IDs merge duplicates; newer revisions update records while both histories are retained. Older text-only archives require a fresh export.",
        },
        {
          group: "Export to PCP",
          expanded: true,
          key: "baseURL",
          label: "PCP base URL",
          type: "string",
          value: config.baseURL,
          placeholder: "https://…",
        },
        {
          group: "Export to PCP",
          key: "scopedToken",
          label: "PCP scoped token",
          type: "string",
          value: config.scopedToken,
          secret: true,
          placeholder: "pcp_…",
        },
        {
          group: "Export to PCP",
          key: "export-all",
          label: unpushed > 0 ? `Push ${unpushed} sessions to PCP` : "Push sessions to PCP",
          type: "action",
          action: "export-all",
          description:
            unpushed > 0
              ? `${unpushed} transcripts have not reached PCP, or grew since they last did. Each resumes from ` +
                `its own remote cursor, so only the new turns are uploaded.`
              : "Every indexed transcript has reached PCP at its current length.",
        },
      ]
    },
    async update(key, value) {
      const text = String(value).trim()
      if (key === "sync.directory") { await DirectorySync.configure({ directory: text }); return }
      if (key === "sync.mode") { await DirectorySync.configure({ mode: text as DirectorySync.Config["mode"] }); return }
      // The archive folder may be cleared, which restores the default; the two
      // PCP fields cannot, because an empty one is not a usable endpoint.
      if (key === "exportDir") {
        await PCP.saveConfig({ exportDir: text })
        return
      }
      if (key !== "baseURL" && key !== "scopedToken") throw new Error(`unknown setting: ${key}`)
      if (!text) throw new Error(`${key} cannot be empty`)
      await PCP.saveConfig({ [key]: text })
    },
    async status() {
      const index = await Index.load()
      const counts = Index.stats(index)
      const device = await localDevice()

      // The index only describes external transcripts, so its totals are not
      // opencode's session count: opencode also holds natively created
      // sessions this plugin never imported. Reporting both, separately
      // labelled, is what stops the two numbers from looking like a mismatch.
      let live = { sessions: 0, projects: 0, bySource: {} as Record<string, number> }
      try {
        const db = DB.open(true)
        try {
          live = DB.counts(db)
        } finally {
          db.close()
        }
      } catch {
        // The database is unreadable (opencode mid-write, or not yet created).
      }
      const native = live.bySource.opencode ?? 0

      return [
        { label: "sources", value: counts.total, tone: "muted" },
        { label: "imported", value: counts.imported, tone: counts.imported > 0 ? "ok" : "muted" },
        { label: "pending", value: counts.total - counts.imported - counts.empty, tone: counts.total - counts.imported - counts.empty > 0 ? "warn" : "muted" },
        { label: "conflicts", value: counts.conflicts, tone: counts.conflicts > 0 ? "error" : "muted" },
        { label: "opencode sessions", value: live.sessions, tone: "ok" },
        { label: "native", value: native, tone: "muted" },
        { label: "projects", value: live.projects, tone: "muted" },
        { label: "device", value: device.id, tone: "muted" },
      ]
    },
    /**
     * The Info tab: search, the pending queue, and the projects tree.
     *
     * The pending table is deliberately not a second copy of the tree. The tree
     * answers "where is this session"; the table answers "what still has to be
     * reviewed", which is a homogeneous list of the same four facts per row —
     * exactly the shape cards are worst at and a table is for.
     */
    async panels() {
      // Every project opencode knows about, with its sessions loaded on
      // expand. This reads opencode's own tables, so natively created sessions
      // appear next to imported ones instead of being invisible here.
      let projects: DB.ProjectRow[] = []
      try {
        const db = DB.open(true)
        try {
          projects = DB.listProjects(db)
        } finally {
          db.close()
        }
      } catch {
        // Unreadable database: fall back to the flat list below.
      }

      const backlog = await projectBacklog(projects)

      const mergeTargets = projects.map((project) => ({
        value: project.id,
        label: `${project.name} (${project.sessions})`,
      }))

      // What still has to be reviewed: never imported, or changed since it was.
      // Transcripts already found to hold nothing are listed too — they are the
      // explanation for a pending count that stopped falling — but as their own
      // "empty" state, so they never read as work owed.
      const index = await Index.load().catch(() => null)
      const review = index
        ? Object.values(index.entries)
            .filter((entry) => !entry.missing)
            .filter((entry) => entry.conflict || !entry.imported)
            .sort((a, b) => b.modified - a.modified)
        : []

      return [
        {
          key: "review",
          type: "table" as const,
          noun: "session",
          title: "Pending review",
          description:
            review.length
              ? `${review.length} transcripts are not in opencode at their current length. ` +
                "Import one to bring it in, or read it first to see what it holds."
              : "Every indexed transcript is in opencode at its current length.",
          columns: [
            { label: "state" },
            { label: "source" },
            { label: "size", align: "right" as const },
            { label: "modified" },
            { label: "device" },
          ],
          // The same vocabulary the projects tree uses, so "pending" means one
          // thing across the page.
          filters: [...REVIEW_STATE],
          empty: "Nothing pending — every transcript is imported and unchanged since.",
          action: "import-all",
          items: review.slice(0, REVIEW_LIMIT).map((entry) => {
            const state = reviewState(entry)
            const tone =
              state === "rewritten" ? ("error" as const) : state === "empty" ? ("muted" as const) : ("warn" as const)
            return {
              title: entry.sourceTitle || entry.title || "(untitled)",
              subtitle: entry.directory || undefined,
              group: state,
              tone,
              fields: [
                { label: "state", value: state, tone },
                { label: "source", value: SOURCE_LABEL[entry.kind] ?? entry.kind },
                { label: "size", value: entry.size < 1024 ? `${entry.size} B` : `${Math.round(entry.size / 1024)} KB` },
                { label: "modified", value: new Date(entry.modified).toISOString().slice(0, 16).replace("T", " ") },
                { label: "device", value: entry.device || "—" },
              ],
              // An empty source has nothing to import, so it gets no button
              // that could only report having done nothing.
              controls:
                state === "empty"
                  ? []
                  : [{ type: "button" as const, action: "import-one", label: "Import", input: entry.key }],
            }
          }),
        },
        {
          key: "projects",
          type: "tree" as const,
          title: "Projects",
          description:
            `${projects.length} projects across ${projects.reduce((n, p) => n + p.sessions, 0)} opencode sessions. ` +
            "Expand a project to load its sessions; each card is labelled with the source it came from. " +
            "Use the ⋯ menu to rename a project, add a directory, or merge it into another.",
          items: [],
          // Which projects still owe work, without expanding each one. The
          // counts come from the index, so a project whose Codex transcript
          // grew is visible as such before anything is imported.
          filters: [...PROJECT_STATUS],
          groups: projects.map((project) => {
            const state = backlog.get(project.id) ?? { pending: 0, conflicts: 0, imported: 0 }
            return {
            id: project.id,
            title: project.name,
            group: projectStatus(state),
            subtitle: project.directories.length > 1
              ? `${project.worktree}  (+${project.directories.length - 1} more)`
              : project.worktree,
            count: project.sessions,
            tone: state.conflicts > 0 ? ("error" as const) : state.pending > 0 ? ("warn" as const) : undefined,
            fields: [
              ...Object.entries(project.bySource)
                .sort((a, b) => b[1] - a[1])
                .map(([source, n]) => ({ label: source, value: String(n) })),
              ...(state.pending > 0
                ? [{ label: "pending", value: String(state.pending), tone: "warn" as const }]
                : []),
              ...(state.conflicts > 0
                ? [{ label: "conflicts", value: String(state.conflicts), tone: "error" as const }]
                : []),
              ...(project.lastActivity
                ? [{ label: "active", value: new Date(project.lastActivity).toISOString().slice(0, 10) }]
                : []),
            ],
            menu: [
              {
                type: "button" as const,
                action: "open-project",
                label: "Open in opencode",
                input: project.id,
              },
              {
                type: "prompt" as const,
                action: "rename-project",
                label: "Rename project…",
                input: project.id,
                prompt: `New name for "${project.name}"`,
                value: project.name,
              },
              {
                type: "prompt" as const,
                action: "add-directory",
                label: "Add folder or remote URL…",
                input: project.id,
                prompt: "Local folder path or remote URL to associate with this project",
                value: "",
              },
              {
                type: "select" as const,
                action: "merge-project",
                label: "Merge into…",
                input: project.id,
                options: mergeTargets.filter((target) => target.value !== project.id),
              },
            ],
            }
          }),
          empty: "No projects yet — import some sessions first.",
          /**
           * One project's sessions, fetched when the group is expanded.
           *
           * Clicking a card opens the transcript in this dashboard. The
           * opencode desktop app cannot be asked to focus a specific session —
           * its deep-link handler accepts only `open-project` and
           * `new-session` — so there is nothing to redirect to yet.
           */
          async children(projectID: string) {
            const db = DB.open(true)
            try {
              return DB.listSessions(db, projectID).map((session) => ({
                title: session.title || "(untitled)",
                subtitle: session.directory || undefined,
                tone: session.source === "opencode" ? ("ok" as const) : ("muted" as const),
                fields: [
                  { label: "source", value: SOURCE_LABEL[session.source] ?? session.source },
                  // Shown only once it has diverged: opencode's title starts
                  // as the source's, and repeating it would be noise. After
                  // session-rename rewrites one, this is how the session can
                  // still be recognised by the name its tool gave it.
                  ...(session.sourceTitle && session.sourceTitle !== session.title
                    ? [{ label: "source title", value: session.sourceTitle }]
                    : []),
                  { label: "turns", value: String(session.turns) },
                  { label: "updated", value: new Date(session.updated).toISOString().slice(0, 16).replace("T", " ") },
                  ...(session.device ? [{ label: "device", value: session.device }] : []),
                ],
                link: { view: "session", arg: session.id },
              }))
            } finally {
              db.close()
            }
          },
        },
      ]
    },
    /**
     * Full-text search over every opencode session.
     *
     * Reads the message bodies, so it finds sessions by what was discussed in
     * them rather than by title — which for an imported transcript is only the
     * first prompt and often says nothing about the work.
     */
    search: {
      placeholder: 'Search every session… (use "quotes" for a phrase)',
      async run(query: string) {
        const db = DB.open(true)
        let hits: DB.SearchHit[]
        try {
          hits = DB.search(db, query, { limit: 60, matchesPerSession: 5 })
        } finally {
          db.close()
        }

        return hits.map((hit) => ({
          title: hit.title,
          // The header carries the session's identity; the matched messages
          // below carry the evidence, so the snippet is not repeated here.
          subtitle: hit.directory || undefined,
          tone: hit.source === "opencode" ? ("ok" as const) : ("muted" as const),
          fields: [
            { label: "project", value: hit.projectName },
            { label: "source", value: SOURCE_LABEL[hit.source] ?? hit.source },
            { label: "matches", value: String(hit.matches), tone: "ok" as const },
            { label: "updated", value: new Date(hit.updated).toISOString().slice(0, 16).replace("T", " ") },
          ],
          link: { view: "session", arg: hit.sessionID },

          // The card body: each matching message, with the offsets to
          // highlight and the message id a fork would start from.
          sessionID: hit.sessionID,
          matchCount: hit.matches,
          hits: hit.hits,
          tokens: hit.tokens,
          cost: hit.cost,
          model: hit.model,
        }))
      },
    },
    actions: {
      "sync-directory": { label: "Sync / read folder now", hidden: true, run: () => DirectorySync.sync(() => Registry.get(PLUGIN_ID)!.actions!["import-all"]!.run()) },
      scan: {
        label: "Rescan stores",
        async run() {
          if (!Registry.isEnabled(PLUGIN_ID)) return "session-manager is disabled"
          const result = await sweep("manual")
          if (!result) return "a scan is already running"
          return `scanned ${result.scanned}; ${result.added.length} new, ${result.grown.length} grown`
        },
      },

      /**
       * The importer and the exporter, as buttons.
       *
       * Both were previously reachable only through `session_sync_all` and
       * `pcp_sync` — a model had to be asked to run the plugin's own bulk
       * operation, which is not something the Settings tab should require.
       */
      "import-all": {
        label: "Import pending sessions",
        async run() {
          if (!Registry.isEnabled(PLUGIN_ID)) return "session-manager is disabled"
          if (Progress.running(PLUGIN_ID, "import-all")) return "An import is already running."

          const handle = Progress.start(PLUGIN_ID, "import-all", "Scanning the session stores…")
          try {
            const device = await localDevice()
            const index = await Index.load()
            Index.reconcile(index, await scanAll(), device.id)

            const planned = pendingImports(index)
            if (planned.length === 0) {
              await Index.save(index)
              handle.finish("done", "Nothing to import — everything is already in opencode.")
              return "Nothing to import — every indexed transcript is already in opencode."
            }

            handle.step(0, planned.length, `Importing ${planned.length} sessions`)
            const { tally, failures } = await importBatch(index, planned, (done, total) =>
              handle.step(done, total, `Importing ${done}/${total}: ${planned[done - 1]!.title.slice(0, 60)}`),
            )
            for (const failure of failures) handle.log(`${failure.key}: ${failure.error}`, "error")

            const written = tally.imported + tally.merged + tally.branched
            const summary =
              `Imported ${tally.imported}, merged ${tally.merged}, branched ${tally.branched} of ${planned.length}` +
              (failures.length ? `; ${failures.length} failed.` : ".")
            handle.finish(failures.length ? "failed" : "done", summary)
            return summary + (written > 0 ? " Restart opencode to see them in the session picker." : "")
          } catch (error) {
            handle.finish("failed", error instanceof Error ? error.message : String(error))
            throw error
          }
        },
      },

      /**
       * Import one transcript, from its row in the pending table.
       *
       * The row-level counterpart of `import-all`: reviewing a queue usually
       * means acting on one entry, not on all of it.
       */
      "import-one": {
        label: "Import this session",
        hidden: true,
        async run(input) {
          const [key] = splitInput(input)
          if (!key) throw new Error("Pick a session to import")

          const index = await Index.load()
          const entry = index.entries[key]
          if (!entry) throw new Error(`Unknown session key: ${key}`)
          if (entry.missing) throw new Error(`Source file for ${key} no longer exists`)

          const result = await importOne(entry, await resolverFor(index), false)
          await Index.save(index)
          log("info", `${result.status}: ${key}`)
          return `${result.status}: ${entry.sourceTitle || entry.title}`
        },
      },

      "archive-all": {
        label: "Export sessions to .tar.gz",
        async run() {
          if (!Registry.isEnabled(PLUGIN_ID)) return "session-manager is disabled"
          if (Progress.running(PLUGIN_ID, "archive-all")) return "An export is already running."

          const handle = Progress.start(PLUGIN_ID, "archive-all", "Scanning the session stores…")
          try {
            const config = await PCP.resolveConfig()
            const device = await localDevice()
            const index = await Index.load()
            Index.reconcile(index, await scanAll(), device.id)
            await Index.save(index)

            // Everything present, not just what is pending: an archive is a
            // copy of the transcripts, and one missing the sessions already
            // imported would be useless as the backup it exists to be.
            const planned = Object.values(index.entries)
              .filter((entry) => !entry.missing)
              .sort((a, b) => b.modified - a.modified)

            const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")
            const file = path.join(config.exportDir || EXPORT_DIR, `sessions-${device.id}-${stamp}.tar.gz`)
            handle.step(0, planned.length, `Exporting ${planned.length} sessions`)
            handle.log(`writing ${file}`)

            const result = await archiveBatch(file, planned, (done, total) =>
              handle.step(done, total, `Exporting history ${done}/${total}`),
            )
            for (const failure of result.failures) handle.log(`${failure.key}: ${failure.error}`, "warn")

            const mb = (result.bytes / 1024 / 1024).toFixed(1)
            const summary =
              `Exported ${result.sessions} sessions (${mb} MB) to ${result.file}` +
              (result.failures.length ? `; ${result.failures.length} could not be read.` : ".")
            handle.finish("done", summary)
            return summary
          } catch (error) {
            handle.finish("failed", error instanceof Error ? error.message : String(error))
            throw error
          }
        },
      },

      /**
       * Read an archive back in.
       *
       * Given no path it takes the newest archive in the configured folder,
       * which is what "restore what I just exported" means; a path names any
       * other file, including one carried from another device.
       */
      "import-archive": {
        label: "Import from .tar.gz",
        async run(input) {
          if (!Registry.isEnabled(PLUGIN_ID)) return "session-manager is disabled"
          if (Progress.running(PLUGIN_ID, "import-archive")) return "An archive import is already running."

          const handle = Progress.start(PLUGIN_ID, "import-archive", "Opening the archive…")
          try {
            const config = await PCP.resolveConfig()
            const folder = config.exportDir || EXPORT_DIR
            const [named] = splitInput(input)
            let file = named.trim()

            if (!file) {
              const entries = await fsp.readdir(folder).catch(() => [] as string[])
              const archives = entries.filter((name) => name.endsWith(".tar.gz")).sort()
              if (archives.length === 0) {
                handle.finish("failed", `No .tar.gz found in ${folder}`)
                return `No archive found in ${folder} — export one first, or give a path.`
              }
              // Lexical order is chronological: the names are timestamped.
              file = path.join(folder, archives[archives.length - 1]!)
              handle.log(`no path given — using the newest archive in ${folder}`)
            } else if (!path.isAbsolute(file)) {
              file = path.join(folder, file)
            }

            await fsp.access(file)
            const tally = await importArchive(file, handle)
            const summary =
              `Imported ${tally.imported}, merged ${tally.merged}, skipped ${tally.skipped} already current` +
              (tally.failed ? `; ${tally.failed} failed.` : ".")
            handle.finish(tally.failed ? "failed" : "done", summary)
            return (
              summary +
              (tally.imported + tally.merged > 0 ? " Restart opencode to see them in the session picker." : "")
            )
          } catch (error) {
            handle.finish("failed", error instanceof Error ? error.message : String(error))
            throw error
          }
        },
      },

      "export-all": {
        label: "Push sessions to PCP",
        async run() {
          if (!Registry.isEnabled(PLUGIN_ID)) return "session-manager is disabled"
          if (Progress.running(PLUGIN_ID, "export-all")) return "A push is already running."

          const handle = Progress.start(PLUGIN_ID, "export-all", "Scanning the session stores…")
          try {
            const config = await PCP.resolveConfig()
            const device = await localDevice()
            const index = await Index.load()
            Index.reconcile(index, await scanAll(), device.id)

            const planned = pendingPushes(index)
            if (planned.length === 0) {
              await Index.save(index)
              handle.finish("done", "Nothing to push — PCP is up to date.")
              return "Nothing to push — PCP holds every indexed transcript at its current length."
            }

            handle.step(0, planned.length, `Pushing ${planned.length} sessions to ${config.baseURL}`)
            const { tally, results } = await pushBatch(index, config, planned, (done, total) =>
              handle.step(done, total, `Pushing ${done}/${total}: ${planned[done - 1]!.title.slice(0, 60)}`),
            )
            for (const result of results) {
              if (result.status === "failed") handle.log(`${result.key}: ${result.error}`, "error")
            }

            const summary =
              `Pushed ${tally.pushed} of ${planned.length} to ${config.baseURL}` +
              (tally.failed ? `; ${tally.failed} failed.` : ".")
            handle.finish(tally.failed ? "failed" : "done", summary)
            return summary
          } catch (error) {
            handle.finish("failed", error instanceof Error ? error.message : String(error))
            throw error
          }
        },
      },

      /**
       * Branch a new session from one message of an existing one.
       *
       * Finding the turn where something was decided is usually the point of
       * searching; continuing from there, without the turns that came after,
       * is what makes that useful. opencode's own fork endpoint does the copy,
       * so the branch is a first-class session rather than a transcript this
       * plugin reassembled.
       */
      "fork-session": {
        label: "Fork from this message",
        hidden: true,
        async run(input) {
          const [sessionID, messageID] = splitInput(input)
          if (!sessionID || !messageID) throw new Error("Pick a message to fork from")

          // The API is directory-scoped: a session in another project is only
          // reachable when its own directory is named.
          const db = DB.open(true)
          let directory: string | null = null
          try {
            const row = db.prepare(`SELECT directory FROM "session" WHERE id = ?`).get(sessionID) as
              | { directory: string | null }
              | undefined
            if (!row) throw new Error(`Unknown session: ${sessionID}`)
            directory = row.directory ?? null
          } finally {
            db.close()
          }

          const response = await client.session.fork({
            path: { id: sessionID },
            body: { messageID },
            ...(directory ? { query: { directory } } : {}),
          })
          if (response.error) {
            const message =
              typeof response.error === "string" ? response.error : JSON.stringify(response.error)
            throw new Error(`Fork failed: ${message.slice(0, 200)}`)
          }

          const forked = (response.data as { id?: string; title?: string } | undefined) ?? {}
          log("info", `forked ${sessionID} at ${messageID} → ${forked.id ?? "?"}`)
          return forked.id
            ? `Forked into ${forked.title || forked.id}. Open it from the opencode session picker.`
            : "Forked."
        },
      },

      /**
       * Project edits, driven by the ⋯ menu on the Projects panel.
       *
       * Each receives `"<projectID>=<value>"` (or a bare id) from the menu
       * control. opencode reads the project list at startup, so every one of
       * these ends by telling the user to restart before the change shows up
       * in the app itself.
       */
      /**
       * Hand a project to the desktop app.
       *
       * This opens the project, not a specific session: the app's deep-link
       * handler accepts only `open-project` and `new-session`, so there is no
       * way to focus one session from here. Session cards therefore open their
       * transcript in this dashboard instead.
       */
      "open-project": {
        label: "Open in opencode",
        // Needs a project, so it is offered by the ⋯ menu that knows which one.
        hidden: true,
        async run(input) {
          const [projectID] = splitInput(input)
          if (!projectID) throw new Error("Pick a project to open")

          const db = DB.open(true)
          let project: DB.ProjectRow | undefined
          try {
            project = DB.listProjects(db).find((entry) => entry.id === projectID)
          } finally {
            db.close()
          }
          if (!project) throw new Error(`Unknown project: ${projectID}`)

          await Desktop.openProject(project.worktree)
          log("info", `opened project ${project.name} in the desktop app`)
          return `Opening ${project.name} in opencode.`
        },
      },

      "rename-project": {
        label: "Rename project",
        hidden: true,
        async run(input) {
          const [projectID, name] = splitInput(input)
          if (!projectID || !name) throw new Error("Pick a project and enter a name")
          const db = DB.open()
          try {
            DB.renameProject(db, projectID, name)
          } finally {
            db.close()
          }
          log("info", `renamed project ${projectID} to ${name}`)
          return `Renamed to "${name}" — restart opencode to see it in the app.`
        },
      },

      "add-directory": {
        label: "Add folder",
        hidden: true,
        async run(input) {
          const [projectID, directory] = splitInput(input)
          if (!projectID || !directory) throw new Error("Pick a project and enter a folder or URL")
          const db = DB.open()
          try {
            DB.addProjectDirectory(db, projectID, directory)
          } finally {
            db.close()
          }
          log("info", `added directory ${directory} to ${projectID}`)
          return `Added ${directory} — restart opencode to see it in the app.`
        },
      },

      "merge-project": {
        label: "Merge project",
        hidden: true,
        async run(input) {
          const [fromID, intoID] = splitInput(input)
          if (!fromID || !intoID) throw new Error("Pick a project to merge into")
          const db = DB.open()
          let result: DB.MergeResult
          try {
            result = DB.mergeProjects(db, fromID, intoID)
          } finally {
            db.close()
          }
          log("info", `merged ${fromID} into ${intoID}`, { moved: result.moved })
          return (
            `Moved ${result.moved} sessions — backup at ${result.backup}. ` +
            "Restart opencode to see the merge in the app."
          )
        },
      },
    },
  })

  /**
   * How much each project still owes, taken from the index.
   *
   * A project is matched to index entries by working directory, because that is
   * exactly what `importSession` registers against the project row — no git or
   * remote resolution is repeated here, so this stays cheap enough for a panel
   * the dashboard polls. A pending transcript in a directory no project owns
   * yet belongs to no project until its first import, and is counted by the
   * Settings tab's totals instead.
   */

}
