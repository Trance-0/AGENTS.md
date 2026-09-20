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
import * as PCP from "../lib/pcp.ts"
import { LARGE_FILE_BYTES, readTurns, scanAll } from "../lib/sources.ts"
import { local as localDevice } from "../lib/device.ts"
import type { IndexEntry } from "../lib/index-store.ts"

type Logger = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void

/** Bound the number of turns copied from a single transcript. */
const MAX_TURNS = 4000

/**
 * Cards rendered on the Info tab.
 *
 * The index holds hundreds of transcripts; rendering every one would make the
 * page slow to paint and impossible to read. The filter chips narrow by state,
 * and the tools remain the way to query the whole set.
 */
const PANEL_LIMIT = 60

/** Card accent per index state, so the exceptional rows stand out. */
const TONE = {
  imported: "ok",
  pending: "warn",
  conflict: "error",
  missing: "muted",
} as const

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

/** How each session source is labelled on a card. */
const SOURCE_LABEL: Record<string, string> = {
  opencode: "opencode",
  claude: "Claude Code",
  codex: "Codex",
  dsh: "dsh",
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
      const config = await PCP.resolveConfig()
      return [
        { key: "baseURL", label: "PCP base URL", type: "string", value: config.baseURL, placeholder: "https://…" },
        { key: "scopedToken", label: "PCP scoped token", type: "string", value: config.scopedToken, secret: true, placeholder: "pcp_…" },
      ]
    },
    async update(key, value) {
      if (key !== "baseURL" && key !== "scopedToken") throw new Error(`unknown setting: ${key}`)
      const text = String(value).trim()
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
        { label: "pending", value: counts.total - counts.imported, tone: counts.total > counts.imported ? "warn" : "muted" },
        { label: "conflicts", value: counts.conflicts, tone: counts.conflicts > 0 ? "error" : "muted" },
        { label: "opencode sessions", value: live.sessions, tone: "ok" },
        { label: "native", value: native, tone: "muted" },
        { label: "projects", value: live.projects, tone: "muted" },
        { label: "device", value: device.id, tone: "muted" },
      ]
    },
    /**
     * The Info tab: every indexed transcript paired with what it became.
     *
     * Without this the page was empty — the tab renders panels, and this plugin
     * registered none. Each card carries both halves of the mapping: the source
     * store, file and native id on one side, the opencode session it was
     * imported into on the other, so an import can be traced in either
     * direction. Imported rows link to that session's own page.
     */
    async panels() {
      const index = await Index.load()
      const entries = Object.values(index.entries).sort((a, b) => b.modified - a.modified)
      const counts = Index.stats(index)

      const items = entries.slice(0, PANEL_LIMIT).map((entry) => {
        const imported = entry.imported
        const group = entry.missing ? "missing" : entry.conflict ? "conflict" : imported ? "imported" : "pending"

        return {
          title: entry.title,
          // The source file is the thing to go look at when an import is wrong.
          subtitle: entry.file,
          tone: TONE[group],
          group,
          fields: [
            { label: "source", value: entry.kind },
            { label: "source id", value: entry.nativeID },
            { label: "device", value: entry.device },
            { label: "directory", value: entry.directory || "—" },
            { label: "modified", value: new Date(entry.modified).toISOString().slice(0, 16).replace("T", " ") },
            { label: "size", value: `${Math.round(entry.size / 1024)} KB` },
            ...(imported
              ? [
                  { label: "session", value: imported.sessionID, tone: "ok" as const },
                  { label: "turns", value: String(imported.turns) },
                ]
              : [{ label: "session", value: "not imported", tone: "muted" as const }]),
            ...(entry.conflict ? [{ label: "conflict", value: entry.conflict, tone: "warn" as const }] : []),
          ],
          // Opens the imported transcript; a source with no session has nothing
          // to open yet, so it stays a plain card.
          ...(imported ? { link: { view: "session", arg: imported.sessionID } } : {}),
        }
      })

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

      const mergeTargets = projects.map((project) => ({
        value: project.id,
        label: `${project.name} (${project.sessions})`,
      }))

      return [
        {
          key: "projects",
          type: "tree" as const,
          title: "Projects",
          description:
            `${projects.length} projects across ${projects.reduce((n, p) => n + p.sessions, 0)} opencode sessions. ` +
            "Expand a project to load its sessions; each card is labelled with the source it came from. " +
            "Use the ⋯ menu to rename a project, add a directory, or merge it into another.",
          items: [],
          groups: projects.map((project) => ({
            id: project.id,
            title: project.name,
            subtitle: project.directories.length > 1
              ? `${project.worktree}  (+${project.directories.length - 1} more)`
              : project.worktree,
            count: project.sessions,
            fields: [
              ...Object.entries(project.bySource)
                .sort((a, b) => b[1] - a[1])
                .map(([source, n]) => ({ label: source, value: String(n) })),
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
          })),
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
        {
          key: "sessions",
          title: "Indexed sessions",
          description:
            `${counts.total} transcripts across ${Object.keys(counts.byKind).length} stores; ` +
            `${counts.imported} imported into opencode. Imported rows open the session.`,
          items,
          empty: "No transcripts indexed yet — run Rescan stores.",
          filters: ["imported", "pending", "conflict", "missing"],
          updatedAt: index.updatedAt || null,
          action: "scan",
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
          hits = DB.search(db, query, { limit: 60 })
        } finally {
          db.close()
        }

        return hits.map((hit) => ({
          title: hit.title,
          subtitle: hit.snippet || undefined,
          tone: hit.source === "opencode" ? ("ok" as const) : ("muted" as const),
          fields: [
            { label: "project", value: hit.projectName },
            { label: "source", value: SOURCE_LABEL[hit.source] ?? hit.source },
            { label: "matches", value: String(hit.matches), tone: "ok" as const },
            { label: "updated", value: new Date(hit.updated).toISOString().slice(0, 16).replace("T", " ") },
          ],
          link: { view: "session", arg: hit.sessionID },
        }))
      },
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

          const pending = Object.values(index.entries)
            .filter((entry) => !entry.missing)
            .filter((entry) => !entry.pcp || entry.pcp.fingerprint !== entry.fingerprint)
            .sort((a, b) => b.modified - a.modified)
          const planned = args.limit ? pending.slice(0, args.limit) : pending

          if (args.dryRun) {
            await Index.save(index)
            return {
              title: `${planned.length} sessions pending for PCP`,
              output: JSON.stringify({ dryRun: true, pending: planned.length, sessions: planned.slice(0, 40).map(summarize) }, null, 2),
            }
          }

          const tally = { pushed: 0, "up-to-date": 0, empty: 0, failed: 0 }
          const results: Array<Record<string, unknown>> = []

          for (const [position, entry] of planned.entries()) {
            if (context.abort.aborted) break

            context.metadata({
              title: `Pushing ${position + 1}/${planned.length}: ${entry.title.slice(0, 60)}`,
              metadata: { progress: position + 1, total: planned.length, ...tally },
            })

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
