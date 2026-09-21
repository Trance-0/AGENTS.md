/**
 * Durable, importance-ordered task store.
 *
 * Ports the dsh `task-runner` store, extended into the scheduler's state. A
 * task binds a continuation prompt to an opencode session, the project that
 * session belongs to, and the model route to resume under.
 *
 * Every session opencode creates is wrapped into a task, so this file is also
 * the record of what is *running right now*: a `running` task holds one of the
 * concurrency slots, a `pending` task is waiting for one. A task that stops for
 * any reason other than completion returns to `pending` with a
 * `nextAttemptAt`, which is how a rate-limited turn reschedules itself onto the
 * model's own reset time and how a session interrupted by opencode quitting is
 * picked back up on the next start.
 *
 * Writes go through a per-process mutex and a temp-file rename. The scheduler
 * read-modify-writes the whole file from several plugin instances at once, and
 * a lost update there would double-book a concurrency slot.
 */

import fsp from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { CONFIG_DIR, STATE } from "./paths.ts"

/** `running` holds a concurrency slot; `pending` is waiting for one. */
export type Status = "pending" | "running" | "done" | "failed"

export const STATUSES: Status[] = ["pending", "running", "done", "failed"]

/** Statuses that will never run again, hidden by the panel's default filter. */
export const TERMINAL: Status[] = ["done", "failed"]

/**
 * Prefix on the session id of a task that creates its session on first run.
 *
 * `task_create` accepts no session at all, and the dispatcher needs to tell
 * "make one" from "resume this one". A placeholder keeps the field a plain
 * string and stays unique, so two new-session tasks are never duplicates of
 * each other.
 */
export const NEW_SESSION_PREFIX = "new:"

export function isNewSession(sessionID: string): boolean {
  return sessionID.startsWith(NEW_SESSION_PREFIX)
}

/**
 * Where a task came from.
 *
 * `session` marks a task that wraps a session opencode created, which is what
 * lets the queue restart work that was in flight when the process died.
 */
export type Origin = "manual" | "auto-retry" | "session"

/** Why a run stopped, which decides whether and when it is retried. */
export type Outcome = "completed" | "error" | "rate-limit" | "aborted" | "interrupted"

/** What a session has cost so far, mirrored from opencode's session row. */
export type Stats = {
  /** Milliseconds between the session's first and last activity. */
  durationMs: number
  /** Context tokens: input + output + reasoning, excluding cache reads. */
  tokens: number
  tokensInput: number
  tokensOutput: number
  /** Cache reads are billed differently, so they are reported separately. */
  tokensCacheRead: number
  /** Reported in USD; zero when the provider does not price the model. */
  cost: number
  messages: number
  /** When these numbers were last refreshed. */
  at: number
}

export type Task = {
  id: string
  title: string
  /** One-line description of the work, when one could be derived. */
  summary: string | null
  /** How the title/summary were produced, so a parser result can be upgraded. */
  summarySource: "model" | "parser" | null
  /** 1–5; higher runs first. */
  importance: number
  /**
   * The session this task runs in, or a `new:` placeholder when it has not been
   * created yet.
   *
   * A task queued for a fresh session carries a unique placeholder rather than
   * a real id, so it can never be mistaken for another task's session — or,
   * before the first dispatch, for a duplicate of another new-session task.
   */
  sessionID: string
  /**
   * Auto-approve every permission request in this task's session.
   *
   * A scheduled run has nobody to answer a prompt, so a task flagged this way
   * replies "always" the moment a request arrives instead of stalling.
   */
  bypassPermissions: boolean
  /** opencode project id the session belongs to, for grouping in the panel. */
  projectID: string | null
  /** Directory the session runs in; also routes the prompt to the right server. */
  directory: string | null
  /**
   * The prompt to deliver when the task runs, or null for a wrapped session
   * that is already being driven and has nothing to replay yet.
   */
  prompt: string | null
  model: string | null
  agent: string | null
  status: Status
  origin: Origin
  /** How the last run ended; null before the first run. */
  outcome: Outcome | null
  /** ISO timestamp before which the task must not be dispatched. */
  nextAttemptAt: string | null
  /** How many times this task has been dispatched. */
  attempts: number
  /**
   * When the current run was dispatched, as an ISO timestamp.
   *
   * Distinct from `updatedAt`, which any bookkeeping write moves. The
   * reconciler needs to know how long ago the *turn* started so it can leave a
   * freshly dispatched task alone; refreshing its token stats every pass must
   * not look like a new dispatch and keep re-arming that grace period forever.
   */
  startedAt: string | null
  /**
   * PID of the opencode process driving this task while it is running.
   *
   * The store is shared by every opencode process on the device, so "still
   * marked running" alone cannot distinguish a task orphaned by a restart from
   * one another live instance is driving right now. Recovery only reclaims
   * tasks whose owner is gone.
   */
  ownerPID: number | null
  /** Usage mirrored from the session, for the queue's per-task stats. */
  stats: Stats | null
  createdAt: string
  updatedAt: string
  /** Set when a run finished badly. */
  error?: string
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

/**
 * Store a directory the way opencode does: forward slashes, no trailing one.
 *
 * A wrapped session gets its directory from the `session.created` event, which
 * on Windows carries a native path, while the session row and `session.status`
 * both use forward slashes. Left mixed, the scheduler asks the directory-scoped
 * status API about a path it has never heard of, and a queued resume is routed
 * against the wrong key. Normalising here keeps one spelling everywhere.
 */
function normalizeDirectory(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null
  return value.replace(/\\/g, "/").replace(/\/+$/, "")
}

/**
 * Normalise whatever is on disk into the current shape.
 *
 * Earlier versions wrote tasks without the scheduling fields, so those are
 * filled in on read rather than needing a separate migration step.
 */
function normalise(parsed: unknown): Task[] {
  if (!Array.isArray(parsed)) return []
  return parsed.map((entry: any): Task => {
    const now = new Date().toISOString()
    return {
      id: String(entry?.id ?? crypto.randomUUID()),
      title: String(entry?.title ?? "untitled"),
      summary: typeof entry?.summary === "string" && entry.summary ? entry.summary : null,
      summarySource: entry?.summarySource === "model" || entry?.summarySource === "parser" ? entry.summarySource : null,
      importance: clampInt(entry?.importance, 1, 5, 3),
      sessionID: String(entry?.sessionID ?? ""),
      bypassPermissions: entry?.bypassPermissions === true,
      projectID: entry?.projectID ?? null,
      directory: normalizeDirectory(entry?.directory),
      prompt: typeof entry?.prompt === "string" && entry.prompt ? entry.prompt : null,
      model: entry?.model ?? null,
      agent: entry?.agent ?? null,
      status: STATUSES.includes(entry?.status) ? entry.status : "pending",
      origin: entry?.origin === "auto-retry" || entry?.origin === "session" ? entry.origin : "manual",
      outcome: entry?.outcome ?? null,
      nextAttemptAt: typeof entry?.nextAttemptAt === "string" ? entry.nextAttemptAt : null,
      attempts: clampInt(entry?.attempts, 0, Number.MAX_SAFE_INTEGER, 0),
      startedAt: typeof entry?.startedAt === "string" ? entry.startedAt : null,
      ownerPID: typeof entry?.ownerPID === "number" ? entry.ownerPID : null,
      stats: entry?.stats && typeof entry.stats === "object" ? (entry.stats as Stats) : null,
      createdAt: String(entry?.createdAt ?? now),
      updatedAt: String(entry?.updatedAt ?? now),
      ...(entry?.error ? { error: String(entry.error) } : {}),
    }
  })
}

export async function loadTasks(): Promise<Task[]> {
  try {
    return normalise(JSON.parse(await fsp.readFile(STATE.taskQueue, "utf8")))
  } catch {
    return []
  }
}

export async function saveTasks(tasks: Task[]): Promise<void> {
  await fsp.mkdir(path.dirname(STATE.taskQueue), { recursive: true })

  // Unique per write, not just per process: several opencode processes share
  // this store and a shared name would let one clobber another's temp file.
  const temp = `${STATE.taskQueue}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`
  await fsp.writeFile(temp, JSON.stringify(tasks, null, 2) + "\n", "utf8")

  // Windows fails the rename with EPERM while any reader holds the destination
  // open, which readers here do constantly (the dashboard polls). The rename is
  // still atomic; it just has to wait for the handle to close.
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(temp, STATE.taskQueue)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if ((code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") || attempt >= 10) {
        await fsp.rm(temp, { force: true }).catch(() => {})
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)))
    }
  }
}

/**
 * Serialise read-modify-write cycles.
 *
 * opencode instantiates a plugin once per project directory inside a single
 * process, so several schedulers share this module. The chain lives on
 * `globalThis` for the same reason the registry does: every instance has to
 * queue behind the same promise.
 */
const LOCK = Symbol.for("@dsh/opencode-task-store-lock")

async function mutate<T>(fn: (tasks: Task[]) => T | Promise<T>): Promise<T> {
  const g = globalThis as Record<symbol, unknown>
  const previous = (g[LOCK] as Promise<unknown>) ?? Promise.resolve()

  const run = previous.then(async () => {
    const tasks = await loadTasks()
    const result = await fn(tasks)
    await saveTasks(tasks)
    return result
  })

  // Keep the chain alive even when this caller's mutation rejects.
  g[LOCK] = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

/**
 * Whether a title is a machine-generated stand-in rather than a real name.
 *
 * Kept here as well as in `summarize.ts` so the store can decide on its own
 * whether an incoming title is an upgrade, without importing the summariser.
 */
function isPlaceholder(title: string): boolean {
  const text = (title ?? "").trim()
  return (
    !text ||
    /^new session\b/i.test(text) ||
    /^session\s+[0-9a-z_-]+$/i.test(text) ||
    /^untitled\b/i.test(text) ||
    /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/i.test(text)
  )
}

/** Importance descending, then oldest update, then id. */
function ordered(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1
    return a.id < b.id ? -1 : 1
  })
}

export async function listTasks(): Promise<Task[]> {
  return ordered(await loadTasks())
}

export async function getTask(id: string): Promise<Task | null> {
  return (await loadTasks()).find((task) => task.id === id) ?? null
}

function due(task: Task, now: number): boolean {
  if (task.status !== "pending") return false
  if (!task.nextAttemptAt) return true
  const at = Date.parse(task.nextAttemptAt)
  return !Number.isFinite(at) || at <= now
}

/** Pending tasks whose backoff has not elapsed yet. */
export async function deferred(now = Date.now()): Promise<Task[]> {
  return (await listTasks()).filter((task) => task.status === "pending" && !due(task, now))
}

/** The next task due to run, ignoring whether a slot is free. */
export async function pickNext(now = Date.now()): Promise<Task | null> {
  return (await listTasks()).find((task) => due(task, now)) ?? null
}

/** The live task wrapping a session, if any. */
export async function findBySession(sessionID: string): Promise<Task | null> {
  const tasks = await listTasks()
  return tasks.find((task) => task.sessionID === sessionID && !TERMINAL.includes(task.status)) ?? null
}

/** Tasks currently holding a concurrency slot. */
export async function running(): Promise<Task[]> {
  return (await listTasks()).filter((task) => task.status === "running")
}

/** The soonest future `nextAttemptAt`, used to arm the scheduler's timer. */
export async function nextWakeAt(now = Date.now()): Promise<number | null> {
  const times = (await deferred(now))
    .map((task) => Date.parse(task.nextAttemptAt as string))
    .filter((at) => Number.isFinite(at))
  return times.length > 0 ? Math.min(...times) : null
}

export type Counts = Record<Status, number> & { waiting: number; ready: number }

export async function counts(now = Date.now()): Promise<Counts> {
  const tasks = await listTasks()
  const base = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<Status, number>
  for (const task of tasks) base[task.status] += 1
  const pending = tasks.filter((task) => task.status === "pending")
  return {
    ...base,
    ready: pending.filter((task) => due(task, now)).length,
    waiting: pending.filter((task) => !due(task, now)).length,
  }
}

/* ------------------------------------------------------------------ *
 * Mutations
 * ------------------------------------------------------------------ */

export type CreateInput = {
  /** Omit to create a fresh session on first dispatch. */
  sessionID?: string
  prompt?: string | null
  title?: string
  summary?: string | null
  summarySource?: "model" | "parser" | null
  importance?: number
  model?: string
  agent?: string
  /** Auto-approve permission requests in this task's session. */
  bypassPermissions?: boolean
  projectID?: string | null
  directory?: string | null
  origin?: Origin
  attempts?: number
  nextAttemptAt?: string
  status?: Extract<Status, "pending" | "running">
}

function build(input: CreateInput): Task {
  const now = new Date().toISOString()
  const prompt = input.prompt?.trim() || null
  // No session named means a fresh one, parked under a unique placeholder until
  // the dispatcher creates it.
  const sessionID = input.sessionID?.trim() || `${NEW_SESSION_PREFIX}${crypto.randomUUID()}`
  return {
    id: crypto.randomUUID(),
    title: input.title?.trim() || prompt?.slice(0, 60) || `session ${sessionID.slice(0, 12)}`,
    summary: input.summary?.trim() || null,
    summarySource: input.summarySource ?? null,
    importance: clampInt(input.importance, 1, 5, 3),
    sessionID,
    bypassPermissions: input.bypassPermissions === true,
    projectID: input.projectID ?? null,
    directory: normalizeDirectory(input.directory),
    prompt,
    model: input.model?.trim() || null,
    agent: input.agent?.trim() || null,
    status: input.status ?? "pending",
    origin: input.origin ?? "manual",
    outcome: null,
    nextAttemptAt: input.nextAttemptAt ?? null,
    attempts: clampInt(input.attempts, 0, Number.MAX_SAFE_INTEGER, 0),
    // A task created as running is being driven by this process.
    startedAt: input.status === "running" ? now : null,
    ownerPID: input.status === "running" ? process.pid : null,
    stats: null,
    createdAt: now,
    updatedAt: now,
  }
}

export async function createTask(input: CreateInput): Promise<Task> {
  const importance = input.importance ?? 3
  if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
    throw new Error("importance 必须是 1–5 的整数")
  }

  // A queued task exists to replay a prompt; without one there is nothing to send.
  if (!input.prompt?.trim()) throw new Error("prompt 不能为空")

  const task = build(input)
  await mutate((tasks) => {
    tasks.push(task)
  })
  return task
}

/** Tasks queued while opencode was not running, applied once at startup. */
export const SEED_PATH = path.join(CONFIG_DIR, "task-queue-seed.json")

/**
 * Merge tasks written to the seed file, then retire it.
 *
 * A file is the only way to hand work to a process that is not up yet: the
 * store is rewritten by whichever process is running, which would drop or strip
 * anything it did not write. Applying the seed once at startup and renaming it
 * keeps that bootstrap out of the steady state.
 */
export async function applySeed(): Promise<Task[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await fsp.readFile(SEED_PATH, "utf8"))
  } catch {
    return []
  }

  const incoming = normalise(parsed)
  const applied = await mutate((tasks) => {
    const known = new Set(tasks.map((task) => task.id))
    const added = incoming.filter((task) => !known.has(task.id))
    tasks.push(...added)
    return added
  })

  // Retire it whether or not every entry was new; a seed is applied once.
  await fsp.rename(SEED_PATH, `${SEED_PATH}.applied`).catch(() => {})
  return applied
}

/**
 * Wrap a session into a task, or return the task already wrapping it.
 *
 * Idempotent: every plugin instance observes the same `session.created` event,
 * so several of them race to wrap it.
 */
export async function wrapSession(
  input: CreateInput & { sessionID: string },
): Promise<{ task: Task; created: boolean }> {
  return mutate((tasks) => {
    const existing = ordered(tasks).find(
      (task) => task.sessionID === input.sessionID && !TERMINAL.includes(task.status),
    )
    if (existing) {
      // Project metadata often arrives after the session itself.
      existing.projectID ??= input.projectID ?? null
      existing.directory ??= normalizeDirectory(input.directory)

      // A real title always beats a placeholder. opencode names a session
      // "New session - <timestamp>" until its first turn is summarised, so the
      // name worth keeping usually arrives after the task was created.
      if (input.title && isPlaceholder(existing.title) && !isPlaceholder(input.title)) {
        existing.title = input.title
        existing.updatedAt = new Date().toISOString()
      }
      if (input.summary && !existing.summary) {
        existing.summary = input.summary
        existing.summarySource = input.summarySource ?? existing.summarySource
      }
      return { task: existing, created: false }
    }

    const task = build({ ...input, origin: input.origin ?? "session" })
    tasks.push(task)
    return { task, created: true }
  })
}

export type Patch = Partial<
  Pick<
    Task,
    | "status"
    | "outcome"
    | "title"
    | "summary"
    | "summarySource"
    | "importance"
    | "sessionID"
    | "bypassPermissions"
    | "projectID"
    | "directory"
    | "prompt"
    | "model"
    | "agent"
    | "nextAttemptAt"
    | "stats"
  >
> & {
  error?: string | null
  /** Count this change as a dispatch. */
  attempt?: boolean
}

export async function update(id: string, patch: Patch): Promise<Task | null> {
  return mutate((tasks) => {
    const task = tasks.find((entry) => entry.id === id)
    if (!task) return null

    // Captured before the patch lands, so a state transition is still visible.
    const was = task.status

    for (const key of [
      "status",
      "outcome",
      "title",
      "summary",
      "summarySource",
      "importance",
      "sessionID",
      "bypassPermissions",
      "projectID",
      "directory",
      "prompt",
      "model",
      "agent",
      "nextAttemptAt",
      "stats",
    ] as const) {
      if (patch[key] !== undefined) (task as any)[key] = patch[key]
    }
    if (patch.attempt) task.attempts += 1
    if (patch.error === null) delete task.error
    else if (patch.error !== undefined) task.error = patch.error

    // Ownership lasts exactly as long as the task is running, and entering the
    // running state is what starts the turn the grace period protects.
    if (patch.status !== undefined) {
      task.ownerPID = patch.status === "running" ? process.pid : null
      if (patch.status === "running" && was !== "running") task.startedAt = new Date().toISOString()
      else if (patch.status !== "running") task.startedAt = null
    }

    task.updatedAt = new Date().toISOString()
    return task
  })
}

export async function setStatus(id: string, status: Status, error?: string): Promise<Task | null> {
  return update(id, { status, error: error ?? null })
}

/**
 * Re-queue a task by hand, clearing every trace of the run that stopped it.
 *
 * A restart is the user overruling the previous outcome, so the task has to
 * stop *being* a failure rather than merely changing status. Clearing the
 * status and the error but keeping `outcome` left the card still reporting
 * "last: error" in red, and the panel's failed filter still counting it — the
 * task looked failed after the user had restarted it.
 *
 * The failure is not lost: it was written to the log when it happened, which
 * is where a past run belongs. The task row describes the run that is
 * current, and after a restart that run has not happened yet.
 */
export async function restart(id: string): Promise<Task | null> {
  return update(id, {
    status: "pending",
    // Overriding whatever backoff the scheduler had decided on is the point.
    nextAttemptAt: null,
    error: null,
    outcome: null,
    // Attempt counting continues: how many times this has been tried is a
    // fact about the task, not a verdict on it.
  })
}

/** Put a task back on the queue after `delayMs`, recording why. */
export async function scheduleRetry(id: string, delayMs: number, error?: string): Promise<Task | null> {
  return mutate((tasks) => {
    const task = tasks.find((entry) => entry.id === id)
    if (!task) return null
    task.status = "pending"
    task.attempts += 1
    task.nextAttemptAt = new Date(Date.now() + Math.max(0, delayMs)).toISOString()
    task.ownerPID = null
    task.startedAt = null
    task.updatedAt = new Date().toISOString()
    if (error) task.error = error
    return task
  })
}

/** Clear a task's backoff so it becomes due immediately. */
export async function clearRetry(id: string): Promise<Task | null> {
  return update(id, { nextAttemptAt: null, error: null })
}

export async function deleteTask(id: string): Promise<boolean> {
  return mutate((tasks) => {
    const index = tasks.findIndex((task) => task.id === id)
    if (index < 0) return false
    tasks.splice(index, 1)
    return true
  })
}

/** Drop every task that will never run again. */
export async function clearTerminal(): Promise<number> {
  return mutate((tasks) => {
    const keep = tasks.filter((task) => !TERMINAL.includes(task.status))
    const removed = tasks.length - keep.length
    tasks.splice(0, tasks.length, ...keep)
    return removed
  })
}

/**
 * Drop every task matching a predicate, whatever its status.
 *
 * `clearTerminal` only reaches finished work, so it cannot remove tasks that a
 * bug left wedged in `running` or `pending` — exactly the ones worth purging.
 */
export async function purge(match: (task: Task) => boolean): Promise<number> {
  return mutate((tasks) => {
    const keep = tasks.filter((task) => !match(task))
    const removed = tasks.length - keep.length
    tasks.splice(0, tasks.length, ...keep)
    return removed
  })
}

/**
 * Claim up to the free slots' worth of due tasks, atomically.
 *
 * Counting the running tasks and flipping the winners must happen under one
 * lock, otherwise two ticks both see the same free slot. The caller dispatches
 * whatever it is handed.
 */
export async function claimDue(maxConcurrent: number, now = Date.now()): Promise<Task[]> {
  return mutate((tasks) => {
    const active = tasks.filter((task) => task.status === "running").length
    const free = Math.max(0, maxConcurrent - active)
    if (free === 0) return []

    const claimed = ordered(tasks)
      .filter((task) => due(task, now) && task.prompt)
      .slice(0, free)

    const stamp = new Date().toISOString()
    for (const task of claimed) {
      task.status = "running"
      task.nextAttemptAt = null
      task.attempts += 1
      task.ownerPID = process.pid
      task.startedAt = stamp
      task.updatedAt = stamp
      delete task.error
    }
    return claimed
  })
}

/** Whether a process is still alive; signal 0 tests without delivering. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException)?.code === "EPERM"
  }
}

/**
 * Return slots held by tasks whose owning process is gone.
 *
 * `running` means "a session is being driven right now", which cannot survive
 * opencode exiting — nothing is prompting those sessions any more. So those
 * tasks go back on the queue to be resumed, which is what makes a restart
 * mid-turn recoverable.
 *
 * Ownership is checked rather than assumed: the store is shared by every
 * opencode process on the device, so reclaiming every running task would let a
 * second instance seize sessions the first is still driving. A task with no
 * recorded owner predates this field and is reclaimed, matching the old
 * behaviour. `resumePrompt` gives a wrapped session something to say, since one
 * interrupted mid-turn has no prompt of its own to replay.
 */
export async function recoverInterrupted(resumePrompt: string): Promise<Task[]> {
  return mutate((tasks) => {
    const stale = tasks.filter(
      (task) => task.status === "running" && (task.ownerPID === null || !alive(task.ownerPID)),
    )
    const stamp = new Date().toISOString()
    for (const task of stale) {
      task.status = "pending"
      task.outcome = "interrupted"
      // Due immediately: the wait is over, the process just restarted.
      task.nextAttemptAt = null
      task.ownerPID = null
      task.startedAt = null
      task.prompt ??= resumePrompt
      task.updatedAt = stamp
    }
    return stale
  })
}
