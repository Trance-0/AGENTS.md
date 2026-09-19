/**
 * task-queue — durable, importance-ordered queue of deferred continuations,
 * and the scheduler that keeps a bounded number of them running.
 *
 * Ports the dsh `task-runner` + `cliproxy-quota` pair. Tasks bind a prompt to
 * an opencode session; the scheduler resumes them through the SDK, which
 * replaces the Codex version's `codex exec resume` subprocess and its external
 * watcher daemon.
 *
 * Three things beyond a plain queue:
 *
 *   - **Concurrency.** Every session opencode creates is wrapped into a task,
 *     so the queue knows what is running. Past `maxConcurrent` (3 by default)
 *     new work waits as `pending` and starts when a slot frees.
 *   - **Automatic retry.** opencode runs the model with `maxRetries: 0` and
 *     offers no setting to change that, so a dropped TLS socket ("TypeError:
 *     terminated") ends the turn outright. Those are re-queued with backoff; a
 *     rate-limit refusal waits for the model's own reset time instead.
 *   - **Restart resume.** A task marked running belongs to a process that no
 *     longer exists, so on startup those go back on the queue and are resumed.
 *     Restarting opencode mid-turn is routine while developing a plugin.
 *
 * Anything that ends other than by completing falls back to the queue, so no
 * work is silently dropped.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import * as Tasks from "../lib/tasks.ts"
import * as Registry from "../lib/registry.ts"
import * as Logs from "../lib/logs.ts"
import * as Retry from "../lib/retry.ts"
import * as RetryConfig from "../lib/retry-config.ts"
import * as Runner from "../lib/task-runner.ts"
import * as Summarize from "../lib/summarize.ts"
import { checkQuota } from "../lib/cpa.ts"
import { STATE } from "../lib/paths.ts"

/** Card accent per task status, for the queue panel. */
const TASK_TONE = { pending: "warn", running: "ok", done: "muted", failed: "error" } as const

/** "4m 10s" — a countdown is easier to read than an absolute timestamp. */
function formatIn(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

/** "1h 12m" — how long a session has been active. */
function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** "1.5M", "118k" — token counts run large enough that full digits hurt. */
function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** Cost in USD, or null when the provider reports none. */
function formatCost(cost: number): string | null {
  if (!cost) return null
  return cost < 0.01 ? `<$0.01` : `$${cost.toFixed(2)}`
}

/** Default continuation sent when a turn is resumed after an interruption. */
const RESUME_PROMPT = Runner.RESUME_PROMPT

export const TaskQueue: Plugin = async ({ client, project, directory }) => {
  await Registry.init()

  /**
   * Models offered for summarising, newest listing each time the panel opens.
   *
   * "none" is always first so the parser-only default is one click away, and
   * the configured model is always present even if the provider is currently
   * unreachable — a dropdown that silently drops the saved value would look
   * like the setting had been lost.
   */
  async function summaryModelOptions(current: string) {
    const options = [{ value: Summarize.NO_MODEL, label: "none — use the built-in parser" }]
    const seen = new Set<string>()

    try {
      const response = await client.config.providers()
      for (const provider of (response.data?.providers ?? []) as any[]) {
        for (const model of Object.values(provider?.models ?? {}) as any[]) {
          const id = `${provider.id}/${model.id}`
          if (seen.has(id)) continue
          seen.add(id)
          options.push({ value: id, label: `${provider.name ?? provider.id} · ${model.name ?? model.id}` })
        }
      }
    } catch {
      // Fall through to whatever is configured.
    }

    if (current && !seen.has(current)) options.push({ value: current, label: `${current} (not currently available)` })
    return options
  }

  const log = (message: string, level: Logs.Level = "info") => {
    Logs.log("task-queue", message, level)
    client.app.log({ body: { service: "task-queue", level, message } }).catch(() => {})
  }

  /**
   * Queue a retry for a session whose turn died mid-flight.
   *
   * Returns a short reason when it declines, so the caller can log why nothing
   * was queued rather than failing silently.
   */
  async function queueRetry(sessionID: string, error: unknown): Promise<string> {
    const config = await RetryConfig.load()
    if (!config.enabled) return "retry disabled"
    if (!Registry.isEnabled("task-queue")) return "task-queue disabled"

    const kind = Retry.classify(error)
    if (kind === "permanent") return `not retryable (${kind})`
    if (kind === "unknown") return "not retryable (unknown error)"

    // Count existing auto-retries for this session so a persistently failing
    // endpoint cannot queue an unbounded chain of attempts.
    const existing = (await Tasks.listTasks()).filter(
      (task) => task.sessionID === sessionID && task.origin === "auto-retry",
    )
    const active = existing.find((task) => task.status === "pending" || task.status === "running")
    if (active) return "retry already queued"

    const attempts = existing.reduce((max, task) => Math.max(max, task.attempts ?? 0), 0)
    if (attempts >= config.maxAttempts) return `attempt limit reached (${config.maxAttempts})`

    // A quota failure is retryable, but only once the budget returns; waiting
    // is the point, so it is queued with backoff rather than skipped.
    if (config.requireQuota && kind !== "quota") {
      const quota = await checkQuota()
      if (quota.available === false) return "quota exhausted"
    }

    // Quota comes back at a time the provider already knows, so wait for that
    // rather than guessing with a backoff curve.
    const delay =
      kind === "quota" ? await Runner.rateLimitDelay(config, null) : Retry.delayFor(attempts + 1, config)

    await Tasks.createTask({
      sessionID,
      prompt: RESUME_PROMPT,
      title: `auto-retry: ${Retry.describe(error).slice(0, 48)}`,
      // Retries outrank normal queued work: the session is mid-task.
      importance: 4,
      origin: "auto-retry",
      attempts: attempts + 1,
      nextAttemptAt: new Date(Date.now() + delay).toISOString(),
    })
    void Runner.kick()

    return `queued retry ${attempts + 1}/${config.maxAttempts} in ${Math.round(delay / 1000)}s`
  }

  Registry.register({
    id: "task-queue",
    title: "Task Queue",
    description:
      "Durable queue of prompts to replay into existing sessions, and automatic retry of turns " +
      "interrupted by connection failures.",
    async settings() {
      const config = await RetryConfig.load()
      return [
        {
          key: "retry.maxConcurrent",
          label: "Max concurrent",
          type: "number",
          value: config.maxConcurrent,
          min: 1,
          max: 32,
          description: "Sessions allowed to run at once. Extra work waits in the queue.",
        },
        {
          key: "retry.autoWrapSessions",
          label: "Track new sessions",
          type: "boolean",
          value: config.autoWrapSessions,
          description: "Wrap every new session into a task so it counts against the limit.",
        },
        {
          key: "retry.resumeOnRestart",
          label: "Resume on restart",
          type: "boolean",
          value: config.resumeOnRestart,
          description: "Re-queue sessions that were still running when opencode last exited.",
        },
        {
          key: "retry.rateLimitMode",
          label: "Rate-limit wait",
          type: "select",
          value: config.rateLimitMode,
          options: [
            { value: "reset", label: "reset — wait for the model's own reset time" },
            { value: "interval", label: "interval — always wait the fixed delay" },
          ],
          description: "Reset times are read from cpa-usage; the interval is the fallback.",
        },
        {
          key: "retry.retryIntervalSeconds",
          label: "Retry interval (s)",
          type: "number",
          value: config.retryIntervalSeconds,
          min: 10,
          max: 86400,
          description: "Wait after a rate-limit refusal when no reset time is known.",
        },
        {
          key: "retry.summaryModel",
          label: "Summary model",
          type: "select",
          value: config.summaryModel,
          options: await summaryModelOptions(config.summaryModel),
          description:
            "Model used to title and summarise tasks. Leave as 'none' to use the built-in parser; " +
            "any model failure falls back to it anyway.",
        },
        {
          key: "retry.enabled",
          label: "Auto-retry",
          type: "boolean",
          value: config.enabled,
          description: "Queue a retry when a turn dies from a connection failure.",
        },
        {
          key: "retry.requireQuota",
          label: "Require quota",
          type: "boolean",
          value: config.requireQuota,
          description: "Skip the retry when the CPA quota probe reports exhausted.",
        },
        {
          key: "retry.maxAttempts",
          label: "Max attempts",
          type: "number",
          value: config.maxAttempts,
          min: 0,
          max: 50,
          description: "Automatic attempts per session after the original failure.",
        },
        {
          key: "retry.baseDelayMs",
          label: "Base delay (ms)",
          type: "number",
          value: config.baseDelayMs,
          min: 1000,
          max: 600000,
          description: "First backoff step; doubles on each attempt.",
        },
        {
          key: "retry.maxDelayMs",
          label: "Max delay (ms)",
          type: "number",
          value: config.maxDelayMs,
          min: 1000,
          max: 3600000,
          description: "Ceiling for a single backoff step.",
        },
      ]
    },
    async update(key, value) {
      if (!key.startsWith("retry.")) throw new Error(`unknown setting: ${key}`)
      const field = key.slice(6) as keyof RetryConfig.RetryConfig
      if (!(field in RetryConfig.DEFAULTS)) throw new Error(`unknown setting: ${key}`)

      if (field === "enabled" || field === "requireQuota" || field === "autoWrapSessions" || field === "resumeOnRestart") {
        await RetryConfig.save({ [field]: value === true })
        return
      }
      if (field === "rateLimitMode") {
        if (value !== "reset" && value !== "interval") throw new Error("rateLimitMode must be reset or interval")
        await RetryConfig.save({ rateLimitMode: value })
        return
      }
      if (field === "summaryModel") {
        const model = String(value ?? "").trim()
        // "" is the documented way to turn summarising off.
        if (model && !model.includes("/")) throw new Error("summaryModel must be 'providerID/modelID' or empty")
        await RetryConfig.save({ summaryModel: model })
        return
      }
      const n = Number(value)
      if (!Number.isFinite(n)) throw new Error(`${key} must be a number`)
      await RetryConfig.save({ [field]: n })

      // A wider limit may let queued work start at once.
      if (field === "maxConcurrent") void Runner.kick()
    },
    async status() {
      const config = await RetryConfig.load()
      const count = await Tasks.counts()
      const wake = await Tasks.nextWakeAt()
      const next = await Tasks.pickNext()

      // Totals across everything still live, so the cost of the work in flight
      // is visible without opening the panel.
      const live = (await Tasks.listTasks()).filter((task) => !Tasks.TERMINAL.includes(task.status))
      const tokens = live.reduce((sum, task) => sum + (task.stats?.tokens ?? 0), 0)
      const cost = live.reduce((sum, task) => sum + (task.stats?.cost ?? 0), 0)
      const totals = { tokens, costLabel: formatCost(cost) }

      return [
        {
          label: "active",
          value: `${count.running}/${config.maxConcurrent}`,
          tone: count.running >= config.maxConcurrent ? "warn" : count.running > 0 ? "ok" : "muted",
        },
        { label: "queued", value: count.ready, tone: count.ready > 0 ? "warn" : "muted" },
        { label: "waiting", value: count.waiting, tone: count.waiting > 0 ? "warn" : "muted" },
        { label: "done", value: count.done, tone: "muted" },
        { label: "failed", value: count.failed, tone: count.failed > 0 ? "error" : "muted" },
        {
          label: "next run",
          value: wake === null ? (next ? "now" : "—") : new Date(wake).toLocaleTimeString(),
          tone: "muted",
        },
        { label: "scheduler", value: Runner.isRunning() ? "on" : "off", tone: Runner.isRunning() ? "ok" : "warn" },
        ...(totals.tokens > 0 ? [{ label: "tokens", value: formatTokens(totals.tokens), tone: "muted" as const }] : []),
        ...(totals.costLabel ? [{ label: "cost", value: totals.costLabel, tone: "muted" as const }] : []),
      ]
    },
    async panels() {
      // The dashboard polls this, which doubles as the reconcile loop's heartbeat
      // while the panel is open: what is rendered is what opencode just reported,
      // not what the last event happened to leave behind.
      await Runner.reconcile().catch(() => {})

      const tasks = await Tasks.listTasks()
      const config = await RetryConfig.load()
      const now = Date.now()

      return [
        {
          key: "queue",
          title: "Queue",
          description:
            `Up to ${config.maxConcurrent} run at once; the rest wait here, ordered by importance then age. ` +
            "Finished tasks are hidden until you select them.",
          // "active" and "waiting" are derived rather than stored, so they are
          // listed alongside the real statuses instead of replacing them.
          filters: ["active", "waiting", ...Tasks.STATUSES],
          defaultFilter: "active",
          empty: "Nothing running or queued.",
          action: "run",
          items: tasks.map((task) => {
            const at = task.nextAttemptAt ? Date.parse(task.nextAttemptAt) : null
            const waiting = at !== null && Number.isFinite(at) && at > now
            // The chips people actually want are "what is live" and "what is
            // owed to me later", so pending splits across those two.
            const group = task.status === "running" ? "active" : waiting ? "waiting" : task.status

            const stats = task.stats
            const cost = stats ? formatCost(stats.cost) : null

            return {
              title: task.title,
              // The summary says what the work is; the path says where. Both
              // beat an opaque session id, which is kept only as a fallback.
              subtitle: task.summary ?? task.directory ?? task.sessionID,
              group,
              tone: TASK_TONE[task.status],
              fields: [
                { label: "status", value: waiting ? "waiting" : task.status, tone: TASK_TONE[task.status] },
                ...(stats && stats.durationMs > 0 ? [{ label: "active", value: formatDuration(stats.durationMs) }] : []),
                ...(stats && stats.tokens > 0 ? [{ label: "tokens", value: formatTokens(stats.tokens) }] : []),
                ...(stats && stats.tokensCacheRead > 0
                  ? [{ label: "cached", value: formatTokens(stats.tokensCacheRead) }]
                  : []),
                ...(cost ? [{ label: "cost", value: cost }] : []),
                ...(stats && stats.messages > 0 ? [{ label: "messages", value: String(stats.messages) }] : []),
                { label: "importance", value: String(task.importance) },
                ...(task.attempts > 0 ? [{ label: "attempt", value: String(task.attempts), tone: "warn" as const }] : []),
                ...(waiting
                  ? [{ label: "runs in", value: formatIn(at! - now), tone: "warn" as const }]
                  : []),
                ...(task.outcome && task.outcome !== "completed"
                  ? [{ label: "last", value: task.outcome, tone: task.outcome === "rate-limit" ? "warn" as const : "error" as const }]
                  : []),
                ...(task.origin !== "manual" ? [{ label: "origin", value: task.origin }] : []),
                ...(task.model ? [{ label: "model", value: task.model }] : []),
                ...(task.error ? [{ label: "error", value: task.error.slice(0, 120), tone: "error" as const }] : []),
              ],
            }
          }),
        },
      ]
    },
    actions: {
      run: {
        label: "Fill free slots",
        async run() {
          if (!Registry.isEnabled("task-queue")) return "task-queue is disabled"
          const config = await RetryConfig.load()
          const count = await Tasks.counts()
          if (count.running >= config.maxConcurrent) {
            return `all ${config.maxConcurrent} slots busy`
          }
          if (count.ready === 0) return "没有待办任务"

          const { started } = await Runner.tick()
          return started > 0 ? `started ${started} task(s)` : "nothing could be started"
        },
      },
      sync: {
        label: "Sync with opencode",
        async run() {
          const { adopted, completed, dropped } = await Runner.reconcile()
          if (adopted + completed + dropped === 0) return "already in sync"
          return `adopted ${adopted}, completed ${completed}, dropped ${dropped}`
        },
      },
      clear: {
        label: "Clear finished",
        async run() {
          const removed = await Tasks.clearTerminal()
          return removed === 0 ? "nothing to clear" : `cleared ${removed} finished task(s)`
        },
      },
    },
  })

  // One scheduler per process, not per project directory. Starting it also
  // re-queues whatever was still running when opencode last exited.
  const scheduler = await Runner.start(client as any, log).catch(() => ({ hosted: false, resumed: [] }))
  if (scheduler.hosted) {
    log(`scheduler started (max ${(await RetryConfig.load()).maxConcurrent} concurrent)`)
    for (const task of scheduler.resumed) log(`re-queued interrupted session ${task.sessionID}`)
  }

  return {
    event: async ({ event }) => {
      if (!Registry.isEnabled("task-queue")) return
      const properties = (event as any).properties ?? {}

      /**
       * Wrap each new session so it occupies a slot.
       *
       * A session the user starts by hand is work in flight exactly like a
       * queued task, so it has to be counted; otherwise the limit would only
       * constrain the queue while the editor ran unbounded alongside it.
       */
      if (event.type === "session.created") {
        const config = await RetryConfig.load()
        if (!config.autoWrapSessions) return

        const info = properties.info ?? {}
        if (typeof info.id !== "string" || !info.id) return
        // Child sessions are subagents driven by their parent's turn; they do
        // not get their own slot.
        if (info.parentID) return
        // The queue's own scratch sessions must never be wrapped: wrapping one
        // queues a task, whose summary opens another scratch session, which
        // wraps again — an unbounded loop that floods the queue.
        if (info.title === Summarize.SCRATCH_TITLE) return

        const { task, created } = await Tasks.wrapSession({
          sessionID: info.id,
          title: info.title || undefined,
          projectID: info.projectID ?? project?.id ?? null,
          directory: info.directory ?? directory ?? null,
          origin: "session",
          // It is being driven by the user right now, so it holds a slot.
          status: "running",
        })
        if (created) log(`tracking session ${task.sessionID} (${task.title})`)
        return
      }

      /** A finished turn releases the slot and lets the queue advance. */
      if (event.type === "session.idle") {
        const sessionID = properties.sessionID
        if (typeof sessionID !== "string") return

        const task = await Tasks.findBySession(sessionID)
        if (task?.status === "running") {
          await Runner.complete(task.id)
          log(`session ${sessionID} idle → ${task.title} done`)
        }
        void Runner.kick()
        return
      }

      /**
       * A failed turn goes back to the queue rather than dying.
       *
       * The payload carries the error that ended the stream, which is what
       * `Retry.classify` inspects to tell a dropped socket from a refusal and
       * a rate-limit refusal from both.
       */
      if (event.type === "session.error") {
        const sessionID = properties.sessionID
        if (typeof sessionID !== "string" || !sessionID) return

        const error = properties.error
        // The payload nests the human-readable text a level down for most kinds.
        const detail = error?.data?.message ?? error?.message ?? error?.name ?? error

        // A tracked session is already a task: reschedule it in place instead
        // of queuing a second entry for the same work.
        const task = await Tasks.findBySession(sessionID)
        if (task?.status === "running") {
          const updated = await Runner.finish(task.id, detail)
          log(
            `session.error on ${sessionID}: ${Retry.describe(detail).slice(0, 80)} → ${updated?.status ?? "unchanged"}`,
            "warn",
          )
          return
        }

        const outcome = await queueRetry(sessionID, detail).catch(
          (failure) => `retry check failed: ${Retry.describe(failure)}`,
        )
        log(`session.error on ${sessionID}: ${Retry.describe(detail).slice(0, 80)} → ${outcome}`)
      }
    },

    tool: {
      task_create: tool({
        description:
          "Queue a prompt to be delivered to an existing opencode session later. Use this to park work that is " +
          "blocked on quota. `sessionID` is an opencode session id (ses_...); `importance` is 1–5 and higher runs first.",
        args: {
          sessionID: tool.schema.string().describe("opencode session id to continue (ses_...)."),
          prompt: tool.schema.string().describe("The message to send when the task runs."),
          title: tool.schema.string().optional().describe("Short label (defaults to the start of the prompt)."),
          importance: tool.schema.number().int().min(1).max(5).optional().describe("1–5, default 3."),
          model: tool.schema.string().optional().describe("Optional model override as 'providerID/modelID'."),
          agent: tool.schema.string().optional().describe("Optional agent override."),
        },
        async execute(args) {
          const task = await Tasks.createTask(args)
          return { title: `queued: ${task.title}`, output: JSON.stringify(task, null, 2) }
        },
      }),

      task_list: tool({
        description:
          "List tasks ordered by importance (descending), then by oldest update. 'active' is what holds a " +
          "concurrency slot right now and 'waiting' is pending work whose retry delay has not elapsed; by " +
          "default finished tasks are omitted.",
        args: {
          status: tool.schema
            .enum(["active", "waiting", "pending", "running", "done", "failed", "all"])
            .optional()
            .describe("Filter by status. Defaults to everything except done/failed."),
        },
        async execute(args) {
          const all = await Tasks.listTasks()
          const count = await Tasks.counts()
          const now = Date.now()
          const isWaiting = (task: Tasks.Task) =>
            task.status === "pending" && !!task.nextAttemptAt && Date.parse(task.nextAttemptAt) > now

          const filter = args.status ?? "unfinished"
          const tasks = all.filter((task) => {
            if (filter === "all") return true
            if (filter === "unfinished") return !Tasks.TERMINAL.includes(task.status)
            if (filter === "active") return task.status === "running"
            if (filter === "waiting") return isWaiting(task)
            return task.status === filter
          })

          return {
            title: `${tasks.length} tasks (${count.running} active, ${count.ready} queued, ${count.waiting} waiting)`,
            output: JSON.stringify({ storePath: STATE.taskQueue, counts: count, tasks }, null, 2),
          }
        },
      }),

      task_update: tool({
        description:
          "Transition a task to pending, running, done, or failed, or delete it outright. Moving a task to " +
          "pending also clears its retry delay, so it becomes due immediately.",
        args: {
          id: tool.schema.string().describe("Task id."),
          status: tool.schema.enum(["pending", "running", "done", "failed", "deleted"]).describe("New status."),
        },
        async execute(args) {
          if (args.status === "deleted") {
            const deleted = await Tasks.deleteTask(args.id)
            if (!deleted) throw new Error(`Unknown task: ${args.id}`)
            void Runner.kick()
            return { title: "deleted", output: JSON.stringify({ id: args.id, deleted: true }, null, 2) }
          }

          // Re-queuing by hand means "run this now", not "keep waiting out the
          // backoff that was set when it failed".
          const task =
            args.status === "pending"
              ? await Tasks.update(args.id, { status: "pending", nextAttemptAt: null, error: null })
              : await Tasks.setStatus(args.id, args.status)

          if (!task) throw new Error(`Unknown task: ${args.id}`)
          void Runner.kick()
          return { title: `${task.title} → ${task.status}`, output: JSON.stringify(task, null, 2) }
        },
      }),

      task_run: tool({
        description:
          "Start as many due tasks as there are free concurrency slots, by sending each prompt to its session. " +
          "Checks CPA quota first and refuses to start when the quota is known to be exhausted, unless `force` " +
          "is set. A task that fails to start is rescheduled rather than lost.",
        args: {
          force: tool.schema.boolean().optional().describe("Run even when the quota probe reports exhausted."),
        },
        async execute(args) {
          const quota = await checkQuota()
          if (quota.available === false && args.force !== true) {
            return {
              title: "quota exhausted, not started",
              output: JSON.stringify({ started: false, reason: "quota", quota }, null, 2),
            }
          }

          const config = await RetryConfig.load()
          const before = await Tasks.counts()
          if (before.ready === 0) {
            return { title: "没有待办任务", output: JSON.stringify({ started: 0, reason: "empty", counts: before }, null, 2) }
          }
          if (before.running >= config.maxConcurrent) {
            return {
              title: `all ${config.maxConcurrent} slots busy`,
              output: JSON.stringify({ started: 0, reason: "saturated", counts: before }, null, 2),
            }
          }

          // The scheduler owns dispatch, so a task that fails to start is
          // rescheduled by the same rules that apply to a failed turn.
          const { started } = await Runner.tick()
          const after = await Tasks.counts()
          return {
            title: started > 0 ? `started ${started} task(s)` : "nothing could be started",
            output: JSON.stringify({ started, counts: after, maxConcurrent: config.maxConcurrent, quota }, null, 2),
          }
        },
      }),

      task_resume: tool({
        description:
          "Re-queue sessions that were still running when opencode last exited, so work interrupted by a restart " +
          "continues. This runs automatically at startup; call it to force a sweep.",
        args: {},
        async execute() {
          const resumed = await Tasks.recoverInterrupted(RESUME_PROMPT)
          if (resumed.length === 0) {
            return { title: "nothing to resume", output: JSON.stringify({ resumed: [] }, null, 2) }
          }
          void Runner.kick()
          return {
            title: `re-queued ${resumed.length} interrupted session(s)`,
            output: JSON.stringify(
              { resumed: resumed.map((t) => ({ id: t.id, title: t.title, sessionID: t.sessionID })) },
              null,
              2,
            ),
          }
        },
      }),

      task_sync: tool({
        description:
          "Reconcile the queue against the sessions opencode actually reports: adopt busy sessions that are not " +
          "tracked yet, complete tracked tasks whose session has gone idle, and drop tasks whose session was " +
          "deleted. Runs automatically, but call it to force a pass.",
        args: {},
        async execute() {
          const result = await Runner.reconcile()
          const counts = await Tasks.counts()
          return {
            title:
              result.adopted + result.completed + result.dropped === 0
                ? "already in sync"
                : `adopted ${result.adopted}, completed ${result.completed}, dropped ${result.dropped}`,
            output: JSON.stringify({ ...result, counts }, null, 2),
          }
        },
      }),

      task_retry: tool({
        description:
          "Queue a retry for a session whose turn was interrupted by a connection failure. This is what the " +
          "automatic session.error handler does; call it manually to recover a turn that was lost earlier.",
        args: {
          sessionID: tool.schema.string().describe("opencode session id to resume (ses_...)."),
          reason: tool.schema
            .string()
            .optional()
            .describe("The error text, used to decide whether the failure is retryable. Defaults to 'terminated'."),
          force: tool.schema.boolean().optional().describe("Queue even when the error looks non-retryable."),
        },
        async execute(args) {
          const reason = args.reason ?? "terminated"

          if (args.force) {
            const config = await RetryConfig.load()
            const task = await Tasks.createTask({
              sessionID: args.sessionID,
              prompt: RESUME_PROMPT,
              title: `manual retry: ${reason.slice(0, 48)}`,
              importance: 4,
              origin: "auto-retry",
              attempts: 1,
              nextAttemptAt: new Date(Date.now() + Retry.delayFor(1, config)).toISOString(),
            })
            return { title: `queued: ${task.title}`, output: JSON.stringify(task, null, 2) }
          }

          const outcome = await queueRetry(args.sessionID, reason)
          return {
            title: outcome,
            output: JSON.stringify(
              { sessionID: args.sessionID, reason, classification: Retry.classify(reason), outcome },
              null,
              2,
            ),
          }
        },
      }),
    },
  }
}
