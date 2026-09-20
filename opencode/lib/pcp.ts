/**
 * Personal Context Protocol (PCP) client.
 *
 * PCP is the remote store that makes a session outlive the device that
 * recorded it. This client speaks two of its APIs:
 *
 *   - the *manager* API, authenticated with a scoped token, which resolves and
 *     creates sessions by `external_key`;
 *   - the *agent* API, authenticated with the per-session access token the
 *     manager mints, which appends messages.
 *
 * Only the scoped token is configured by the user; per-session tokens are
 * obtained from the manager and cached in the session index.
 */

import fsp from "node:fs/promises"
import path from "node:path"
import { STATE } from "./paths.ts"

/** Limits enforced by PCP's agent ingestion routes (`src/lib/agent-protocol.ts`). */
export const MAX_MESSAGES_PER_REQUEST = 50
export const MAX_CONTENT_CHARS = 100_000

export type Config = {
  /** Origin of the PCP deployment, without a trailing slash. */
  baseURL: string
  /** Global scoped token with read_all, create_sessions and mint_tokens. */
  scopedToken: string
}

export type Message = {
  role: "user" | "assistant"
  content: string
  provider?: string
  base_model?: string
  provider_timestamp?: string
}

/** Response of `POST /manager/sessions`; `created` is false when reused. */
export type ManagerSession = {
  success: boolean
  created: boolean
  session_id: string
  title: string
  access_token: string | null
  recording_url: string
}

async function readJSON(file: string): Promise<any> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"))
  } catch {
    // Missing or corrupt config — treat PCP as unconfigured.
    return null
  }
}

export async function resolveConfig(): Promise<Config> {
  const own = await readJSON(STATE.pcpConfig)
  const baseURL = typeof own?.baseURL === "string" ? own.baseURL.trim().replace(/\/+$/, "") : ""
  return {
    baseURL,
    scopedToken: typeof own?.scopedToken === "string" ? own.scopedToken.trim() : "",
  }
}

export async function saveConfig(patch: Partial<Config>): Promise<Config> {
  const current = (await readJSON(STATE.pcpConfig)) ?? {}
  const next = { ...current, ...patch }
  await fsp.mkdir(path.dirname(STATE.pcpConfig), { recursive: true })
  await fsp.writeFile(STATE.pcpConfig, JSON.stringify(next, null, 2) + "\n", "utf8")
  return resolveConfig()
}

/** Call a PCP route, raising the server's own error text on failure. */
async function call(url: string, token: string, method: string, body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  const text = await response.text()
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = { error: text }
  }

  if (!response.ok) throw new Error(`PCP ${method} failed (${response.status}): ${parsed?.error ?? text}`)
  return parsed
}

async function manager<T>(config: Config, method: string, route: string, body?: unknown): Promise<T> {
  if (!config.baseURL || !config.scopedToken) {
    throw new Error("PCP is not configured — set the base URL and scoped token on the Session Manager settings tab")
  }
  return (await call(`${config.baseURL}/api/v1${route}`, config.scopedToken, method, body)) as T
}

/**
 * Resolve the remote session for a source transcript, creating it once.
 *
 * `externalKey` is the stable `<device>:<kind>:<nativeID>` identity, so calling
 * this again for the same transcript returns the session already created for it
 * rather than a duplicate.
 */
export async function ensureSession(config: Config, externalKey: string, title: string, mode: "wild" | "exact" = "exact") {
  return manager<ManagerSession>(config, "POST", "/manager/sessions", { external_key: externalKey, title, mode })
}

/** Look up a remote session and its append cursor by external key. */
export async function lookupSession(config: Config, externalKey: string) {
  return manager<{ found: boolean; session_id?: string; message_count?: number; last_ordinal?: number }>(
    config,
    "GET",
    `/manager/sessions/by-key/${encodeURIComponent(externalKey)}`,
  )
}

/** Append one batch of messages using the session's own access token. */
export async function appendMessages(config: Config, sessionID: string, accessToken: string, messages: Message[]) {
  if (!accessToken) {
    throw new Error("PCP did not return a session access token — the scoped token needs the mint_tokens permission")
  }
  if (messages.length === 0) return null
  return call(
    `${config.baseURL}/api/v1/agent/sessions/${encodeURIComponent(sessionID)}/messages`,
    accessToken,
    "POST",
    { messages },
  )
}

/** Read the scoped folder/session tree, used as a connectivity check. */
export async function probe(config: Config) {
  return manager<unknown>(config, "GET", "/manager/tree")
}
