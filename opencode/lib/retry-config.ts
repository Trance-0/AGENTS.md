/**
 * Persisted retry settings for the task queue.
 *
 * Kept separate from `retry.ts` (which is pure policy) so the plugin can expose
 * these as editable fields in the dashboard without the policy module needing
 * any filesystem access.
 */

import fsp from "node:fs/promises"
import path from "node:path"
import { CONFIG_DIR } from "./paths.ts"
import { DEFAULT_POLICY, type Policy } from "./retry.ts"
import { SUGGESTED_MODEL } from "./summarize.ts"

/**
 * How long to wait after a rate-limit refusal.
 *
 * `reset` asks cpa-usage when the model's window actually refills, which is the
 * only wait that is neither too early nor too long; it falls back to the
 * interval for a model CPA does not report. `interval` always waits
 * `retryIntervalSeconds`.
 */
export type RateLimitMode = "reset" | "interval"

export type RetryConfig = Policy & {
  /** Whether an interrupted turn is queued for retry automatically. */
  enabled: boolean
  /** Skip the retry when the quota probe says the budget is exhausted. */
  requireQuota: boolean
  /** How many tasks may hold a concurrency slot at once. */
  maxConcurrent: number
  /** Wrap every newly created session into a task automatically. */
  autoWrapSessions: boolean
  /**
   * Resume sessions that were still running when opencode last exited.
   *
   * Restarting the editor mid-turn is routine while developing a plugin, and
   * without this the work in flight is simply lost.
   */
  resumeOnRestart: boolean
  rateLimitMode: RateLimitMode
  /** Fallback/fixed wait after a rate-limit refusal, in seconds. */
  retryIntervalSeconds: number
  /** Seconds between scheduler ticks, as a backstop for missed events. */
  pollSeconds: number
  /**
   * `providerID/modelID` used to title and summarise tasks, or "" for none.
   *
   * Summarising is small and self-contained, so a cheap local model is a good
   * fit. Empty means the built-in parser does the work; it is also what every
   * model failure falls back to, so this is always optional.
   */
  summaryModel: string
}

const CONFIG_PATH = path.join(CONFIG_DIR, "task-queue-retry.json")

export const DEFAULTS: RetryConfig = {
  enabled: true,
  requireQuota: true,
  maxConcurrent: 3,
  autoWrapSessions: true,
  resumeOnRestart: true,
  rateLimitMode: "reset",
  retryIntervalSeconds: 300,
  pollSeconds: 30,
  summaryModel: SUGGESTED_MODEL,
  ...DEFAULT_POLICY,
}

export function configPath(): string {
  return CONFIG_PATH
}

export async function load(): Promise<RetryConfig> {
  try {
    const parsed = JSON.parse(await fsp.readFile(CONFIG_PATH, "utf8"))
    if (!parsed || typeof parsed !== "object") return { ...DEFAULTS }
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULTS.enabled,
      requireQuota: typeof parsed.requireQuota === "boolean" ? parsed.requireQuota : DEFAULTS.requireQuota,
      autoWrapSessions:
        typeof parsed.autoWrapSessions === "boolean" ? parsed.autoWrapSessions : DEFAULTS.autoWrapSessions,
      resumeOnRestart: typeof parsed.resumeOnRestart === "boolean" ? parsed.resumeOnRestart : DEFAULTS.resumeOnRestart,
      rateLimitMode: parsed.rateLimitMode === "interval" ? "interval" : DEFAULTS.rateLimitMode,
      // An explicit "" means "no model"; only an absent key takes the default.
      summaryModel: typeof parsed.summaryModel === "string" ? parsed.summaryModel.trim() : DEFAULTS.summaryModel,
      maxConcurrent: clamp(parsed.maxConcurrent, 1, 32, DEFAULTS.maxConcurrent),
      retryIntervalSeconds: clamp(parsed.retryIntervalSeconds, 10, 86_400, DEFAULTS.retryIntervalSeconds),
      pollSeconds: clamp(parsed.pollSeconds, 5, 3_600, DEFAULTS.pollSeconds),
      maxAttempts: clamp(parsed.maxAttempts, 0, 50, DEFAULTS.maxAttempts),
      baseDelayMs: clamp(parsed.baseDelayMs, 1_000, 600_000, DEFAULTS.baseDelayMs),
      maxDelayMs: clamp(parsed.maxDelayMs, 1_000, 3_600_000, DEFAULTS.maxDelayMs),
    }
  } catch {
    return { ...DEFAULTS }
  }
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export async function save(patch: Partial<RetryConfig>): Promise<RetryConfig> {
  const next = { ...(await load()), ...patch }
  await fsp.mkdir(path.dirname(CONFIG_PATH), { recursive: true })
  const temp = CONFIG_PATH + ".tmp"
  await fsp.writeFile(temp, JSON.stringify(next, null, 2) + "\n", "utf8")
  await fsp.rename(temp, CONFIG_PATH)
  return next
}
