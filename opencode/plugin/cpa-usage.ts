/**
 * cpa-usage — report remaining CPA (CliProxy) quota.
 *
 * Ports the dsh `cliproxy-quota` monitor / codex `cpa-usage` plugin. Probes the
 * configured OpenAI-compatible endpoint and reads the quota from the response
 * headers.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import * as CPA from "../lib/cpa.ts"
import * as Registry from "../lib/registry.ts"
import * as Logs from "../lib/logs.ts"
import * as Health from "../lib/health.ts"
import { STATE } from "../lib/paths.ts"

const COLOUR = { red: "\u001b[31m", yellow: "\u001b[33m", green: "\u001b[32m", reset: "\u001b[0m" }

/** The panel vocabulary uses semantic tones rather than colour names. */
const PANEL_TONE = { red: "error", yellow: "warn", green: "ok", reset: "muted" } as const

function windowTone(window: CPA.Window | null): Registry.Tone {
  const percent = window?.remainingPercent
  if (percent === null || percent === undefined) return "muted"
  if (percent < 10) return "error"
  if (percent < 50) return "warn"
  return "ok"
}

/** Red below 10% remaining, yellow below 50%, green otherwise. */
function tone(usage: CPA.ModelUsage): keyof typeof COLOUR {
  const percents = [usage.fiveHour?.remainingPercent, usage.weekly?.remainingPercent].filter(
    (value): value is number => value !== null && value !== undefined,
  )
  if (percents.length === 0) return "reset"
  const worst = Math.min(...percents)
  if (worst < 10) return "red"
  if (worst < 50) return "yellow"
  return "green"
}

/**
 * Render a reset time as the user's clock: `HH:MM` when it lands today,
 * `MM/DD HH:MM` otherwise, since weekly windows are days away.
 */
function formatReset(at: number | null): string {
  if (at === null) return "—"
  const date = new Date(at)
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
  const sameDay = new Date().toDateString() === date.toDateString()
  if (sameDay) return time
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")} ${time}`
}

function formatWindow(window: CPA.Window | null): string {
  if (!window || window.remainingPercent === null) return "—"
  return `${Math.round(window.remainingPercent)}%(${formatReset(window.resetsAt)})`
}

/**
 * Shorten an auth-file name to something that fits a field label.
 *
 * The names are long and mostly boilerplate — `codex-894e959b-user@host-team.json`
 * — so the provider prefix, hash and extension are dropped, leaving the part
 * that actually distinguishes one account from another.
 */
function accountLabel(name: string): string {
  const trimmed = name.replace(/\.json$/i, "").replace(/^(codex|claude|antigravity)-/i, "")
  const withoutHash = trimmed.replace(/^[0-9a-f]{6,}-/i, "")
  return withoutHash.length > 28 ? withoutHash.slice(0, 27) + "…" : withoutHash
}

/** `Claude Opus 5 40%(23:55)/98%(09/23 23:55)`, coloured by the worse window. */
function formatUsage(usage: CPA.ModelUsage, colour: boolean): string {
  // A pooled figure is easy to misread as one account's, so say how many.
  const pooled = usage.accounts.length > 1 ? ` [${usage.accounts.length} accounts]` : ""
  const body = `${usage.model} ${formatWindow(usage.fiveHour)}/${formatWindow(usage.weekly)}${pooled}${
    usage.error ? ` [${usage.error}]` : ""
  }`
  if (!colour) return body
  const key = tone(usage)
  return key === "reset" ? body : `${COLOUR[key]}${body}${COLOUR.reset}`
}

/**
 * Publish exhausted quota as a health condition.
 *
 * A model reading 0% is the single most common reason work stalls, and the
 * number alone does not say when it comes back. Reporting it here means the
 * task queue's "current problems" list says so too, with the reset time the
 * provider gave us rather than a guess.
 */
function reportQuota(models: CPA.ModelUsage[]): void {
  // Quota is per provider, not per model, so one condition per provider.
  const worst = new Map<string, CPA.ModelUsage>()
  for (const usage of models) {
    if (!usage.provider) continue
    const current = worst.get(usage.provider)
    if (!current || (tone(usage) === "red" && tone(current) !== "red")) worst.set(usage.provider, usage)
  }

  for (const [provider, usage] of worst) {
    const key = `cpa-usage:quota:${provider}`
    const empty = [usage.fiveHour, usage.weekly].filter(
      (window) => window && window.remainingPercent !== null && window.remainingPercent <= 0,
    )

    if (empty.length === 0) {
      // Capacity is back; the condition is no longer true.
      Health.clear(key)
      continue
    }

    const resets = empty.map((window) => window!.resetsAt).filter((at): at is number => at !== null)
    const pooled = usage.accounts.length > 1 ? ` across ${usage.accounts.length} accounts` : ""
    Health.report({
      key,
      kind: "quota",
      severity: "warn",
      source: "cpa-usage",
      subject: provider,
      detail: `${provider} usage limit exceeded${pooled}`,
      ...(resets.length > 0 ? { retryAt: Math.min(...resets) } : {}),
    })
  }
}

/** Shared across instances, so the startup line is written once per process. */
const LOADED_KEY = Symbol.for("@dsh/opencode-cpa-usage-loaded")

/**
 * Refresh the usage cache, mirroring what the dashboard's "Update model usage"
 * action does. Silently skipped when the plugin is disabled or no management
 * key is configured, since neither is an error at startup or on a timer.
 */
async function refreshUsage(reason: string): Promise<void> {
  if (!Registry.isEnabled("cpa-usage")) return
  const config = await CPA.resolveConfig()
  if (!config.managementKey) return
  try {
    const usage = await CPA.modelUsage(config)
    const low = usage.filter((entry) => tone(entry) === "red").length
    reportQuota(usage)
    Logs.log("cpa-usage", `${reason}: refreshed usage for ${usage.length} models${low > 0 ? `, ${low} low` : ""}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    Logs.log("cpa-usage", `${reason}: usage refresh failed: ${message}`, "warn")
  }
}

/**
 * Tick once a minute and refresh when the cache is older than the configured
 * interval. Reading the config on every tick means a changed (or zeroed)
 * interval takes effect without a restart, and the coarse tick keeps the loop
 * cheap. The timer is unref'd so it never keeps the process alive.
 */
function scheduleAutoRefresh(): void {
  const timer = setTimeout(async () => {
    try {
      const config = await CPA.resolveConfig()
      if (config.refreshMinutes > 0) {
        const cache = CPA.cachedUsage()
        if (!cache || Date.now() - cache.at >= config.refreshMinutes * 60_000) {
          await refreshUsage("auto refresh")
        }
      }
    } finally {
      scheduleAutoRefresh()
    }
  }, 60_000)
  timer.unref?.()
}

export const CpaUsage: Plugin = async () => {
  await Registry.init()

  Registry.register({
    id: "cpa-usage",
    title: "CPA Usage",
    description: "Probe the CliProxy endpoint for remaining quota and available models.",
    async settings() {
      const config = await CPA.resolveConfig()
      return [
        { key: "baseURL", label: "Base URL", type: "string", value: config.baseURL, placeholder: "https://…/v1" },
        { key: "apiKey", label: "API key", type: "string", value: config.apiKey, secret: true, placeholder: "sk-…" },
        {
          key: "managementURL",
          label: "Management URL",
          type: "string",
          value: config.managementURL,
          description: "Root of the management API. Defaults to the base URL without its version suffix.",
        },
        {
          key: "managementKey",
          label: "Management key",
          type: "string",
          value: config.managementKey,
          secret: true,
          description: "Required for per-model quota. The API key is not accepted here.",
        },
        { key: "probePath", label: "Probe path", type: "string", value: config.probePath, placeholder: "/models" },
        {
          group: "Auto refresh",
          key: "refreshMinutes",
          label: "Refresh interval (minutes)",
          type: "number",
          value: config.refreshMinutes,
          min: 0,
          max: 1440,
          description: "Refresh model usage automatically this often. 0 disables the timer.",
        },
      ]
    },
    async update(key, value) {
      const editable = ["baseURL", "apiKey", "managementURL", "managementKey", "probePath", "refreshMinutes"]
      if (!editable.includes(key)) throw new Error(`unknown setting: ${key}`)
      if (key === "refreshMinutes") {
        const minutes = Number(value)
        if (!Number.isFinite(minutes) || minutes < 0) throw new Error("refreshMinutes must be a number ≥ 0")
        await CPA.saveConfig({ refreshMinutes: minutes })
        return
      }
      const text = String(value).trim()
      if (!text && (key === "baseURL" || key === "probePath")) throw new Error(`${key} cannot be empty`)
      await CPA.saveConfig({ [key]: text })
    },
    async status() {
      const config = await CPA.resolveConfig()
      // A disabled plugin should not reach out over the network.
      if (!Registry.isEnabled("cpa-usage")) {
        return [{ label: "probe", value: "disabled", tone: "muted" }]
      }
      const quota = await CPA.probe(config)
      return [
        {
          label: "quota",
          value: quota.available === null ? "unknown" : quota.available ? "available" : "exhausted",
          tone: quota.available === null ? "warn" : quota.available ? "ok" : "error",
        },
        { label: "status", value: quota.status ?? "—", tone: "muted" },
        { label: "models", value: quota.models?.length ?? 0, tone: "muted" },
        { label: "api key", value: config.apiKey ? "configured" : "missing", tone: config.apiKey ? "ok" : "error" },
        {
          label: "management key",
          value: config.managementKey ? "configured" : "missing",
          tone: config.managementKey ? "ok" : "warn",
        },
      ]
    },
    async panels() {
      const cache = CPA.cachedUsage()
      const config = await CPA.resolveConfig()

      const conditions = Health.bySource("cpa-usage")

      return [
        ...(conditions.length > 0
          ? [
              {
                key: "health",
                title: "Current problems",
                description: "Cleared automatically once quota returns.",
                type: "alerts" as const,
                items: conditions.map((condition) => {
                  const countdown = Health.formatCountdown(condition.retryAt)
                  return {
                    title: condition.detail,
                    subtitle: countdown ? `Recovers ${countdown}.` : undefined,
                    tone: condition.severity === "error" ? ("error" as const) : ("warn" as const),
                    fields: [
                      { label: "provider", value: condition.subject },
                      ...(condition.retryAt
                        ? [{ label: "resets", value: new Date(condition.retryAt).toLocaleString() }]
                        : []),
                    ],
                  }
                }),
              },
            ]
          : []),
        {
          key: "models",
          title: "Model usage",
          description: "Remaining quota per model as 5h / weekly, with the next refresh of each window.",
          updatedAt: cache?.at ?? null,
          action: "usage",
          empty: config.managementKey
            ? "No usage loaded yet — choose Update model usage."
            : "Set a management key on the Settings tab to read quota.",
          items: (cache?.models ?? []).map((usage) => ({
            title: usage.model,
            subtitle: usage.account || undefined,
            tone: PANEL_TONE[tone(usage)],
            group: usage.provider || "other",
            fields: [
              { label: "5h", value: formatWindow(usage.fiveHour), tone: windowTone(usage.fiveHour) },
              { label: "weekly", value: formatWindow(usage.weekly), tone: windowTone(usage.weekly) },
              // Pooled figures hide which account is actually short, so each
              // one is listed when several are being summed.
              ...(usage.accounts.length > 1
                ? usage.accounts.map((entry) => ({
                    label: accountLabel(entry.account),
                    value: entry.error
                      ? entry.error
                      : `${formatWindow(entry.fiveHour)} / ${formatWindow(entry.weekly)}`,
                    tone: entry.error ? ("error" as const) : windowTone(entry.fiveHour),
                  }))
                : []),
              ...(usage.error ? [{ label: "error", value: usage.error, tone: "error" as const }] : []),
            ],
          })),
          filters: [...new Set((cache?.models ?? []).map((usage) => usage.provider || "other"))].sort(),
        },
      ]
    },
    actions: {
      usage: {
        label: "Update model usage",
        async run() {
          const config = await CPA.resolveConfig()
          if (!config.managementKey) {
            Logs.log("cpa-usage", "usage refresh skipped: no management key", "warn")
            return "No management key configured — set one on the Settings tab."
          }
          try {
            const usage = await CPA.modelUsage(config)
            const low = usage.filter((entry) => tone(entry) === "red").length
            reportQuota(usage)
            Logs.log("cpa-usage", `updated usage for ${usage.length} models${low > 0 ? `, ${low} low` : ""}`)
            return `Updated ${usage.length} models${low > 0 ? `, ${low} low on quota` : ""}.`
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            Logs.log("cpa-usage", `usage refresh failed: ${message}`, "error")
            throw error
          }
        },
      },
    },
  })

  // Once per process, not once per project instance.
  if (!(globalThis as Record<symbol, unknown>)[LOADED_KEY]) {
    ;(globalThis as Record<symbol, unknown>)[LOADED_KEY] = true
    const config = await CPA.resolveConfig()
    Logs.log(
      "cpa-usage",
      `loaded — endpoint ${config.baseURL || "unset"}, ` +
        `api key ${config.apiKey ? "configured" : "missing"}, ` +
        `management key ${config.managementKey ? "configured" : "missing"}, ` +
        `auto refresh ${config.refreshMinutes > 0 ? `every ${config.refreshMinutes}m` : "off"}`,
      config.apiKey ? "info" : "warn",
    )
    // Populate the cache at startup, then keep it fresh on the timer.
    void refreshUsage("startup")
    scheduleAutoRefresh()
  }

  return {
    tool: {
      cpa_quota: tool({
        description:
          "Probe the CPA (CliProxy) endpoint and report remaining quota and availability. Returns `available` " +
          "(true, false, or null when undeterminable), the `remaining` count when a quota header was present, and " +
          "the HTTP status otherwise.",
        args: {},
        async execute() {
          const result = await CPA.checkQuota()
          const label =
            result.available === null
              ? "quota unknown"
              : result.available
                ? `available${result.remaining === null ? "" : ` (${result.remaining} left)`}`
                : "exhausted"
          return { title: label, output: JSON.stringify(result, null, 2) }
        },
      }),

      cpa_models: tool({
        description: "List the model ids the CPA endpoint advertises.",
        args: {},
        async execute() {
          const result = await CPA.checkQuota()
          if (!result.models) {
            return { title: "no model list", output: JSON.stringify({ models: null, note: "Probe body was not a model list.", status: result.status ?? null }, null, 2) }
          }
          return { title: `${result.models.length} models`, output: JSON.stringify({ count: result.models.length, models: result.models }, null, 2) }
        },
      }),

      cpa_usage: tool({
        description:
          "Report remaining quota per model as `<model> <5h>%(<next refresh>)/<weekly>%(<next refresh>)`, coloured " +
          "red/yellow/green when either window is below 10%/50%. Requires a management key; the plain API key " +
          "cannot read quota.",
        args: {
          model: tool.schema.string().optional().describe("Only report models whose id contains this substring."),
        },
        async execute(args) {
          const config = await CPA.resolveConfig()
          if (!config.managementKey) {
            return {
              title: "no management key",
              output:
                "Per-model quota needs a CliProxy management key.\n" +
                `Set it in ${STATE.cpaConfig} as "managementKey", via the plugin dashboard, or as $CPA_MANAGEMENT_KEY.`,
            }
          }

          let usage = await CPA.modelUsage(config)
          if (args.model) {
            const needle = args.model.toLowerCase()
            usage = usage.filter((entry) => entry.model.toLowerCase().includes(needle))
          }
          if (usage.length === 0) return { title: "no models", output: "No matching models." }

          const low = usage.filter((entry) => tone(entry) === "red").length
          return {
            title: `${usage.length} models${low > 0 ? `, ${low} low` : ""}`,
            output: usage.map((entry) => formatUsage(entry, true)).join("\n"),
          }
        },
      }),

      cpa_config: tool({
        description:
          "Show or update the CPA configuration: base URL, probe path, API key, and the management URL and key " +
          "used to read quota. Keys are written to the plugin's config file but only ever reported back as " +
          "configured/not configured.",
        args: {
          baseURL: tool.schema.string().optional().describe("Override the endpoint base URL."),
          probePath: tool.schema.string().optional().describe("Override the probe path (default /models)."),
          apiKey: tool.schema.string().optional().describe("Set the /v1 API key."),
          managementURL: tool.schema.string().optional().describe("Set the management API root."),
          managementKey: tool.schema.string().optional().describe("Set the management key used to read quota."),
        },
        async execute(args) {
          const patch: Partial<CPA.Config> = {}
          if (args.baseURL) patch.baseURL = args.baseURL
          if (args.probePath) patch.probePath = args.probePath
          if (args.apiKey) patch.apiKey = args.apiKey
          if (args.managementURL) patch.managementURL = args.managementURL
          if (args.managementKey) patch.managementKey = args.managementKey

          const config = Object.keys(patch).length > 0 ? await CPA.saveConfig(patch) : await CPA.resolveConfig()

          return {
            title: config.baseURL,
            output: JSON.stringify(
              {
                configPath: STATE.cpaConfig,
                baseURL: config.baseURL,
                probePath: config.probePath,
                quotaHeaderNames: config.quotaHeaderNames,
                managementURL: config.managementURL,
                apiKey: config.apiKey ? "configured" : "not configured",
                managementKey: config.managementKey ? "configured" : "not configured",
              },
              null,
              2,
            ),
          }
        },
      }),
    },
  }
}
