/**
 * bark-notify — Bark push notifications for opencode lifecycle events.
 *
 * Ports the dsh `dsh-bark-notify` / codex `bark-notify` plugins. The Codex
 * `notify` shell hook is replaced by opencode's `event` hook, so no external
 * wiring in a config file is needed: session.idle, session.error and
 * permission.asked map onto the same notification types as before.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import * as Bark from "../lib/bark.ts"
import * as Registry from "../lib/registry.ts"
import { STATE } from "../lib/paths.ts"

export const BarkNotify: Plugin = async ({ client }) => {
  const state = await Bark.loadState()
  await Registry.init()

  const log = (message: string) => {
    client.app.log({ body: { service: "bark-notify", level: "info", message } }).catch(() => {})
  }

  /** Collapse whitespace and truncate, so a push stays readable on a lock screen. */
  const summarizeText = (text: string, max: number) => {
    const collapsed = String(text ?? "").replace(/\s+/g, " ").trim()
    return collapsed.length <= max ? collapsed : collapsed.slice(0, max - 1) + "…"
  }

  /**
   * Representative context for one type, used by the test push, the preview
   * tool and the Info panel so all three show the same thing. Values mirror
   * the shape of a real event rather than generic filler, so a template that
   * renders badly here renders badly in production too.
   */
  function sampleContext(kind: Bark.TypeID): Bark.Context {
    const base: Bark.Context = {
      session_title: "示例：为 Bark 增加模板设置",
      directory: "D:\\Documents\\Github\\deepseek-harness",
      session_id: "ses_example0000000000000000",
      event: "test",
      time: new Date().toLocaleString(),
    }
    if (kind === "taskDone") return { ...base, complete_summary: "已为每个通知类型加入模板、推送参数与订阅者档案。" }
    if (kind === "error") return { ...base, request_error: "exceeded retry limit, last status: 429 Too Many Requests" }
    if (kind === "approval") {
      return {
        ...base,
        permission_title: "Run: git push origin master",
        permission_type: "bash",
        permission_pattern: "git push*",
      }
    }
    return base
  }

  /**
   * Build the template context for a session event.
   *
   * The session title and the final assistant message are what make a push
   * worth reading, and neither is on the event payload, so both are fetched.
   * A failed lookup degrades to an empty placeholder rather than losing the
   * notification.
   */
  async function contextFor(sessionID: string | undefined, extra: Bark.Context = {}): Promise<Bark.Context> {
    const context: Bark.Context = { time: new Date().toLocaleString(), session_id: sessionID ?? "", ...extra }
    if (!sessionID) return context

    try {
      const session = await client.session.get({ path: { id: sessionID } })
      const info = (session as any)?.data
      if (info) {
        context.session_title = summarizeText(info.title ?? "", 60)
        context.directory = info.directory ?? ""
      }
    } catch {
      // Session lookup failed; the title placeholder stays empty.
    }

    if (context.complete_summary === undefined) {
      try {
        const messages = await client.session.messages({ path: { id: sessionID } })
        const list = ((messages as any)?.data ?? []) as Array<{ info?: any; parts?: any[] }>
        // The newest assistant text part is the answer the turn ended on.
        for (let index = list.length - 1; index >= 0; index--) {
          if (list[index]?.info?.role !== "assistant") continue
          const text = (list[index].parts ?? [])
            .filter((part) => part?.type === "text" && !part.synthetic && typeof part.text === "string")
            .map((part) => part.text)
            .join(" ")
          if (text.trim() !== "") {
            context.complete_summary = summarizeText(text, 300)
            break
          }
        }
      } catch {
        // Message lookup failed; the summary placeholder stays empty.
      }
    }
    return context
  }

  // Expose settings + status to the manager dashboard.
  Registry.register({
    id: "bark-notify",
    title: "Bark Notify",
    description: "Push opencode lifecycle events to your phone via Bark.",
    /**
     * Settings are grouped per notification type: the toggle, then the
     * message templates, then the Bark presentation. Subscriber-specific
     * overrides are edited with `bark_profile`, since the dashboard renders a
     * flat field list and a per-device matrix would not fit it.
     */
    async settings() {
      const fresh = await Bark.loadState()
      const placeholders = Bark.TEMPLATE_KEYS.map((key) => `<${key}>`).join(", ")

      return [
        {
          key: "mode",
          label: "Focus mode",
          type: "select" as const,
          value: fresh.mode,
          options: [
            { value: "work", label: "work — push immediately" },
            { value: "away", label: "away — queue until back" },
          ],
          description: "In away mode notifications are queued instead of pushed.",
        },
        ...Bark.TYPE_IDS.flatMap((id) => {
          const type = fresh.types[id]
          return [
            {
              key: `types.${id}.enabled`,
              label: `${id} — enabled`,
              type: "boolean" as const,
              value: type.enabled !== false,
              description: `Send ${id} notifications.`,
            },
            {
              key: `types.${id}.title`,
              label: `${id} — title`,
              type: "string" as const,
              value: type.title,
              placeholder: "✅ <session_title>",
              description: `Title template. Placeholders: ${placeholders}`,
            },
            {
              key: `types.${id}.body`,
              label: `${id} — body`,
              type: "string" as const,
              value: type.body,
              placeholder: "<complete_summary>",
              description: "Body template. An empty placeholder drops its line.",
            },
            {
              key: `types.${id}.level`,
              label: `${id} — level`,
              type: "select" as const,
              value: type.level,
              options: Bark.LEVELS.map((level) => ({
                value: level,
                label: level === "passive" ? "passive — silent" : level,
              })),
              description: "Bark interruption level. passive pushes without a sound or banner.",
            },
            {
              key: `types.${id}.sound`,
              label: `${id} — sound`,
              type: "string" as const,
              value: type.sound,
              placeholder: "(app default)",
              description: "Bark sound name; empty uses the app default.",
            },
            {
              key: `types.${id}.icon`,
              label: `${id} — icon`,
              type: "string" as const,
              value: type.icon,
              placeholder: "https://…/icon.png",
              description: "HTTPS URL of a custom push icon.",
            },
            {
              key: `types.${id}.group`,
              label: `${id} — group`,
              type: "string" as const,
              value: type.group,
              placeholder: "opencode",
              description: "Bark group used to cluster notifications.",
            },
          ]
        }),
      ]
    },
    async update(key, value) {
      const fresh = await Bark.loadState()

      if (key === "mode") {
        if (value !== "work" && value !== "away") throw new Error("mode must be work or away")
        const wasAway = fresh.mode === "away"
        fresh.mode = value
        await Bark.saveState(fresh)
        Object.assign(state, fresh)
        if (value === "work" && wasAway) await Bark.flushQueue(fresh)
        return
      }

      const match = /^types\.([^.]+)\.([^.]+)$/.exec(key)
      if (match) {
        const id = match[1] as Bark.TypeID
        const field = match[2]
        if (!Bark.TYPE_IDS.includes(id)) throw new Error(`unknown type: ${id}`)
        const type = fresh.types[id]

        if (field === "enabled") type.enabled = value === true
        else if (field === "level") {
          if (!Bark.LEVELS.includes(value as Bark.Level)) throw new Error(`unknown level: ${String(value)}`)
          type.level = value as Bark.Level
        } else if (field === "title" || field === "body" || field === "sound" || field === "icon" || field === "group") {
          type[field] = String(value ?? "")
        } else throw new Error(`unknown field: ${field}`)

        await Bark.saveState(fresh)
        Object.assign(state, fresh)
        return
      }

      throw new Error(`unknown setting: ${key}`)
    },
    async status() {
      const fresh = await Bark.loadState()
      const queue = await Bark.loadQueue()
      const enabled = fresh.subscribers.filter((subscriber) => subscriber.enabled).length
      const custom = fresh.subscribers.filter((s) => Object.keys(s.profiles ?? {}).length > 0).length
      return [
        { label: "subscribers", value: `${enabled}/${fresh.subscribers.length}`, tone: enabled > 0 ? "ok" : "warn" },
        { label: "profiles", value: custom, tone: "muted" },
        { label: "queued", value: queue.length, tone: queue.length > 0 ? "warn" : "muted" },
        { label: "mode", value: fresh.mode, tone: fresh.mode === "work" ? "ok" : "muted" },
      ]
    },
    /** Shows what each type renders to, so a template can be checked at a glance. */
    async panels() {
      const fresh = await Bark.loadState()
      return [
        {
          key: "templates",
          title: "Rendered templates",
          description: "Each type rendered with sample data. Placeholders: " + Bark.TEMPLATE_KEYS.map((k) => `<${k}>`).join(", "),
          items: Bark.TYPE_IDS.map((id) => {
            const type = fresh.types[id]
            const sample = sampleContext(id)
            return {
              title: Bark.render(type.title, sample) || "(empty title)",
              subtitle: Bark.render(type.body, sample) || "(empty body)",
              tone: type.enabled === false ? ("muted" as const) : ("ok" as const),
              group: id,
              fields: [
                { label: "type", value: id },
                { label: "level", value: type.level },
                { label: "enabled", value: type.enabled === false ? "no" : "yes" },
                { label: "group", value: type.group || "—" },
              ],
            }
          }),
        },
        {
          key: "subscribers",
          title: "Subscribers",
          description: "Device keys are never shown. Per-type overrides are edited with the bark_profile tool.",
          empty: "No subscribers yet — add one with the bark_device tool.",
          items: fresh.subscribers.map((subscriber) => {
            const overrides = Object.keys(subscriber.profiles ?? {})
            return {
              title: subscriber.label,
              subtitle: overrides.length ? `overrides: ${overrides.join(", ")}` : "inherits every type default",
              tone: subscriber.enabled ? ("ok" as const) : ("muted" as const),
              fields: [
                { label: "enabled", value: subscriber.enabled ? "yes" : "no" },
                { label: "muted types", value: String(overrides.filter((id) => subscriber.profiles[id as Bark.TypeID]?.enabled === false).length) },
              ],
            }
          }),
        },
      ]
    },
    actions: {
      test: {
        label: "Send test push",
        async run() {
          const fresh = await Bark.loadState()
          // Push every enabled type through its own template, so the test
          // proves what each notification will actually look like.
          const enabled = Bark.TYPE_IDS.filter((id) => fresh.types[id].enabled !== false)
          if (enabled.length === 0) return "没有启用的通知类型"

          const lines: string[] = []
          for (const id of enabled) {
            const results = await Bark.deliverEvent(fresh, id, sampleContext(id))
            lines.push(`${id}: ${Bark.summarize(results)}`)
          }
          return lines.join("; ")
        },
      },
      flush: {
        label: "Flush queue",
        async run() {
          const flushed = await Bark.flushQueue(await Bark.loadState())
          return flushed.length === 0 ? "没有待发通知" : `已补发 ${flushed.length} 条通知`
        },
      },
    },
  })

  async function snapshot() {
    return {
      configPath: STATE.barkConfig,
      mode: state.mode,
      templateKeys: Bark.TEMPLATE_KEYS,
      levels: Bark.LEVELS,
      types: { ...state.types },
      // Keys are credentials; the label identifies a subscriber instead.
      subscribers: state.subscribers.map((subscriber) => ({
        label: subscriber.label,
        enabled: subscriber.enabled,
        profiles: subscriber.profiles,
      })),
      pending: (await Bark.loadQueue()).map((item) => ({ kind: item.kind, at: item.at })),
    }
  }

  return {
    /** Map opencode lifecycle events onto Bark notification types. */
    event: async ({ event }) => {
      // opencode cannot unload a plugin, so a disabled plugin stays loaded and
      // simply stops acting. This is what makes the dashboard toggle immediate.
      if (!Registry.isEnabled("bark-notify")) return
      if (state.subscribers.length === 0) return

      // Re-read so a template edited from the dashboard applies to this push.
      const fresh = await Bark.loadState()
      const properties = (event as any).properties ?? {}

      if (event.type === "session.idle") {
        await Bark.emit(fresh, "taskDone", await contextFor(properties.sessionID, { event: event.type }))
        return
      }
      if (event.type === "session.error") {
        const error = properties.error
        const detail = error?.data?.message || error?.name || "未知错误"
        await Bark.emit(
          fresh,
          "error",
          await contextFor(properties.sessionID, { event: event.type, request_error: summarizeText(detail, 300) }),
        )
        return
      }
      // `permission.updated` is what opencode publishes when a permission is
      // raised; there is no `permission.asked`. The payload is the Permission
      // itself, which is the only place that says what is being approved — the
      // session title alone cannot tell the two apart.
      if (event.type === "permission.updated") {
        const pattern = Array.isArray(properties.pattern) ? properties.pattern.join(", ") : properties.pattern
        await Bark.emit(
          fresh,
          "approval",
          await contextFor(properties.sessionID, {
            event: event.type,
            permission_title: summarizeText(properties.title ?? "", 200),
            permission_type: String(properties.type ?? ""),
            permission_pattern: summarizeText(pattern ?? "", 120),
          }),
        )
        return
      }
      if (event.type === "server.connected") {
        await Bark.emit(fresh, "start", { event: event.type, time: new Date().toLocaleString() })
      }
    },

    tool: {
      bark_send: tool({
        description: "Push a Bark notification to all enabled devices immediately, bypassing the focus mode.",
        args: {
          title: tool.schema.string().describe("Notification title."),
          body: tool.schema.string().optional().describe("Notification body text."),
        },
        async execute(args) {
          const results = await Bark.deliver(state, args.title, args.body ?? "")
          return { title: Bark.summarize(results), output: JSON.stringify(results, null, 2) }
        },
      }),

      bark_state: tool({
        description:
          "Return the current Bark configuration: focus mode, per-type templates and push options, subscribers with " +
          "their per-type overrides, and the away-mode queue.",
        args: {},
        async execute() {
          return {
            title: `mode=${state.mode}, ${state.subscribers.length} subscribers`,
            output: JSON.stringify(await snapshot(), null, 2),
          }
        },
      }),

      bark_set_mode: tool({
        description:
          'Set the focus mode. "work" pushes immediately; "away" queues event notifications until you return to work, ' +
          "at which point the queue is flushed automatically.",
        args: { mode: tool.schema.enum(["work", "away"]).describe("Target focus mode.") },
        async execute(args) {
          const wasAway = state.mode === "away"
          state.mode = args.mode
          await Bark.saveState(state)

          if (args.mode === "work" && wasAway) {
            const flushed = await Bark.flushQueue(state)
            log(`switched to work, flushed ${flushed.length}`)
            return {
              title: "已切换到工作模式",
              output: JSON.stringify({ flushed: flushed.length, state: await snapshot() }, null, 2),
            }
          }
          return { title: `已切换到${args.mode === "away" ? "离开" : "工作"}模式`, output: JSON.stringify(await snapshot(), null, 2) }
        },
      }),

      bark_set_type: tool({
        description:
          "Configure one notification type: its toggle, message templates, and Bark presentation. These are the " +
          "defaults every subscriber inherits. Templates accept " +
          Bark.TEMPLATE_KEYS.map((key) => `<${key}>`).join(", ") +
          "; an empty known placeholder drops its line.",
        args: {
          id: tool.schema.enum(Bark.TYPE_IDS).describe("Notification type."),
          enabled: tool.schema.boolean().optional().describe("Whether the type is enabled."),
          title: tool.schema.string().optional().describe("Title template."),
          body: tool.schema.string().optional().describe("Body template."),
          level: tool.schema.enum(Bark.LEVELS).optional().describe("Interruption level; passive pushes silently."),
          sound: tool.schema.string().optional().describe("Bark sound name."),
          icon: tool.schema.string().optional().describe("HTTPS icon URL."),
          group: tool.schema.string().optional().describe("Bark group name."),
        },
        async execute(args) {
          const fresh = await Bark.loadState()
          const type = fresh.types[args.id]
          if (args.enabled !== undefined) type.enabled = args.enabled
          for (const field of ["title", "body", "level", "sound", "icon", "group"] as const) {
            if (args[field] !== undefined) (type as any)[field] = args[field]
          }
          await Bark.saveState(fresh)
          Object.assign(state, fresh)
          return { title: `已更新 ${args.id}`, output: JSON.stringify(type, null, 2) }
        },
      }),

      bark_profile: tool({
        description:
          "Override one notification type for one subscriber, so a single device can stay silent for an event the " +
          "others announce. Omitted fields, and empty template strings, inherit the type defaults. Use reset to " +
          "drop the override.",
        args: {
          key: tool.schema.string().describe("Subscriber device key."),
          id: tool.schema.enum(Bark.TYPE_IDS).describe("Notification type to override."),
          reset: tool.schema.boolean().optional().describe("Drop the override and inherit the type defaults."),
          enabled: tool.schema.boolean().optional().describe("Whether this subscriber receives this type."),
          title: tool.schema.string().optional().describe("Title template for this subscriber."),
          body: tool.schema.string().optional().describe("Body template for this subscriber."),
          level: tool.schema.enum(Bark.LEVELS).optional().describe("Interruption level for this subscriber."),
          sound: tool.schema.string().optional().describe("Bark sound name."),
          icon: tool.schema.string().optional().describe("HTTPS icon URL."),
          group: tool.schema.string().optional().describe("Bark group name."),
        },
        async execute(args) {
          const fresh = await Bark.loadState()
          const subscriber = fresh.subscribers.find((entry) => entry.key === args.key.trim())
          if (!subscriber) throw new Error("订阅者不存在")

          if (args.reset === true) {
            delete subscriber.profiles[args.id]
          } else {
            const profile = subscriber.profiles[args.id] ?? {}
            if (args.enabled !== undefined) profile.enabled = args.enabled
            for (const field of ["title", "body", "level", "sound", "icon", "group"] as const) {
              if (args[field] !== undefined) (profile as any)[field] = args[field]
            }
            subscriber.profiles[args.id] = profile
          }

          await Bark.saveState(fresh)
          Object.assign(state, fresh)
          return {
            title: `已更新 ${subscriber.label} 的 ${args.id}`,
            output: JSON.stringify(subscriber.profiles[args.id] ?? { inherits: true }, null, 2),
          }
        },
      }),

      bark_preview: tool({
        description: "Render one notification type without sending it, to check a template.",
        args: { id: tool.schema.enum(Bark.TYPE_IDS).describe("Notification type to render.") },
        async execute(args) {
          const fresh = await Bark.loadState()
          const sample = sampleContext(args.id)
          const previews = fresh.subscribers.map((subscriber) => {
            const profile = Bark.resolveProfile(fresh, args.id, subscriber)
            return {
              subscriber: subscriber.label,
              willSend: Bark.subscribes(fresh, args.id, subscriber),
              title: Bark.render(profile.title, sample),
              body: Bark.render(profile.body, sample),
              level: profile.level,
            }
          })
          const type = fresh.types[args.id]
          return {
            title: Bark.render(type.title, sample) || `(${args.id} has an empty title)`,
            output: JSON.stringify(
              { context: sample, typeDefault: { title: Bark.render(type.title, sample), body: Bark.render(type.body, sample) }, previews },
              null,
              2,
            ),
          }
        },
      }),

      bark_device: tool({
        description:
          "Manage Bark devices: add a device by key (the segment after https://api.day.app/ in the Bark app), " +
          "remove one, or enable/disable one.",
        args: {
          action: tool.schema.enum(["add", "remove", "enable", "disable"]).describe("What to do."),
          key: tool.schema.string().describe("Device key."),
          label: tool.schema.string().optional().describe("Display label, used by add."),
        },
        async execute(args) {
          const key = args.key.trim()
          if (!key) throw new Error("设备 Key 不能为空")
          const fresh = await Bark.loadState()

          if (args.action === "add") {
            if (fresh.subscribers.some((subscriber) => subscriber.key === key)) throw new Error("该设备已存在")
            fresh.subscribers.push({
              key,
              label: args.label?.trim() || `设备 ${key.slice(0, 6)}`,
              enabled: true,
              profiles: {},
            })
          } else if (args.action === "remove") {
            fresh.subscribers = fresh.subscribers.filter((subscriber) => subscriber.key !== key)
          } else {
            const subscriber = fresh.subscribers.find((entry) => entry.key === key)
            if (!subscriber) throw new Error("设备不存在")
            subscriber.enabled = args.action === "enable"
          }

          await Bark.saveState(fresh)
          Object.assign(state, fresh)
          return { title: `已${{ add: "添加", remove: "删除", enable: "启用", disable: "停用" }[args.action]}设备`, output: JSON.stringify(await snapshot(), null, 2) }
        },
      }),

      bark_flush: tool({
        description: "Immediately deliver all queued (away-mode) notifications.",
        args: {},
        async execute() {
          const flushed = await Bark.flushQueue(state)
          return {
            title: flushed.length === 0 ? "没有待发通知" : `已补发 ${flushed.length} 条通知`,
            output: JSON.stringify({ flushed: flushed.length, state: await snapshot() }, null, 2),
          }
        },
      }),
    },
  }
}
