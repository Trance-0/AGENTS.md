/**
 * plugin-manager — settings dashboard and soft hot-plug for the personal plugins.
 *
 * Ports the codex `persistent-plugin-manager`. opencode's desktop app has no
 * plugin settings UI and no way to enable or disable a plugin at runtime, so
 * this supplies both:
 *
 *   - a localhost dashboard rendered from whatever each plugin registers, and
 *   - the same surface as tools, so everything is reachable from the GUI chat
 *     without leaving the app.
 *
 * "Disabling" is cooperative: opencode never unloads a plugin, so a disabled
 * plugin stays resident and gates its own hooks and actions on
 * `Registry.isEnabled`. That takes effect immediately, with no restart — which
 * is as close to hot-plug as the desktop app allows.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import * as Registry from "../lib/registry.ts"
import * as Dashboard from "../lib/dashboard.ts"
import * as Versions from "../lib/versions.ts"
import * as Marketplace from "../lib/marketplace.ts"
import * as ConfigFiles from "../lib/config-files.ts"
import { CONFIG_DIR, DB_PATH } from "../lib/paths.ts"

export const PluginManager: Plugin = async ({ client }) => {
  await Registry.init()

  const log = (message: string) => {
    client.app.log({ body: { service: "plugin-manager", level: "info", message } }).catch(() => {})
  }

  // The manager describes itself too, so the dashboard lists every plugin.
  Registry.register({
    id: "plugin-manager",
    title: "Plugin Manager",
    description: "Hosts this dashboard and the enable/disable state for the other plugins.",
    toggleable: false,
    // The marketplace is the manager's own concern: it is where every
    // plugin's updates come from, so it is configured in one place.
    async settings() {
      const config = await Marketplace.config()
      return [
        {
          key: "marketplace.repository",
          label: "Marketplace repository",
          type: "string",
          value: config.repository,
          placeholder: "owner/name",
          description: "GitHub repository whose plugin releases are offered. Any repo using the same tags works.",
        },
        {
          key: "marketplace.apiBase",
          label: "GitHub API base",
          type: "string",
          value: config.apiBase,
          placeholder: "https://api.github.com",
          description: "Change this to use a GitHub Enterprise host.",
        },
        {
          key: "marketplace.enabled",
          label: "Check for updates",
          type: "boolean",
          value: config.enabled,
          description: "When off, the manager never contacts the marketplace.",
        },
      ]
    },
    async update(key, value) {
      if (key === "marketplace.repository") return void (await Marketplace.setConfig({ repository: String(value) }))
      if (key === "marketplace.apiBase") return void (await Marketplace.setConfig({ apiBase: String(value) }))
      if (key === "marketplace.enabled") return void (await Marketplace.setConfig({ enabled: value === true }))
      throw new Error(`Unknown plugin-manager setting: ${key}`)
    },
    async status() {
      const url = Dashboard.current()
      const updates = await Marketplace.status().catch(() => [])
      const pending = updates.filter((entry) => entry.updateAvailable).length
      return [
        { label: "dashboard", value: url ?? "not hosted here", tone: url ? "ok" : "muted" },
        { label: "plugins", value: Registry.list().length, tone: "muted" },
        { label: "updates", value: pending, tone: pending > 0 ? "warn" : "ok" },
        { label: "config", value: CONFIG_DIR, tone: "muted" },
      ]
    },
    /**
     * Only the opencode-wide documents live here. A file owned by a plugin is
     * edited on that plugin's own Settings tab, so this panel stays short.
     */
    async panels() {
      const files = (await ConfigFiles.list()).filter((file) => !file.pluginID)
      const when = (at: number | null) =>
        at === null ? "—" : new Date(at).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })

      return [
        {
          key: "config",
          title: "opencode configuration",
          description:
            "opencode's own config documents. Each plugin's state file is edited on that plugin's Settings tab.",
          empty: "No config files found.",
          items: files.map((file) => ({
            title: file.name,
            subtitle: file.description,
            group: file.owner,
            tone: !file.exists ? "muted" : file.restart ? "warn" : "ok",
            link: { view: "config", arg: file.name },
            fields: [
              { label: "applies", value: file.restart ? "on restart" : "immediately", tone: file.restart ? "warn" : "ok" },
              ...(file.exists
                ? [
                    { label: "size", value: `${(file.size / 1024).toFixed(1)} KB` },
                    { label: "modified", value: when(file.modified) },
                  ]
                : [{ label: "state", value: "not created yet", tone: "muted" as const }]),
            ],
          })),
        },
      ]
    },
    actions: {
      "check-updates": {
        label: "Check for updates",
        async run() {
          const cache = await Marketplace.refresh()
          if (cache.error) return `Update check failed: ${cache.error}`
          const updates = (await Marketplace.status()).filter((entry) => entry.updateAvailable)
          return updates.length
            ? `${updates.length} update(s): ${updates.map((u) => `${u.pluginID} ${u.installed}→${u.available}`).join(", ")}`
            : `No updates; ${cache.listings.length} release(s) published`
        },
      },
    },
  })

  // Start the dashboard. opencode instantiates plugins once per project, so the
  // first instance to bind the port hosts it and the rest quietly defer.
  const started = await Dashboard.start().catch(() => ({ url: null, hosted: false }))
  if (started.hosted) log(`dashboard listening on ${started.url}`)

  return {
    tool: {
      plugins_status: tool({
        description:
          "Show every personal plugin: whether it is enabled, its current settings, and its live status. " +
          "Also returns the URL of the local settings dashboard.",
        args: {},
        async execute() {
          const plugins = await Registry.snapshot()
          const dashboard = Dashboard.current() ?? (await Dashboard.start().catch(() => ({ url: null }))).url

          const lines = plugins.map((plugin) => {
            const mark = plugin.enabled ? "on " : "off"
            const status = plugin.status.map((item) => `${item.label}=${item.value}`).join("  ")
            return `[${mark}] ${plugin.title.padEnd(18)} ${status}`
          })

          return {
            title: `${plugins.filter((p) => p.enabled).length}/${plugins.length} enabled`,
            output: [
              dashboard ? `Dashboard: ${dashboard}` : "Dashboard: unavailable",
              `Config:    ${CONFIG_DIR}`,
              `Database:  ${DB_PATH}`,
              "",
              ...lines,
              "",
              JSON.stringify({ plugins }, null, 2),
            ].join("\n"),
          }
        },
      }),

      plugins_dashboard: tool({
        description:
          "Return the URL of the local plugin settings dashboard, starting it if it is not already running. " +
          "Open this in a browser to edit settings and toggle plugins with a UI.",
        args: {},
        async execute() {
          const result = await Dashboard.start()
          if (!result.url) throw new Error("Could not start the dashboard: no free port in 14100-14120")
          return {
            title: result.url,
            output: JSON.stringify(
              {
                url: result.url,
                hostedByThisProcess: result.hosted,
                note: "The dashboard lives inside opencode and stops when opencode exits.",
              },
              null,
              2,
            ),
          }
        },
      }),

      plugins_versions: tool({
        description:
          "Report every plugin's managed version and whether the marketplace offers a newer one. Versions are " +
          "va.b.c: x.y.0 is a published stable release and any x.y.z with z above 0 is an unpublished local beta. " +
          "Set `check` to contact the marketplace instead of reading the last cached result.",
        args: {
          check: tool.schema
            .boolean()
            .optional()
            .describe("Refresh from the marketplace before reporting. Defaults to the cached result."),
        },
        async execute(args) {
          if (args.check) await Marketplace.refresh()

          const manifest = await Versions.load()
          const statuses = await Marketplace.status()
          const cache = await Marketplace.cached()

          const lines = statuses.map((entry) => {
            const state = entry.updateAvailable
              ? `update → ${entry.available}`
              : entry.unreleased
                ? "local beta (unpublished)"
                : entry.available
                  ? "up to date"
                  : "no release published"
            return `${entry.pluginID.padEnd(16)} v${entry.installed.padEnd(8)} ${entry.channel.padEnd(6)} ${state}`
          })

          const pending = statuses.filter((entry) => entry.updateAvailable).length
          return {
            title: pending ? `${pending} update(s) available` : `${statuses.length} plugins, all current`,
            output: [
              `Marketplace: ${manifest.repository}`,
              cache?.error ? `Last check failed: ${cache.error}` : "",
              "",
              ...lines,
              "",
              JSON.stringify({ manifest: manifest.plugins, status: statuses }, null, 2),
            ]
              .filter((line) => line !== "")
              .join("\n"),
          }
        },
      }),

      plugins_set: tool({
        description:
          "Change one plugin setting, using the keys reported by plugins_status (for example 'mode' or " +
          "'types.taskDone' on bark-notify).",
        args: {
          plugin: tool.schema.string().describe("Plugin id, e.g. bark-notify."),
          key: tool.schema.string().describe("Setting key from plugins_status."),
          value: tool.schema.string().describe("New value. Booleans accept true/false; numbers are parsed."),
        },
        async execute(args) {
          const plugin = Registry.get(args.plugin)
          if (!plugin) throw new Error(`Unknown plugin: ${args.plugin}`)

          const fields = await plugin.settings()
          const field = fields.find((entry) => entry.key === args.key)
          if (!field) {
            throw new Error(`Unknown setting '${args.key}'. Available: ${fields.map((f) => f.key).join(", ") || "none"}`)
          }

          // The tool takes a string so the model never has to guess a JSON type;
          // coerce it to whatever the field actually declares.
          let value: unknown = args.value
          if (field.type === "boolean") value = /^(true|1|yes|on|enabled)$/i.test(args.value.trim())
          else if (field.type === "number") {
            value = Number(args.value)
            if (!Number.isFinite(value)) throw new Error(`${args.key} must be a number`)
          }

          await plugin.update(args.key, value)
          const after = (await plugin.settings()).find((entry) => entry.key === args.key)
          log(`set ${args.plugin}.${args.key}`)

          return {
            title: `${plugin.title}: ${args.key} = ${after?.value}`,
            output: JSON.stringify({ plugin: args.plugin, key: args.key, value: after?.value }, null, 2),
          }
        },
      }),

      plugins_toggle: tool({
        description:
          "Enable or disable a plugin immediately, without restarting opencode. A disabled plugin stays loaded " +
          "but stops running its hooks and actions; the state persists across restarts.",
        args: {
          plugin: tool.schema.string().describe("Plugin id."),
          enabled: tool.schema.boolean().describe("true to enable, false to disable."),
        },
        async execute(args) {
          const plugin = Registry.get(args.plugin)
          if (!plugin) throw new Error(`Unknown plugin: ${args.plugin}`)
          if (plugin.toggleable === false) throw new Error(`${plugin.title} cannot be disabled`)

          await Registry.setEnabled(args.plugin, args.enabled)
          log(`${args.enabled ? "enabled" : "disabled"} ${args.plugin}`)

          return {
            title: `${plugin.title} ${args.enabled ? "enabled" : "disabled"}`,
            output: JSON.stringify({ enabled: Registry.enabledMap(), statePath: Registry.statePath() }, null, 2),
          }
        },
      }),

      plugins_action: tool({
        description:
          "Run a named action a plugin exposes, such as bark-notify 'test' or session-manager 'scan'. " +
          "plugins_status lists the available actions.",
        args: {
          plugin: tool.schema.string().describe("Plugin id."),
          action: tool.schema.string().describe("Action key."),
        },
        async execute(args) {
          const plugin = Registry.get(args.plugin)
          if (!plugin) throw new Error(`Unknown plugin: ${args.plugin}`)

          const action = plugin.actions?.[args.action]
          if (!action) {
            const available = Object.keys(plugin.actions ?? {}).join(", ") || "none"
            throw new Error(`Unknown action '${args.action}'. Available: ${available}`)
          }

          const message = await action.run()
          return { title: message, output: JSON.stringify({ plugin: args.plugin, action: args.action, message }, null, 2) }
        },
      }),
    },
  }
}
