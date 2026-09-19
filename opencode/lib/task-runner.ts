/**
 * Task scheduler — keeps at most `maxConcurrent` tasks running.
 *
 * Replaces the Codex watcher daemon (`task-queue/scripts/watcher.mjs`). That
 * was an external process polling for the quota reset edge; this runs inside
 * opencode, because opencode already publishes the events the scheduler needs.
 * A session going idle frees its slot at once rather than at the next poll, so
 * the timer only exists for work scheduled into the future — a rate-limit
 * backoff — and as a backstop for events that never arrive.
 *
 * The invariant: a task that stops for any reason other than completion goes
 * back to `pending` with a `nextAttemptAt`, so nothing is silently dropped. A
 * rate-limited run waits for the model's own reset, a broken socket waits out
 * the exponential backoff, and a run interrupted by opencode exiting becomes
 * due immediately on the next start.
 *
 * Exactly one scheduler runs per process: opencode instantiates a plugin once
 * per project directory, so the loop lives on `globalThis` and instances after
 * the first attach to it rather than starting a competing one.
 */

import * as Tasks from "./tasks.ts"
import * as CPA from "./cpa.ts"
import * as RetryConfig from "./retry-config.ts"
import * as Retry from "./retry.ts"
import * as Sessions from "./session-store.ts"
import * as Summarize from "./summarize.ts"

type SessionInfo = {
  id: string
  title?: string
  directory?: string
  projectID?: string
  parentID?: string
}

type Client = {
  session: {
    promptAsync(options: {
      path: { id: string }
      body: any
      query?: { directory?: string }
    }): Promise<{ error?: unknown; data?: unknown }>
    /** Live busy/idle state, keyed by session id. */
    status(options?: { query?: { directory?: string } }): Promise<{ error?: unknown; data?: unknown }>
    list(options?: { query?: { directory?: string } }): Promise<{ error?: unknown; data?: unknown }>
  }
}

type Scheduler = {
  client: Client
  log: (message: string, level?: "info" | "warn" | "error") => void
  timer: ReturnType<typeof setTimeout> | null
  ticking: boolean
  /** Cached model → reset time, so a burst of failures makes one probe. */
  resets: { at: number; byModel: Map<string, number> } | null
}

const KEY = Symbol.for("@dsh/opencode-task-scheduler")

function scheduler(): Scheduler | null {
  return ((globalThis as Record<symbol, unknown>)[KEY] as Scheduler | undefined) ?? null
}

export function isRunning(): boolean {
  return scheduler() !== null
}

/** Sent to a session that was interrupted rather than asked something. */
export const RESUME_PROMPT =
  "The previous turn was interrupted before it completed. Continue from where you left off; " +
  "do not repeat work that already succeeded."

/* ------------------------------------------------------------------ *
 * Backoff
 * ------------------------------------------------------------------ */

/**
 * When a rate-limited task should next be attempted.
 *
 * In `reset` mode the model's own reset time comes from the cpa-usage
 * management API: the provider knows exactly when the window refills, so
 * retrying before then only burns requests, and retrying much later wastes the
 * budget. The configured interval is the fallback for a model CPA does not
 * report, and the whole policy in `interval` mode.
 */
export async function rateLimitDelay(config: RetryConfig.RetryConfig, model: string | null, now = Date.now()): Promise<number> {
  const interval = config.retryIntervalSeconds * 1000
  if (config.rateLimitMode !== "reset" || !model) return interval

  const resetsAt = await modelReset(model, now).catch(() => null)
  // A reset already in the past means the window has refilled: retry promptly
  // instead of waiting out a full interval.
  return resetsAt !== null && resetsAt > now ? resetsAt - now : interval
}

/** Reset time for a model id, cached for a minute across a burst of failures. */
async function modelReset(model: string, now: number): Promise<number | null> {
  const active = scheduler()
  const cache = active?.resets
  if (cache && now - cache.at <= 60_000) return lookup(cache.byModel, model)

  const byModel = await readResets()
  if (active) active.resets = { at: now, byModel }
  return lookup(byModel, model)
}

/** Match `providerID/modelID` and bare ids against the CPA model list. */
function lookup(byModel: Map<string, number>, model: string): number | null {
  const id = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model
  const exact = byModel.get(id)
  if (exact !== undefined) return exact
  for (const [key, value] of byModel) {
    if (key.includes(id) || id.includes(key)) return value
  }
  return null
}

async function readResets(): Promise<Map<string, number>> {
  const config = await CPA.resolveConfig()
  const byModel = new Map<string, number>()
  if (!config.managementKey) return byModel

  for (const usage of await CPA.modelUsage(config)) {
    const windows = [usage.fiveHour, usage.weekly].filter((w): w is CPA.Window => !!w && w.resetsAt !== null)
    if (windows.length === 0) continue
    // The exhausted window is the one worth waiting for, so prefer whichever
    // has less left.
    const worst = windows.reduce((a, b) => ((a.remainingPercent ?? 100) <= (b.remainingPercent ?? 100) ? a : b))
    if (worst.resetsAt !== null) byModel.set(usage.model, worst.resetsAt)
  }
  return byModel
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

async function send(client: Client, task: Tasks.Task): Promise<void> {
  const body: Record<string, unknown> = { parts: [{ type: "text", text: task.prompt }] }
  if (task.agent) body.agent = task.agent
  if (task.model) {
    const [providerID, ...rest] = task.model.split("/")
    if (rest.length > 0) body.model = { providerID, modelID: rest.join("/") }
  }

  const response = await client.session.promptAsync({
    path: { id: task.sessionID },
    body,
    // A task may belong to any project on this device; without the directory
    // the server resolves the session against the wrong one.
    ...(task.directory ? { query: { directory: task.directory } } : {}),
  })
  if (response.error) {
    throw new Error(typeof response.error === "string" ? response.error : JSON.stringify(response.error))
  }
}

/**
 * Record how a run ended and decide what happens next.
 *
 * Completion is the only terminal success. A retryable failure goes back to
 * `pending` with the appropriate wait; anything else, or a task that has
 * exhausted its attempts, is marked failed so it stops consuming slots.
 */
export async function finish(id: string, error?: unknown): Promise<Tasks.Task | null> {
  const task = await Tasks.getTask(id)
  if (!task || task.status !== "running") return task

  if (!error) {
    const done = await Tasks.update(id, { status: "done", outcome: "completed", error: null, nextAttemptAt: null })
    // The slot this task held is now free; let the queue advance into it.
    void kick()
    return done
  }

  const config = await RetryConfig.load()
  const kind = Retry.classify(error)
  const message = Retry.describe(error)
  const outcome: Tasks.Outcome = kind === "quota" ? "rate-limit" : "error"

  if (!config.enabled || !Retry.canRetry(task.attempts, error, config)) {
    scheduler()?.log(`task ${id} failed (${kind}): ${message.slice(0, 120)}`, "error")
    return Tasks.update(id, { status: "failed", outcome, error: message })
  }

  // Quota is a wait for a known moment; transport is a wait for the network to
  // settle, which is what the exponential backoff is for.
  const delay =
    kind === "quota" ? await rateLimitDelay(config, task.model) : Retry.delayFor(task.attempts + 1, config)

  const updated = await Tasks.scheduleRetry(id, delay, message)
  await Tasks.update(id, { outcome })
  scheduler()?.log(`task ${id} ${outcome}: retrying in ${Math.round(delay / 1000)}s — ${message.slice(0, 100)}`, "warn")

  // The slot this task held is now free.
  void kick()
  return updated
}

/** Mark a running task as completed, from a `session.idle` event. */
export function complete(id: string): Promise<Tasks.Task | null> {
  return finish(id)
}

/* ------------------------------------------------------------------ *
 * Reconciliation
 * ------------------------------------------------------------------ */

/**
 * Make the store agree with what opencode actually reports.
 *
 * Events alone are not a sound basis for tracking: a plugin only receives them
 * once it is loaded, so every session that already existed at startup is
 * invisible to it, and any event delivered while the process was down is lost
 * outright. That is why the queue looked empty while sessions were plainly
 * running, and why nothing was ever resumed after a restart — there was no
 * record to resume from.
 *
 * Two sources are consulted, because neither alone is sufficient:
 *
 *   - **The database** decides whether a session exists, and supplies its
 *     title and usage. The HTTP API is *directory-scoped* — a client answers
 *     only for the project it was created for — so asking this process's one
 *     client about a session in another project reports it as missing. That is
 *     what dropped a live 21-message session as "session no longer exists".
 *   - **`session.status()`** decides whether a session is busy, which is not
 *     persisted anywhere. It is asked per-directory, for the directories the
 *     tracked tasks actually live in.
 *
 * The store is then corrected to match: busy-but-untracked sessions are
 * adopted, tracked tasks whose session went idle are completed, and a task
 * whose session is genuinely absent from the database is dropped.
 *
 * Events still drive the fast path — this only repairs what they missed.
 */
export async function reconcile(): Promise<{ adopted: number; completed: number; dropped: number }> {
  const active = scheduler()
  const result = { adopted: 0, completed: 0, dropped: 0 }
  if (!active) return result

  const config = await RetryConfig.load()
  const tracked = await Tasks.listTasks()
  const live = tracked.filter((task) => !Tasks.TERMINAL.includes(task.status))

  // Ask about the directories the tracked work actually lives in, plus this
  // instance's own, since the status API answers per project.
  const directories = new Set<string | null>([null])
  for (const task of live) if (task.directory) directories.add(task.directory)

  const statuses = await sessionStatuses(active.client, [...directories])
  // A failed probe must not be read as "every session has gone idle".
  if (statuses === null) return result

  const byID = new Map(tracked.map((task) => [task.sessionID, task]))

  // Adopt sessions that are running without us knowing about them.
  if (config.autoWrapSessions) {
    for (const [sessionID, busy] of statuses) {
      if (!busy) continue
      const existing = byID.get(sessionID)
      if (existing && !Tasks.TERMINAL.includes(existing.status)) continue

      const info = Sessions.get(sessionID)
      // Subagents run inside their parent's turn and get no slot of their own.
      if (info?.parentID) continue
      // Never adopt the queue's own scratch summary sessions: doing so queues a
      // task whose summary opens another scratch session, looping unbounded.
      if (info?.title === Summarize.SCRATCH_TITLE) continue

      const { task, created } = await Tasks.wrapSession({
        sessionID,
        title: info?.title || undefined,
        projectID: info?.projectID ?? null,
        directory: info?.directory ?? null,
        origin: "session",
        status: "running",
      })
      if (created) {
        result.adopted += 1
        active.log(`adopted running session ${sessionID}`)
        void describe(task.id, sessionID, info?.directory ?? null)
      }
    }
  }

  // Existence is a database question, not a directory-scoped API one.
  const rows = Sessions.getMany(live.map((task) => task.sessionID))

  for (const task of live) {
    const row = rows?.get(task.sessionID)

    // Keep the queue's stats and naming current for everything still live.
    if (row) await refresh(task, row)

    if (task.status !== "running") continue
    // Only this process's tasks are ours to correct. A task owned by another
    // live instance is its business, and one owned by a dead process is left
    // to `recoverInterrupted`, which knows to resume rather than complete it.
    if (task.ownerPID !== process.pid) continue
    if (statuses.get(task.sessionID) === true) continue

    // A task dispatched moments ago may not have registered as busy yet;
    // completing it here would abandon the turn it just started.
    if (Date.now() - Date.parse(task.updatedAt) < 10_000) continue

    // `rows === null` means the database could not be read; that is not
    // evidence of deletion, so nothing is dropped on the strength of it.
    if (rows !== null && !row) {
      await Tasks.update(task.id, { status: "failed", outcome: "interrupted", error: "session no longer exists" })
      result.dropped += 1
      active.log(`dropped ${task.title}: session ${task.sessionID} no longer exists`, "warn")
      continue
    }

    await Tasks.update(task.id, { status: "done", outcome: "completed", error: null, nextAttemptAt: null })
    result.completed += 1
    active.log(`completed ${task.title} (session idle)`)
  }

  return result
}

/** Mirror the session's usage onto the task, and adopt a better title. */
async function refresh(task: Tasks.Task, row: Sessions.SessionRow): Promise<void> {
  const patch: Tasks.Patch = {
    stats: {
      durationMs: Math.max(0, row.updatedAt - row.createdAt),
      tokens: Sessions.totalTokens(row),
      tokensInput: row.tokens.input,
      tokensOutput: row.tokens.output,
      tokensCacheRead: row.tokens.cacheRead,
      cost: row.cost,
      messages: Sessions.messageCount(row.id),
      at: Date.now(),
    },
  }

  // opencode titles a session only after its first turn, so the real name
  // usually lands well after the task was created.
  if (row.title && Summarize.isPlaceholderTitle(task.title) && !Summarize.isPlaceholderTitle(row.title)) {
    patch.title = row.title
  }

  await Tasks.update(task.id, patch)

  // Fill in a missing summary once there is something to summarise.
  if (!task.summary) void describe(task.id, row.id, row.directory)
}

/** In-flight summaries, so a polling dashboard cannot stack them up. */
const DESCRIBING = new Set<string>()

/**
 * Give a task a readable title and one-line summary.
 *
 * Runs detached from the reconcile pass: it may call a model, and nothing about
 * scheduling should wait on that.
 */
async function describe(taskID: string, sessionID: string, directory: string | null): Promise<void> {
  const active = scheduler()
  if (!active || DESCRIBING.has(taskID)) return
  DESCRIBING.add(taskID)

  try {
    const prompts = Sessions.openingPrompts(sessionID)
    if (prompts.length === 0) return

    const config = await RetryConfig.load()
    const summary = await Summarize.summarize({
      client: active.client as any,
      model: config.summaryModel,
      directory,
      prompts,
    })

    const task = await Tasks.getTask(taskID)
    if (!task) return

    const patch: Tasks.Patch = { summary: summary.detail ?? summary.title, summarySource: summary.source }
    // Only rename a task that has nothing better already.
    if (Summarize.isPlaceholderTitle(task.title)) patch.title = summary.title
    await Tasks.update(taskID, patch)
  } catch {
    // A summary is a convenience; failing to produce one changes nothing.
  } finally {
    DESCRIBING.delete(taskID)
  }
}

/**
 * Session id → whether it is busy, across every given directory.
 *
 * The endpoint answers for one project at a time, so it is asked once per
 * directory and the answers are merged. Returns null only when *every* query
 * failed, since a partial answer is still worth acting on.
 */
async function sessionStatuses(client: Client, directories: Array<string | null>): Promise<Map<string, boolean> | null> {
  const map = new Map<string, boolean>()
  let answered = false

  for (const directory of directories) {
    try {
      const response = await client.session.status(directory ? { query: { directory } } : {})
      if (response.error || !response.data) continue
      answered = true

      for (const [sessionID, status] of Object.entries(response.data as Record<string, { type?: string }>)) {
        // `busy` and `retry` both mean a turn is in flight. A session seen busy
        // in any project is busy, so an earlier `true` is never overwritten.
        const type = String(status?.type ?? "")
        const busy = type === "busy" || type === "retry"
        if (busy || !map.has(sessionID)) map.set(sessionID, busy)
      }
    } catch {
      // Try the remaining directories.
    }
  }

  return answered ? map : null
}

/**
 * Fill every free slot with whatever is due.
 *
 * Claiming is atomic in the store, so concurrent ticks cannot overbook.
 */
export async function tick(): Promise<{ started: number }> {
  const active = scheduler()
  if (!active || active.ticking) return { started: 0 }
  active.ticking = true

  try {
    // Correct the store before deciding anything from it: a stale "running"
    // task would otherwise hold a slot that is actually free.
    await reconcile().catch(() => {})

    const config = await RetryConfig.load()
    const claimed = await Tasks.claimDue(config.maxConcurrent)

    for (const task of claimed) {
      try {
        await send(active.client, task)
        active.log(`started ${task.title} (${task.sessionID})`)
      } catch (error) {
        // The prompt was never accepted, so no idle event will arrive to free
        // this slot. Release it here.
        await finish(task.id, error)
      }
    }
    return { started: claimed.length }
  } finally {
    active.ticking = false
    await rearm().catch(() => {})
  }
}

/** Run a tick now, swallowing failures — safe to call from event handlers. */
export function kick(): Promise<void> {
  return tick().then(
    () => undefined,
    () => undefined,
  )
}

/**
 * Arm the timer for the next moment something could change.
 *
 * Work scheduled into the future wakes the loop exactly then; otherwise the
 * poll interval is a backstop for events that never arrived.
 */
async function rearm(): Promise<void> {
  const active = scheduler()
  if (!active) return
  if (active.timer) clearTimeout(active.timer)

  const config = await RetryConfig.load()
  const wake = await Tasks.nextWakeAt()
  const backstop = config.pollSeconds * 1000
  const delay = wake === null ? backstop : Math.max(1_000, Math.min(wake - Date.now(), backstop))

  const timer = setTimeout(() => void kick(), delay)
  // The scheduler must never be why opencode stays alive. `unref` is Node-only,
  // so it is called defensively rather than assumed.
  ;(timer as { unref?: () => void }).unref?.()
  active.timer = timer
}

/**
 * Start the single per-process scheduler, or attach to the running one.
 *
 * Returns whether this call started it, so only one instance logs about it.
 */
export async function start(
  client: Client,
  log: (message: string, level?: "info" | "warn" | "error") => void,
): Promise<{ hosted: boolean; resumed: Tasks.Task[] }> {
  const g = globalThis as Record<symbol, unknown>
  if (g[KEY]) return { hosted: false, resumed: [] }

  g[KEY] = { client, log, timer: null, ticking: false, resets: null } satisfies Scheduler

  const config = await RetryConfig.load()
  // Runs before the first reconcile: a task orphaned by the last shutdown must
  // be re-queued for resumption, not adopted as if it were still running.
  const resumed = config.resumeOnRestart ? await Tasks.recoverInterrupted(RESUME_PROMPT) : []
  if (resumed.length > 0) log(`resuming ${resumed.length} session(s) interrupted by the last shutdown`)

  await rearm()
  void kick()
  return { hosted: true, resumed }
}

export function stop(): void {
  const active = scheduler()
  if (!active) return
  if (active.timer) clearTimeout(active.timer)
  delete (globalThis as Record<symbol, unknown>)[KEY]
}
