import { pushTranscript } from "./pcp-project-sync.ts"
import { Index, DB, Identity, Desktop, Registry, PCP, Logs, Archive, Progress, Transfer, DirectorySync, LARGE_FILE_BYTES, readTurns, scanAll, localDevice, DATA_DIR, path, fsp, tool, PLUGIN_ID, SWEEP_KEY, MAX_TURNS, RESCAN_INTERVAL_MS, summarize, SOURCE_LABEL, REVIEW_STATE, REVIEW_LIMIT, PROJECT_STATUS, projectStatus, EXPORT_DIR, reviewState, normalize, splitInput } from "./session-manager-common.ts"
import type { Plugin, Logger, IndexEntry } from "./session-manager-common.ts"

export function createSessionOperations(log: Logger, sweepState: { running: boolean; last: number; scheduled: boolean }, directory: string) {
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
    const turns = (await readTurns(entry, LARGE_FILE_BYTES)).slice(0, MAX_TURNS)
    const identity = await Identity.resolve({ directory: entry.directory, recordedRemote: entry.remote })
    const result = await pushTranscript(entry, config, turns, identity, force)
    if ('added' in result && (result.added ?? 0) > 0) log("info", `pushed ${result.added} turns of ${entry.key} to ${result.sessionID}`)
    return result
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
    if (reason !== "manual" && (await DirectorySync.config()).mode === "directory") return null
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


  return { projectBacklog, resolverFor, importOne, pushOne, pendingImports, pendingPushes, importBatch, pushBatch, archiveBatch, legacyArchiveBatch, importArchive, legacyImportArchive, sweep }
}
