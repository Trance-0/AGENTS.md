/** Session indexing, project/context sync, and import/export plugin. */
import type { Plugin } from "@opencode-ai/plugin"
import { Registry, Logs, PLUGIN_ID, SWEEP_KEY, DirectorySync, RESCAN_INTERVAL_MS, SOURCE_LABEL } from "../lib/session-manager-common.ts"
import type { Logger } from "../lib/session-manager-common.ts"
import { createSessionOperations } from "../lib/session-manager-operations.ts"
import { registerSessionPanel } from "../lib/session-manager-panel.ts"
import { createSessionHooks } from "../lib/session-manager-tools.ts"

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

  const operations = createSessionOperations(log, sweepState, directory)
  const { sweep } = operations
  registerSessionPanel(operations, log, client)
  // One sweep shortly after startup, then on a slow timer — scheduled once for
  DirectorySync.start(() => Registry.get(PLUGIN_ID)!.actions!["import-all"]!.run())
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

  return createSessionHooks(operations, log)
}
