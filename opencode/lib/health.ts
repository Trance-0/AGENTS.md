/**
 * Current abnormal behaviour, in one place every plugin can read.
 *
 * When a run stalls the useful question is "what is wrong right now", and the
 * answer is spread across three places: the task queue knows a model was rate
 * limited, the retry classifier knows a provider keeps dropping connections,
 * and cpa-usage knows a quota window is empty. None of them alone can say it,
 * and a log line scrolls away.
 *
 * So each records a short-lived *condition* here, and the dashboards render the
 * set as plain statements — "gpt-5.5 rate limit exceeded, retries at 01:11",
 * "cpa: unstable connection, 4 failures in 3 min".
 *
 * Conditions expire on their own. A problem that has stopped recurring stops
 * being reported without anybody having to remember to clear it, which is what
 * keeps this honest: anything listed is something still happening.
 *
 * Stored on `globalThis` because one process hosts many plugin instances but a
 * single dashboard, exactly as the registry is.
 */

export type Severity = "warn" | "error"

export type Kind = "rate-limit" | "unstable" | "quota" | "auth" | "other"

export type Condition = {
  /** Stable identity; re-reporting the same key refreshes rather than adds. */
  key: string
  kind: Kind
  severity: Severity
  /** Which plugin noticed, so the dashboard can attribute it. */
  source: string
  /** What is affected — a model id, a provider, an account. */
  subject: string
  /** One sentence, already readable on its own. */
  detail: string
  /** When the condition clears by itself, epoch ms. */
  until: number
  /** Epoch ms the underlying problem is expected to resolve, when known. */
  retryAt?: number
  /** How many times this has been reported since it first appeared. */
  count: number
  firstAt: number
  lastAt: number
}

const KEY = Symbol.for("@dsh/opencode-health")

/** A condition nobody refreshes stops being true soon enough to matter. */
const DEFAULT_TTL_MS = 10 * 60_000

function store(): Map<string, Condition> {
  const g = globalThis as Record<symbol, unknown>
  if (!g[KEY]) g[KEY] = new Map<string, Condition>()
  return g[KEY] as Map<string, Condition>
}

function sweep(now: number): void {
  const map = store()
  for (const [key, condition] of map) if (condition.until <= now) map.delete(key)
}

export type ReportInput = {
  key: string
  kind: Kind
  source: string
  subject: string
  detail: string
  severity?: Severity
  /** Epoch ms the problem is expected to resolve; also extends the lifetime. */
  retryAt?: number
  /** Override how long this is remembered for. */
  ttlMs?: number
}

/**
 * Record that something is currently wrong.
 *
 * Re-reporting the same `key` keeps one entry and counts the repeat, so a model
 * that rate-limits twenty times in a row reads as one condition seen twenty
 * times rather than twenty conditions.
 */
export function report(input: ReportInput): Condition {
  const now = Date.now()
  sweep(now)

  const map = store()
  const existing = map.get(input.key)

  // A known retry time is the honest expiry: the condition is true until then,
  // and stale afterwards whatever the default would have said.
  const ttl = input.ttlMs ?? DEFAULT_TTL_MS
  const until = Math.max(now + ttl, input.retryAt ?? 0)

  const condition: Condition = {
    key: input.key,
    kind: input.kind,
    severity: input.severity ?? "warn",
    source: input.source,
    subject: input.subject,
    detail: input.detail,
    until,
    ...(input.retryAt ? { retryAt: input.retryAt } : {}),
    count: (existing?.count ?? 0) + 1,
    firstAt: existing?.firstAt ?? now,
    lastAt: now,
  }

  map.set(input.key, condition)
  return condition
}

/** Drop a condition that has demonstrably resolved, e.g. a call succeeded. */
export function clear(key: string): void {
  store().delete(key)
}

/** Drop every condition a plugin owns, e.g. after a successful refresh. */
export function clearSource(source: string): void {
  const map = store()
  for (const [key, condition] of map) if (condition.source === source) map.delete(key)
}

/** Everything currently wrong, worst first, then most recent. */
export function current(now = Date.now()): Condition[] {
  sweep(now)
  return [...store().values()].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1
    return b.lastAt - a.lastAt
  })
}

/** Conditions raised by one plugin. */
export function bySource(source: string, now = Date.now()): Condition[] {
  return current(now).filter((condition) => condition.source === source)
}

/**
 * A single sentence covering everything wrong, or null when nothing is.
 *
 * This is what a status line shows, where there is room for one line and the
 * reader needs to know whether to look closer.
 */
export function summary(now = Date.now()): string | null {
  const conditions = current(now)
  if (conditions.length === 0) return null
  if (conditions.length === 1) return conditions[0].detail
  return `${conditions[0].detail} (+${conditions.length - 1} more)`
}

/** "in 4m 12s" / "now" — how long until a condition is expected to clear. */
export function formatCountdown(at: number | undefined, now = Date.now()): string | null {
  if (!at) return null
  const seconds = Math.round((at - now) / 1000)
  if (seconds <= 0) return "now"
  if (seconds < 60) return `in ${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `in ${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`
}
