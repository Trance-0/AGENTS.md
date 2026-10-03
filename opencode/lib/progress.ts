/**
 * Live progress for a long-running plugin action.
 *
 * An action is one POST that does not answer until it is finished, so a bulk
 * import spent minutes with nothing on screen but a disabled button. Nothing
 * about the request can report progress — the response is the only message it
 * ever sends — so the work publishes here instead and the dashboard, which is
 * already polling, reads it out.
 *
 * State lives on `globalThis`: opencode instantiates each plugin once per
 * project, and the run publishing progress is rarely in the same instance the
 * dashboard's snapshot is built from.
 *
 * A finished run is kept, not deleted, so the outcome is still readable after
 * the last poll — the reader has to learn how it ended, not just that it
 * stopped. The next run on the same key replaces it.
 */

const KEY = Symbol.for("@dsh/opencode-plugin-progress")

/** Log lines retained per run; enough to show what happened, bounded. */
const MAX_LINES = 200

export type Run = {
  /** Plugin that owns this run. */
  pluginID: string
  /** Action key, so two concurrent operations do not overwrite each other. */
  action: string
  /** Shown above the bar, e.g. "Importing 24/330". */
  title: string
  done: number
  total: number
  /** Unset while running; set once, when the run ends. */
  status: "running" | "done" | "failed"
  startedAt: number
  endedAt: number | null
  /** Most recent lines, oldest first. */
  lines: Array<{ at: number; text: string; level: "info" | "warn" | "error" }>
}

function store(): Map<string, Run> {
  const g = globalThis as Record<symbol, unknown>
  if (!g[KEY]) g[KEY] = new Map<string, Run>()
  return g[KEY] as Map<string, Run>
}

const keyOf = (pluginID: string, action: string) => `${pluginID}:${action}`

/**
 * A handle the running action reports through.
 *
 * Returned rather than exposing the map, so an action cannot accidentally
 * report against another run's key, and so `finish` is the only way a run
 * leaves the "running" state.
 */
export type Handle = {
  step: (done: number, total: number, title?: string) => void
  log: (text: string, level?: "info" | "warn" | "error") => void
  finish: (status: "done" | "failed", text?: string) => void
}

export function start(pluginID: string, action: string, title: string, total = 0): Handle {
  const run: Run = {
    pluginID,
    action,
    title,
    done: 0,
    total,
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
    lines: [],
  }
  store().set(keyOf(pluginID, action), run)

  const push = (text: string, level: "info" | "warn" | "error") => {
    run.lines.push({ at: Date.now(), text, level })
    if (run.lines.length > MAX_LINES) run.lines.splice(0, run.lines.length - MAX_LINES)
  }

  return {
    step(done, total, title) {
      run.done = done
      run.total = total
      if (title) run.title = title
    },
    log(text, level = "info") {
      push(text, level)
    },
    finish(status, text) {
      run.status = status
      run.endedAt = Date.now()
      if (status === "done") run.done = run.total
      if (text) push(text, status === "failed" ? "error" : "info")
    },
  }
}

/** Every run belonging to one plugin, for the dashboard snapshot. */
export function forPlugin(pluginID: string): Run[] {
  return [...store().values()].filter((run) => run.pluginID === pluginID)
}

/**
 * Forget a finished run.
 *
 * Used by the dashboard's dismiss control: once the reader has seen how a run
 * ended, the panel should be able to go away without waiting for another run
 * to replace it.
 */
export function clear(pluginID: string, action: string): void {
  const run = store().get(keyOf(pluginID, action))
  if (run && run.status !== "running") store().delete(keyOf(pluginID, action))
}

/** Whether this action is already running, so a second click cannot start it. */
export function running(pluginID: string, action: string): boolean {
  return store().get(keyOf(pluginID, action))?.status === "running"
}
