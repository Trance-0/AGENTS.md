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

/** `Claude Opus 5 40%(23:55)/98%(09/23 23:55)`, coloured by the worse window. */
function formatUsage(usage: CPA.ModelUsage, colour: boolean): string {
  const body = `${usage.model} ${formatWindow(usage.fiveHour)}/${formatWindow(usage.weekly)}${
    usage.error ? ` [${usage.error}]` : ""
  }`
  if (!colour) return body
  const key = tone(usage)
  return key === "reset" ? body : `${COLOUR[key]}${body}${COLOUR.reset}`
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
      ]
    },
    async update(key, value) {
      const editable = ["baseURL", "apiKey", "managementURL", "managementKey", "probePath"]
      if (!editable.includes(key)) throw new Error(`unknown setting: ${key}`)
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

      return [
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
