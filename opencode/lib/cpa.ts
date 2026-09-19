/**
 * CPA (CliProxy) quota probe.
 *
 * Ports the dsh `cliproxy-quota` monitor: probe an OpenAI-compatible endpoint
 * and read the remaining quota out of the response headers. Configuration is
 * taken from `~/.config/opencode/cpa-usage.json`, then the `cpa` provider block
 * in the opencode config, then Codex's `config.toml`, then the environment.
 * The API key is never written back to disk.
 */

import fsp from "node:fs/promises"
import path from "node:path"
import { CONFIG_DIR, LEGACY, STATE } from "./paths.ts"

const DEFAULT_BASE = "https://cpa.trance-0.com/v1"
const DEFAULT_PROBE = "/models"
const DEFAULT_HEADERS = [
  "x-quota-remaining",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining",
  "x-remaining-credits",
]

export type Config = {
  baseURL: string
  apiKey: string
  probePath: string
  quotaHeaderNames: string[]
  /** Root of the CliProxy management API (the `/v0/management` prefix is added). */
  managementURL: string
  /** Management key. Distinct from `apiKey`: the `/v1` key is rejected with 403. */
  managementKey: string
}

export type Quota = {
  ok: boolean
  baseURL?: string
  probePath?: string
  status?: number
  /** true/false when determinable, null when the probe could not decide. */
  available: boolean | null
  code?: string
  remaining?: number | null
  quotaHeader?: string | null
  models?: string[] | null
  error?: string
}

async function readJSON(file: string): Promise<any> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"))
  } catch {
    return null
  }
}

/** Pull `key = "value"` out of a TOML file without a full parser. */
function tomlString(key: string, text: string): string {
  const match = text.match(new RegExp(`${key}\\s*=\\s*"([^"]+)"`))
  return match ? match[1] : ""
}

export async function resolveConfig(): Promise<Config> {
  const config: Config = {
    baseURL: DEFAULT_BASE,
    apiKey: process.env.CPA_API_KEY ?? "",
    probePath: DEFAULT_PROBE,
    quotaHeaderNames: [...DEFAULT_HEADERS],
    managementURL: "",
    managementKey: process.env.CPA_MANAGEMENT_KEY ?? "",
  }

  // opencode's own config may already describe the cpa provider.
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const parsed = await readJSON(path.join(CONFIG_DIR, name))
    const options = parsed?.provider?.cpa?.options
    if (options?.baseURL) config.baseURL = String(options.baseURL)
    if (options?.apiKey) config.apiKey ||= String(options.apiKey)
  }

  // Fall back to the Codex provider block for the shared bearer token.
  try {
    const toml = await fsp.readFile(path.join(LEGACY.codexHome, "config.toml"), "utf8")
    config.baseURL = tomlString("base_url", toml) || config.baseURL
    config.apiKey ||= tomlString("experimental_bearer_token", toml)
  } catch {
    // No Codex config on this device.
  }

  // The plugin's own file wins over every fallback.
  const own = await readJSON(STATE.cpaConfig)
  if (own && typeof own === "object") {
    if (typeof own.baseURL === "string" && own.baseURL.trim()) config.baseURL = own.baseURL
    if (typeof own.apiKey === "string" && own.apiKey.trim()) config.apiKey = own.apiKey
    if (typeof own.probePath === "string" && own.probePath.trim()) config.probePath = own.probePath
    if (Array.isArray(own.quotaHeaderNames)) config.quotaHeaderNames = own.quotaHeaderNames.map(String)
    if (typeof own.managementURL === "string" && own.managementURL.trim()) config.managementURL = own.managementURL
    if (typeof own.managementKey === "string" && own.managementKey.trim()) config.managementKey = own.managementKey
  }

  // The management API sits on the same host as the `/v1` endpoint by default.
  config.managementURL ||= config.baseURL.replace(/\/v\d+(?:beta)?\/*$/i, "")

  return config
}

export async function saveConfig(patch: Partial<Config>): Promise<Config> {
  const current = (await readJSON(STATE.cpaConfig)) ?? {}
  const next = { ...current, ...patch }
  await fsp.mkdir(path.dirname(STATE.cpaConfig), { recursive: true })
  await fsp.writeFile(STATE.cpaConfig, JSON.stringify(next, null, 2) + "\n", "utf8")
  return resolveConfig()
}

function readQuota(headers: Headers, names: string[]) {
  for (const name of names) {
    const value = headers.get(name)
    if (value === null) continue
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return { header: name, value: parsed }
  }
  return null
}

/**
 * Probe the endpoint.
 *
 * A definitive provider response decides availability: a parsed quota header
 * wins, otherwise 2xx means available and 429 means exhausted. A transport
 * failure returns `available: null` so callers never mistake a network blip for
 * an exhausted quota.
 */
export async function probe(config: Config): Promise<Quota> {
  if (!config.baseURL.trim()) return { ok: false, available: null, error: "No baseURL configured" }

  const headers: Record<string, string> = { accept: "application/json" }
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`

  const base = config.baseURL.replace(/\/+$/, "")
  const probePath = config.probePath.startsWith("/") ? config.probePath : "/" + config.probePath

  let response: Response
  try {
    response = await fetch(base + probePath, { headers })
  } catch (error) {
    return { ok: false, available: null, error: error instanceof Error ? error.message : String(error) }
  }

  const status = response.status
  const quota = readQuota(response.headers, config.quotaHeaderNames)
  const body = await response.text()

  let models: string[] | null = null
  if (status >= 200 && status < 300) {
    try {
      const parsed = JSON.parse(body)
      const list = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed) ? parsed : null
      if (list) models = list.map((entry: any) => entry?.id).filter(Boolean)
    } catch {
      // The probe body was not a model list.
    }
  }

  let available: boolean | null
  let code = "ok"
  if (quota !== null) {
    available = quota.value > 0
    code = available ? "ok" : "QUOTA"
  } else if (status >= 200 && status < 300) {
    available = true
  } else if (status === 429) {
    available = false
    code = "QUOTA"
  } else {
    available = null
    code = `HTTP_${status}`
  }

  return {
    ok: true,
    baseURL: config.baseURL,
    probePath: config.probePath,
    status,
    available,
    code,
    remaining: quota ? quota.value : null,
    quotaHeader: quota ? quota.header : null,
    models,
  }
}

export async function checkQuota(): Promise<Quota> {
  return probe(await resolveConfig())
}

/* ------------------------------------------------------------------ *
 * Per-model usage via the CliProxy management API.
 *
 * The `/v1` key cannot see quota — it is rejected with 403 on
 * `/v0/management/*`. Usage lives with the upstream accounts, so the
 * management API is used twice: once to list the auth files, then once
 * per account to proxy a request to that provider's own usage endpoint
 * (`/v0/management/api-call`). This mirrors what the CPA web UI does.
 * ------------------------------------------------------------------ */

/** One rate-limit window: a percentage remaining and when it refills. */
export type Window = {
  /** 0–100 remaining, or null when the provider did not report it. */
  remainingPercent: number | null
  /** Epoch milliseconds of the next refresh, or null when unknown. */
  resetsAt: number | null
}

export type ModelUsage = {
  model: string
  provider: string
  /** The account (auth file) this quota belongs to. */
  account: string
  fiveHour: Window | null
  weekly: Window | null
  error?: string
}

type AuthFile = {
  name: string
  provider: string
  authIndex: string
  disabled: boolean
  /** Antigravity scopes its quota to a cloud project. */
  projectID: string
}

type ApiCallResult = { statusCode: number; body: unknown }

function managementBase(config: Config): string {
  return config.managementURL.replace(/\/+$/, "").replace(/\/v0\/management\/?$/i, "") + "/v0/management"
}

async function management(config: Config, path: string, init?: RequestInit): Promise<any> {
  if (!config.managementKey) throw new Error("No management key configured")

  const response = await fetch(managementBase(config) + path, {
    ...init,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${config.managementKey}`,
      ...init?.headers,
    },
  })

  const text = await response.text()
  if (!response.ok) {
    const detail = text.trim().slice(0, 200)
    throw new Error(`management ${path} failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Proxy one request to an upstream provider through the management API,
 * using the stored credentials of account `authIndex`.
 */
async function apiCall(
  config: Config,
  authIndex: string,
  request: { method: string; url: string; header: Record<string, string>; data?: string },
): Promise<ApiCallResult> {
  const result = await management(config, "/api-call", {
    method: "POST",
    body: JSON.stringify({ authIndex, ...request }),
  })
  const raw = result?.body
  let body: unknown = raw
  if (typeof raw === "string") {
    try {
      body = JSON.parse(raw)
    } catch {
      body = raw
    }
  }
  return { statusCode: Number(result?.status_code ?? 0), body }
}

function normaliseProvider(entry: any): string {
  const raw = String(entry?.provider ?? entry?.type ?? "").trim().toLowerCase().replace(/_/g, "-")
  return raw === "x-ai" || raw === "grok" ? "xai" : raw
}

async function listAccounts(config: Config): Promise<AuthFile[]> {
  const result = await management(config, "/auth-files")
  const files = Array.isArray(result?.files) ? result.files : []
  return files
    .map((entry: any) => ({
      name: String(entry?.name ?? ""),
      provider: normaliseProvider(entry),
      authIndex: String(entry?.auth_index ?? entry?.authIndex ?? ""),
      disabled: entry?.disabled === true,
      projectID: String(entry?.project_id ?? entry?.projectId ?? ""),
    }))
    .filter((file: AuthFile) => file.authIndex && !file.disabled)
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function toEpochMs(value: unknown): number | null {
  const numeric = toNumber(value)
  // Providers report either epoch seconds or an ISO timestamp.
  if (numeric !== null) return numeric > 1e11 ? numeric : numeric * 1000
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return null
}

/** Anthropic reports `utilization` as a used percentage. */
function claudeWindow(entry: any): Window | null {
  if (!entry || typeof entry !== "object") return null
  const used = toNumber(entry.utilization)
  return {
    remainingPercent: used === null ? null : Math.max(0, Math.min(100, 100 - used)),
    resetsAt: toEpochMs(entry.resets_at ?? entry.resetsAt),
  }
}

/** Codex reports `used_percent` plus either an absolute or relative reset. */
function codexWindow(entry: any): Window | null {
  if (!entry || typeof entry !== "object") return null
  const used = toNumber(entry.used_percent ?? entry.usedPercent)
  const resetAt = toNumber(entry.reset_at ?? entry.resetAt)
  const resetAfter = toNumber(entry.reset_after_seconds ?? entry.resetAfterSeconds)
  return {
    remainingPercent: used === null ? null : Math.max(0, Math.min(100, 100 - used)),
    resetsAt:
      resetAt !== null && resetAt > 0
        ? resetAt * 1000
        : resetAfter !== null && resetAfter > 0
          ? Date.now() + resetAfter * 1000
          : null,
  }
}

/** Codex nests its windows one level down and labels them by duration. */
function codexWindows(rateLimit: any): { fiveHour: Window | null; weekly: Window | null } {
  const primary = rateLimit?.primary_window ?? rateLimit?.primaryWindow ?? null
  const secondary = rateLimit?.secondary_window ?? rateLimit?.secondaryWindow ?? null
  return { fiveHour: codexWindow(primary), weekly: codexWindow(secondary) }
}

/** Model families an Antigravity quota group can cover. */
const FAMILIES = ["gemini", "claude", "gpt"] as const

/**
 * Antigravity reports a remaining fraction per bucket, grouped by model family.
 *
 * The groups do not enumerate their models — they name them in prose, e.g.
 * "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS" — so the
 * families are read out of that text and matched against model ids. Without
 * this every Antigravity model would inherit whichever group happened to be
 * last, reporting the wrong quota for most of them.
 */
function antigravityGroups(payload: any): Array<{ families: string[]; fiveHour: Window | null; weekly: Window | null }> {
  const groups = Array.isArray(payload?.groups) ? payload.groups : []
  return groups.map((group: any) => {
    const buckets = Array.isArray(group?.buckets) ? group.buckets : []
    const read = (match: (window: string) => boolean): Window | null => {
      const bucket = buckets.find((entry: any) => match(String(entry?.window ?? "").toLowerCase()))
      if (!bucket) return null
      const fraction = toNumber(bucket.remainingFraction ?? bucket.remaining_fraction)
      return {
        remainingPercent: fraction === null ? null : Math.max(0, Math.min(100, fraction * 100)),
        resetsAt: toEpochMs(bucket.resetTime ?? bucket.reset_time ?? bucket.resetsAt ?? bucket.resets_at),
      }
    }

    const text = `${group?.displayName ?? group?.display_name ?? ""} ${group?.description ?? ""}`.toLowerCase()
    return {
      families: FAMILIES.filter((family) => text.includes(family)),
      fiveHour: read((window) => window === "5h" || window.startsWith("five")),
      weekly: read((window) => window.startsWith("week")),
    }
  })
}

/** The family a model id belongs to, for matching against a quota group. */
function modelFamily(model: string): string | null {
  const id = model.toLowerCase()
  return FAMILIES.find((family) => id.includes(family)) ?? null
}

async function claudeUsage(config: Config, account: AuthFile): Promise<Omit<ModelUsage, "model">> {
  const result = await apiCall(config, account.authIndex, {
    method: "GET",
    url: "https://api.anthropic.com/api/oauth/usage",
    header: { Authorization: "Bearer $TOKEN$", "Content-Type": "application/json", "anthropic-beta": "oauth-2025-04-20" },
  })
  const base = { provider: account.provider, account: account.name }
  if (result.statusCode < 200 || result.statusCode >= 300) {
    return { ...base, fiveHour: null, weekly: null, error: `HTTP ${result.statusCode}` }
  }
  const body = result.body as any
  return { ...base, fiveHour: claudeWindow(body?.five_hour), weekly: claudeWindow(body?.seven_day) }
}

async function codexUsage(config: Config, account: AuthFile): Promise<Omit<ModelUsage, "model">> {
  const result = await apiCall(config, account.authIndex, {
    method: "GET",
    url: "https://chatgpt.com/backend-api/wham/usage",
    header: {
      Authorization: "Bearer $TOKEN$",
      "Content-Type": "application/json",
      "User-Agent": "codex_cli_rs/0.76.0",
    },
  })
  const base = { provider: account.provider, account: account.name }
  if (result.statusCode < 200 || result.statusCode >= 300) {
    return { ...base, fiveHour: null, weekly: null, error: `HTTP ${result.statusCode}` }
  }
  const body = result.body as any
  const windows = codexWindows(body?.rate_limit ?? body?.rateLimit)
  return { ...base, ...windows }
}

/** Antigravity's quota endpoint moved between hosts; try them in the UI's order. */
const ANTIGRAVITY_HOSTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
]

const ANTIGRAVITY_AGENT = "antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)"

async function antigravityUsage(
  config: Config,
  account: AuthFile,
): Promise<Array<Omit<ModelUsage, "model"> & { families: string[] }>> {
  const base = { provider: account.provider, account: account.name }
  if (!account.projectID) {
    return [{ ...base, families: [], fiveHour: null, weekly: null, error: "no project id" }]
  }

  let lastError = "no response"
  for (const host of ANTIGRAVITY_HOSTS) {
    const result = await apiCall(config, account.authIndex, {
      method: "POST",
      url: `${host}/v1internal:retrieveUserQuotaSummary`,
      header: {
        Authorization: "Bearer $TOKEN$",
        "Content-Type": "application/json",
        "User-Agent": ANTIGRAVITY_AGENT,
      },
      data: JSON.stringify({ project: account.projectID }),
    })

    if (result.statusCode >= 200 && result.statusCode < 300) {
      const groups = antigravityGroups(result.body)
      if (groups.length > 0) return groups.map((group) => ({ ...base, ...group }))
      lastError = "no quota groups"
      continue
    }
    lastError = `HTTP ${result.statusCode}`
  }

  return [{ ...base, families: [], fiveHour: null, weekly: null, error: lastError }]
}

/**
 * Which account provider each advertised model belongs to, from `/v1/models`.
 *
 * `/v1/models` names the upstream vendor (`anthropic`, `openai`), while the
 * auth files name the client (`claude`, `codex`), so the two are mapped here.
 */
const OWNER_PROVIDERS: Record<string, string> = { anthropic: "claude", openai: "codex", antigravity: "antigravity" }

async function modelOwners(config: Config): Promise<Map<string, string>> {
  const owners = new Map<string, string>()
  const headers: Record<string, string> = { accept: "application/json" }
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`

  const base = config.baseURL.replace(/\/+$/, "")
  const response = await fetch(base + "/models", { headers })
  if (!response.ok) return owners

  const parsed = await response.json().catch(() => null)
  const list = Array.isArray((parsed as any)?.data) ? (parsed as any).data : []
  for (const entry of list) {
    const id = String(entry?.id ?? "")
    if (!id) continue
    const owner = String(entry?.owned_by ?? entry?.ownedBy ?? "").trim().toLowerCase()
    owners.set(id, OWNER_PROVIDERS[owner] ?? owner)
  }
  return owners
}

/**
 * Remaining quota per advertised model.
 *
 * Quota is per upstream account, not per model, so each model inherits the
 * windows of the account serving it. Models whose provider has no account
 * (or no usage endpoint) are returned with null windows.
 */
export async function modelUsage(config: Config): Promise<ModelUsage[]> {
  return cacheUsage(await fetchModelUsage(config))
}

async function fetchModelUsage(config: Config): Promise<ModelUsage[]> {
  const [owners, accounts] = await Promise.all([modelOwners(config), listAccounts(config)])

  const byProvider = new Map<string, Omit<ModelUsage, "model">>()
  const antigravityByFamily = new Map<string, Omit<ModelUsage, "model">>()

  await Promise.all(
    accounts.map(async (account) => {
      try {
        if (account.provider === "claude") {
          byProvider.set("claude", await claudeUsage(config, account))
        } else if (account.provider === "codex") {
          byProvider.set("codex", await codexUsage(config, account))
        } else if (account.provider === "antigravity") {
          for (const group of await antigravityUsage(config, account)) {
            for (const family of group.families) antigravityByFamily.set(family, group)
            // A group that names no family (or an outright failure) still needs
            // to surface, so it becomes the provider-wide fallback.
            if (group.families.length === 0) byProvider.set("antigravity", group)
          }
        }
      } catch (error) {
        byProvider.set(account.provider, {
          provider: account.provider,
          account: account.name,
          fiveHour: null,
          weekly: null,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }),
  )

  return [...owners.entries()]
    .map(([model, provider]) => {
      const family = provider === "antigravity" ? modelFamily(model) : null
      const usage = (family ? antigravityByFamily.get(family) : null) ?? byProvider.get(provider)
      if (!usage) return { model, provider, account: "", fiveHour: null, weekly: null, error: "no account" }
      return { model, ...usage }
    })
    .sort((a, b) => a.model.localeCompare(b.model))
}

/**
 * Last known usage, shared across plugin instances.
 *
 * Reading quota costs one management call per account, so the dashboard must
 * not fetch on every poll. It renders this cache and refreshing is an explicit
 * action. Stored on `globalThis` for the same reason as the registry: one
 * process hosts many plugin instances but a single dashboard.
 */
const USAGE_KEY = Symbol.for("@dsh/opencode-cpa-usage-cache")

type UsageCache = { at: number; models: ModelUsage[] } | null

export function cachedUsage(): UsageCache {
  return ((globalThis as Record<symbol, unknown>)[USAGE_KEY] as UsageCache) ?? null
}

function cacheUsage(models: ModelUsage[]): ModelUsage[] {
  ;(globalThis as Record<symbol, unknown>)[USAGE_KEY] = { at: Date.now(), models }
  return models
}
