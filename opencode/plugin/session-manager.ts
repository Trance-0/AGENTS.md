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
import * as Index from "../lib/index-store.ts"
import * as DB from "../lib/db.ts"
import * as Identity from "../lib/project-identity.ts"
import * as Desktop from "../lib/desktop.ts"
import * as Registry from "../lib/registry.ts"
import * as PCP from "../lib/pcp.ts"
import * as Logs from "../lib/logs.ts"
import * as Archive from "../lib/archive.ts"
import * as Progress from "../lib/progress.ts"
import * as Transfer from "../lib/session-transfer.ts"
import * as DirectorySync from "../lib/directory-sync.ts"
import { LARGE_FILE_BYTES, readTurns, scanAll } from "../lib/sources.ts"
import { local as localDevice } from "../lib/device.ts"
import { DATA_DIR } from "../lib/paths.ts"
import type { IndexEntry } from "../lib/index-store.ts"
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

export const SessionManager: Plugin = async ({ client, directory }) => {
  await Registry.init()

  /**
   * Sweep bookkeeping, shared by every instance in the process.
   *
   * opencode instantiates this plugin once per project — 40+ times here — and
   * they all share one index file. Per-instance guards would let all of them
   * scan and save at once, and on Windows two concurrent saves make the
   * atomic rename fail with EPERM because the target is still open. State on
   * `globalThis` is what makes "one sweep at a time" mean one per process.
   */
  const sweepState = ((globalThis as Record<symbol, unknown>)[SWEEP_KEY] ??= {
    running: false,
    last: 0,
    scheduled: false,
  }) as { running: boolean; last: number; scheduled: boolean }

  const log: Logger = (level, message, extra) => {
    // Both sinks: opencode's shared stream cannot be read back, so the
    // dashboard's Logging tab needs its own copy or it stays empty.
    Logs.log(PLUGIN_ID, extra ? `${message} ${JSON.stringify(extra)}` : message, level === "debug" ? "info" : level)
    client.app
      .log({ body: { service: PLUGIN_ID, level, message, ...(extra ? { extra } : {}) } })
      .catch(() => {})
  }

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
          options: [{ value: "manual", label: "Manual — read on request" }, { value: "import", label: "Import — automatically read and merge" }, { value: "auto", label: "Auto — read, merge and publish" }] },
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
      "sync-directory": { label: "Sync / read folder now", hidden: true, run: () => DirectorySync.sync() },
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
  async function projectBacklog(projects: DB.ProjectRow[]) {
    const state = new Map<string, { pending: number; conflicts: number; imported: number }>()
    const byDirectory = new Map<string, string>()
    for (const project of projects) {
      state.set(project.id, { pending: 0, conflicts: 0, imported: 0 })
      for (const directory of [project.worktree, ...project.directories]) {
        if (directory) byDirectory.set(normalize(directory), project.id)
      }
    }

    const index = await Index.load().catch(() => null)
    if (!index) return state

    for (const entry of Object.values(index.entries)) {
      if (entry.missing) continue
      const projectID = entry.imported?.projectID ?? byDirectory.get(normalize(entry.directory))
      const counts = projectID ? state.get(projectID) : undefined
      if (!counts) continue

      if (entry.conflict) counts.conflicts++
      else if (entry.imported) counts.imported++
      else if (entry.emptyAt !== entry.fingerprint) counts.pending++
    }
    return state
  }

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
    if (turns.length === 0) {
      // Remembered against this fingerprint, so a transcript that decodes to
      // nothing stops being re-read by every sync and stops counting as owed.
      // A later version of the same file has a new fingerprint and is retried.
      entry.emptyAt = entry.fingerprint
      return { key: entry.key, status: "empty" as const }
    }
    delete entry.emptyAt

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
        // The tool's own name when it has one: Codex writes a short summary
        // like "Debug slow Python extension load", which is far better than
        // the raw first prompt this otherwise falls back to. Both are kept —
        // `sourceTitle` below preserves the original regardless.
        title: entry.sourceTitle || entry.title,
        turns,
        created: entry.created,
        model: entry.model,
        source: entry.kind,
        sourceID: entry.nativeID,
        device: entry.device,
        branch: entry.branch,
        sourceTitle: entry.sourceTitle,
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

  /**
   * Push one indexed transcript to PCP, resuming from its remote cursor.
   *
   * The external key is what makes a retry idempotent: PCP returns the existing
   * remote session for a key it has already seen, so only the turns after the
   * cursor are uploaded. A source that shrank was rewritten under the same id,
   * which the append-only remote cannot represent — that needs an explicit
   * `force` replay rather than a silent partial upload.
   */
  async function pushOne(entry: IndexEntry, config: PCP.Config, force: boolean) {
    const externalKey = `${entry.device}:${entry.kind}:${entry.nativeID}`
    const turns = (await readTurns(entry, LARGE_FILE_BYTES)).slice(0, MAX_TURNS)
    if (turns.length === 0) return { key: entry.key, externalKey, status: "empty" as const }

    const previous = entry.pcp
    if (previous && !force && turns.length < previous.turns) {
      throw new Error(`${entry.key} was rewritten under the same id; push it again with force to replay it`)
    }

    const remote = await PCP.ensureSession(config, externalKey, entry.title, "exact")
    const token = remote.access_token ?? previous?.accessToken
    const start = force ? 0 : (previous?.turns ?? 0)

    for (let offset = start; offset < turns.length; offset += PCP.MAX_MESSAGES_PER_REQUEST) {
      await PCP.appendMessages(
        config,
        remote.session_id,
        token ?? "",
        turns.slice(offset, offset + PCP.MAX_MESSAGES_PER_REQUEST).map((turn) => ({
          role: turn.role,
          content: turn.text.slice(0, PCP.MAX_CONTENT_CHARS),
          provider: entry.kind,
          base_model: entry.model || undefined,
          provider_timestamp: turn.time ? new Date(turn.time).toISOString() : undefined,
        })),
      )
    }

    entry.pcp = {
      sessionID: remote.session_id,
      accessToken: token,
      turns: turns.length,
      fingerprint: entry.fingerprint,
      pushedAt: Date.now(),
    }

    const added = turns.length - start
    if (added > 0) log("info", `pushed ${added} turns of ${entry.key} to ${remote.session_id}`)
    return {
      key: entry.key,
      externalKey,
      status: added > 0 ? ("pushed" as const) : ("up-to-date" as const),
      sessionID: remote.session_id,
      turns: turns.length,
      added,
    }
  }

  /** Indexed transcripts that opencode does not hold at their current length. */
  function pendingImports(index: Index.Index, source?: string) {
    return Object.values(index.entries)
      .filter((entry) => !entry.missing)
      .filter((entry) => (source ? entry.kind === source : true))
      // A transcript already found to decode to nothing at this exact
      // fingerprint owes nothing; re-reading it every pass only ever produces
      // the same verdict.
      .filter((entry) => entry.emptyAt !== entry.fingerprint)
      .filter((entry) => !entry.imported || entry.conflict)
      .sort((a, b) => b.modified - a.modified)
  }

  /** Indexed transcripts PCP does not hold at their current length. */
  function pendingPushes(index: Index.Index) {
    return Object.values(index.entries)
      .filter((entry) => !entry.missing)
      .filter((entry) => !entry.pcp || entry.pcp.fingerprint !== entry.fingerprint)
      .sort((a, b) => b.modified - a.modified)
  }

  /**
   * Import a batch, reporting progress and persisting as it goes.
   *
   * Shared by the `session_sync_all` tool and the Settings button so the two
   * cannot drift: the button is the same operation with no model in the loop.
   */
  async function importBatch(
    index: Index.Index,
    planned: IndexEntry[],
    progress?: (done: number, total: number, tally: Record<string, number>) => void,
    aborted?: () => boolean,
  ) {
    const tally = { imported: 0, merged: 0, branched: 0, skipped: 0, empty: 0, failed: 0 }
    const failures: Array<{ key: string; error: string }> = []
    const resolver = await resolverFor(index)

    for (const [position, entry] of planned.entries()) {
      if (aborted?.()) break
      progress?.(position + 1, planned.length, tally)

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
    log("info", "sync complete", { ...tally })
    return { tally, failures }
  }

  /** Push a batch to PCP, resuming each session from its own remote cursor. */
  async function pushBatch(
    index: Index.Index,
    config: PCP.Config,
    planned: IndexEntry[],
    progress?: (done: number, total: number, tally: Record<string, number>) => void,
    aborted?: () => boolean,
  ) {
    const tally: Record<string, number> = { pushed: 0, "up-to-date": 0, empty: 0, failed: 0 }
    const results: Array<Record<string, unknown>> = []

    for (const [position, entry] of planned.entries()) {
      if (aborted?.()) break
      progress?.(position + 1, planned.length, tally)

      try {
        const result = await pushOne(entry, config, false)
        tally[result.status] = (tally[result.status] ?? 0) + 1
        results.push(result)
      } catch (error) {
        tally.failed++
        const message = error instanceof Error ? error.message : String(error)
        results.push({ key: entry.key, status: "failed", error: message })
        log("warn", `PCP push failed for ${entry.key}: ${message}`)
      }

      // Persist incrementally so an interrupted run never re-uploads turns.
      if (position % 20 === 19) await Index.save(index)
    }

    await Index.save(index)
    log("info", "PCP sync complete", { ...tally })
    return { tally, results }
  }

  /**
   * Write transcripts to a local `.tar.gz`.
   *
   * The third destination, alongside opencode's database and PCP: a single file
   * that needs no server and no database to read, which is what makes it the
   * one usable for a backup or for moving work onto a machine that has neither.
   *
   * Each session becomes `sessions/<kind>/<nativeID>.json` holding its
   * descriptor and its normalised turns, so an archive is self-describing —
   * `manifest.json` lists what is inside but nothing depends on it. Turns are
   * read one session at a time and handed straight to the writer, so the
   * archive streams rather than being assembled in memory.
   */
  async function archiveBatch(
    file: string,
    planned: IndexEntry[],
    progress?: (done: number, total: number) => void,
    aborted?: () => boolean,
  ) {
    return Transfer.exportLocal(file, planned, progress, aborted)
  }

  async function legacyArchiveBatch(
    file: string,
    planned: IndexEntry[],
    progress?: (done: number, total: number) => void,
    aborted?: () => boolean,
  ) {
    const written: Array<{ key: string; name: string; turns: number }> = []
    const failures: Array<{ key: string; error: string }> = []
    const device = await localDevice()

    const result = await Archive.writeTarGz(
      file,
      (async function* () {
        for (const [position, entry] of planned.entries()) {
          if (aborted?.()) break
          progress?.(position + 1, planned.length)

          let turns
          try {
            turns = (await readTurns(entry, LARGE_FILE_BYTES)).slice(0, MAX_TURNS)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            failures.push({ key: entry.key, error: message })
            log("warn", `archive failed for ${entry.key}: ${message}`)
            continue
          }
          if (turns.length === 0) continue

          const name = `sessions/${entry.kind}/${entry.nativeID}.json`
          written.push({ key: entry.key, name, turns: turns.length })
          yield {
            name,
            mtime: entry.modified,
            data: JSON.stringify({ session: summarize(entry), turns }, null, 2),
          }
        }

        // Last, so it can describe what was actually written rather than what
        // was planned — a session that failed to read is absent from both.
        yield {
          name: "manifest.json",
          data: JSON.stringify(
            {
              version: 1,
              exportedAt: new Date().toISOString(),
              device: { id: device.id, hostname: device.hostname },
              sessions: written.length,
              failures,
              files: written,
            },
            null,
            2,
          ),
        }
      })(),
    )

    log("info", `archived ${written.length} sessions to ${file}`, { bytes: result.bytes })
    return { file, ...result, sessions: written.length, failures }
  }

  /**
   * Import sessions out of a `.tar.gz` written by the exporter.
   *
   * The inverse of `archiveBatch`, and the way work reaches a machine whose
   * source stores do not hold it — a second device's transcripts, or a restore
   * after the stores are gone.
   *
   * Duplicates merge on their own because identity is the archive's own
   * `<kind>:<nativeID>` key, the same one the local scan produces. An archived
   * session already in opencode is therefore recognised as that session:
   * shorter or equal, it is skipped; longer, only its new tail is appended.
   * Nothing is ever written twice, so importing the same archive repeatedly is
   * a no-op rather than a pile of copies.
   */
  async function importArchive(file: string, handle: Progress.Handle) {
    return Transfer.importLocal(file, handle)
  }

  async function legacyImportArchive(file: string, handle: Progress.Handle) {
    const tally = { imported: 0, merged: 0, skipped: 0, empty: 0, failed: 0 }
    const index = await Index.load()
    const resolver = await resolverFor(index)

    // Counted first so the bar has a denominator. The archive is read twice,
    // which for a file of this size is far cheaper than holding every
    // transcript in memory to count them.
    let total = 0
    for await (const entry of Archive.readTarGz(file)) {
      if (entry.name !== "manifest.json") total++
    }
    handle.step(0, total, `Importing ${total} sessions from ${path.basename(file)}`)
    handle.log(`reading ${file}`)

    let done = 0
    for await (const file_ of Archive.readTarGz(file)) {
      if (file_.name === "manifest.json") continue
      done++

      let parsed: { session?: Record<string, unknown>; turns?: Array<{ role: string; text: string; time?: number }> }
      try {
        parsed = JSON.parse(file_.data.toString("utf8"))
      } catch {
        tally.failed++
        handle.log(`${file_.name}: not valid JSON`, "warn")
        continue
      }

      const descriptor = parsed.session ?? {}
      const key = typeof descriptor.key === "string" ? descriptor.key : ""
      const turns = (parsed.turns ?? []).filter(
        (turn): turn is { role: "user" | "assistant"; text: string; time?: number } =>
          (turn?.role === "user" || turn?.role === "assistant") && typeof turn.text === "string",
      )

      if (!key) {
        tally.failed++
        handle.log(`${file_.name}: no session key`, "warn")
        continue
      }
      handle.step(done, total, `Importing ${done}/${total}: ${String(descriptor.title ?? key).slice(0, 60)}`)

      if (turns.length === 0) {
        tally.empty++
        continue
      }

      // The archive's descriptor becomes an index entry when this device has
      // never seen the session. Its `file` points into an archive rather than
      // a live store, so it is marked missing: a later scan must not conclude
      // the source vanished from a store it was never in.
      const existing = index.entries[key]
      const entry: IndexEntry = existing ?? {
        key,
        kind: (descriptor.kind as IndexEntry["kind"]) ?? "claude",
        nativeID: String(descriptor.key ?? key).split(":").slice(1).join(":") || key,
        file: `${file}!${file_.name}`,
        directory: typeof descriptor.directory === "string" ? descriptor.directory : "",
        remote: (descriptor.remote as string | null) ?? null,
        branch: (descriptor.branch as string | null) ?? null,
        device: typeof descriptor.device === "string" ? descriptor.device : "archive",
        title: typeof descriptor.title === "string" ? descriptor.title : key,
        sourceTitle: (descriptor.sourceTitle as string | null) ?? null,
        model: typeof descriptor.model === "string" ? descriptor.model : "",
        created: Date.parse(String(descriptor.created ?? "")) || file_.mtime || Date.now(),
        modified: Date.parse(String(descriptor.modified ?? "")) || file_.mtime || Date.now(),
        size: file_.data.length,
        fingerprint: `${file_.data.length}:${file_.mtime ?? 0}`,
        missing: true,
      }

      try {
        const already = entry.imported
        const db = DB.open()
        try {
          const live = already && DB.sessionExists(db, already.sessionID)

          if (live && turns.length <= already!.turns) {
            tally.skipped++
            continue
          }

          if (live) {
            // Known session, longer in the archive: append only what is new.
            const added = DB.appendTurns(db, {
              sessionID: already!.sessionID,
              target: await resolver.identify(entry.directory || directory),
              turns: turns.slice(already!.turns),
              model: entry.model,
              source: entry.kind,
            })
            already!.turns = turns.length
            tally.merged++
            handle.log(`merged ${added} new turns into ${already!.sessionID}`)
          } else {
            const target = await resolver.identify(entry.directory || directory)
            const result = DB.importSession(db, {
              target,
              title: entry.sourceTitle || entry.title,
              turns,
              created: entry.created,
              model: entry.model,
              source: entry.kind,
              sourceID: entry.nativeID,
              device: entry.device,
              branch: entry.branch,
              sourceTitle: entry.sourceTitle,
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
            tally.imported++
          }
        } finally {
          db.close()
        }
        index.entries[key] = entry
      } catch (error) {
        tally.failed++
        const message = error instanceof Error ? error.message : String(error)
        handle.log(`${key}: ${message}`, "error")
        log("warn", `archive import failed for ${key}: ${message}`)
      }

      if (done % 20 === 0) await Index.save(index)
    }

    await Index.save(index)
    log("info", `archive import complete from ${file}`, { ...tally })
    return tally
  }

  /**
   * Fold the source stores into the index without importing anything.
   *
   * Scanning is stat-and-head only, so it is cheap enough to run while
   * opencode is working; importing is not, and is left to an explicit request.
   */
  async function sweep(reason: string) {
    if (!Registry.isEnabled(PLUGIN_ID)) return null
    if (sweepState.running) return null

    // A scan asked for by hand, or the one on load, runs regardless of when
    // the last one happened; only the periodic sweep is paced. Without the
    // `load` exemption a second opencode window starting inside the interval
    // would come up with a stale index.
    const forced = reason === "manual" || reason === "load"
    const now = Date.now()
    if (!forced && now - sweepState.last < RESCAN_INTERVAL_MS) return null

    sweepState.running = true
    try {
      const device = await localDevice()
      const index = await Index.load()
      const scanned = await scanAll()
      const diff = Index.reconcile(index, scanned, device.id)
      await Index.save(index)
      sweepState.last = Date.now()

      const changed = diff.added.length + diff.grown.length + diff.rewritten.length
      // Only speak up when something moved; a quiet sweep every ten minutes
      // would bury the lines that matter.
      if (changed > 0 || reason === "manual") {
        log(
          "info",
          `${reason} scan: ${scanned.length} transcripts, ${diff.added.length} new, ` +
            `${diff.grown.length} grown, ${diff.rewritten.length} rewritten`,
        )
      }

      const counts = Index.stats(index)
      const pending = counts.total - counts.imported
      if (pending > 0 && changed > 0) {
        log("info", `${pending} transcripts are not yet imported — run session_sync_all to bring them in`)
      }
      return { scanned: scanned.length, ...diff }
    } catch (error) {
      log("warn", `scan failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    } finally {
      sweepState.running = false
    }
  }

  // One sweep shortly after startup, then on a slow timer — scheduled once for
  DirectorySync.start()
  // the whole process, not once per project instance, or 40+ copies would fire
  // together. `unref` keeps the timers from holding opencode open.
  if (!sweepState.scheduled) {
    sweepState.scheduled = true

    // A scan on load, so the index reflects what is on disk from the first
    // moment rather than after a wait. It is deferred by a tick — not run
    // inline — because a plugin that blocks its own construction delays
    // opencode's startup, and scanning is stat-and-head work that does not
    // need to happen before the editor is usable.
    const initial = setTimeout(() => void sweep("load"), 0)
    const repeat = setInterval(() => void sweep("periodic"), RESCAN_INTERVAL_MS)
    if (typeof initial.unref === "function") initial.unref()
    if (typeof repeat.unref === "function") repeat.unref()

    log("info", `loaded — watching ${Object.keys(SOURCE_LABEL).length - 1} source stores, scanning now`)
  }

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
