/**
 * Retry policy for interrupted turns.
 *
 * opencode calls the model with `maxRetries: input.retries ?? 0` and exposes no
 * config key for it, so a dropped TLS socket ends the turn outright:
 *
 *     TypeError: terminated
 *       at Fetch.onAborted (undici)
 *       at TLSSocket.onHttpSocketClose (undici)
 *
 * That is a transport failure, not a refusal — the request was well-formed and
 * would very likely succeed on a second attempt. This module decides which
 * failures are worth retrying and how long to wait, and the task-queue plugin
 * turns that decision into a queued continuation.
 *
 * A retry is only ever *queued*, never fired mid-turn: the queue already knows
 * how to resume a session, and going through it means retries are visible,
 * bounded, and gated on quota like any other task.
 */

/** Errors that mean "the pipe broke", as opposed to "the model said no". */
const TRANSPORT_PATTERNS = [
  /\bterminated\b/i,
  /socket hang ?up/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /EPIPE/i,
  /network error/i,
  /fetch failed/i,
  /premature close/i,
  /aborted/i,
  /stream closed before/i,
  /disconnected before completion/i,
]

/** Errors that will fail identically on a retry, so retrying is pointless. */
const PERMANENT_PATTERNS = [
  /does not support this model/i,
  /invalid[_ ]api[_ ]key/i,
  /unauthorized/i,
  /forbidden/i,
  /context (length|window) exceeded/i,
  /model not found/i,
  /invalid request/i,
]

export type Classification = "transport" | "quota" | "permanent" | "unknown"

/**
 * Classify a failure.
 *
 * Quota exhaustion is called out separately: it is worth retrying, but only
 * once the quota has actually come back, so it must not consume the transport
 * attempt budget or trigger an immediate re-run.
 */
export function classify(error: unknown): Classification {
  const text =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : (() => {
            try {
              return JSON.stringify(error)
            } catch {
              return String(error)
            }
          })()

  if (/429|rate.?limit|quota|insufficient credit|too many requests/i.test(text)) return "quota"
  if (PERMANENT_PATTERNS.some((pattern) => pattern.test(text))) return "permanent"
  if (TRANSPORT_PATTERNS.some((pattern) => pattern.test(text))) return "transport"
  return "unknown"
}

export function isRetryable(error: unknown): boolean {
  const kind = classify(error)
  return kind === "transport" || kind === "quota"
}

export type Policy = {
  /** Maximum automatic attempts after the original failure. */
  maxAttempts: number
  /** First backoff step in milliseconds; doubles each attempt. */
  baseDelayMs: number
  /** Ceiling for a single backoff step. */
  maxDelayMs: number
}

export const DEFAULT_POLICY: Policy = {
  maxAttempts: 10,
  baseDelayMs: 5_000,
  maxDelayMs: 5 * 60_000,
}

/**
 * Exponential backoff with jitter.
 *
 * Jitter matters here because a proxy outage tends to fail several sessions at
 * once; without it they would all retry on the same beat and hammer the
 * endpoint at the moment it is least able to cope.
 */
export function delayFor(attempt: number, policy: Policy = DEFAULT_POLICY): number {
  const exponential = Math.min(policy.baseDelayMs * 2 ** Math.max(0, attempt - 1), policy.maxDelayMs)
  const jitter = exponential * 0.25 * Math.random()
  return Math.round(exponential + jitter)
}

/** Whether another attempt is allowed under the policy. */
export function canRetry(attempts: number, error: unknown, policy: Policy = DEFAULT_POLICY): boolean {
  if (attempts >= policy.maxAttempts) return false
  return isRetryable(error)
}

export function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
