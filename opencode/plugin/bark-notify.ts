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
import * as Scratch from "../lib/scratch.ts"
import * as Logs from "../lib/logs.ts"
import { STATE } from "../lib/paths.ts"

const PLUGIN_ID = "bark-notify"

/** Events worth a log line even when there is nobody to notify. */
const LIFECYCLE = new Set(["session.idle", "session.error", "permission.updated"])

/** Shared across instances, so the startup line is written once per process. */
const LOADED_KEY = Symbol.for("@dsh/opencode-bark-notify-loaded")

/**
 * Title of the throwaway session a compact summary runs in.
 *
 * Registered centrally so the task queue does not adopt it and session-rename
 * does not retitle it — see `scratch.ts` for what happens otherwise.
 */
const SCRATCH_TITLE = Scratch.register("bark-notify: compacting")

/** A summary must never hold up a notification. */
const SUMMARY_TIMEOUT_MS = 15_000

export const BarkNotify: Plugin = async ({ client }) => {
  const state = await Bark.loadState()
  await Registry.init()

  const log = (message: string, level: Logs.Level = "info") => {
    // Both sinks: opencode's own stream cannot be read back, so the dashboard's
    // Logging tab needs its own copy or it stays empty.
    Logs.log(PLUGIN_ID, message, level)
    client.app.log({ body: { service: PLUGIN_ID, level, message } }).catch(() => {})
  }

  /**
   * Models offered for compacting, read from opencode's own provider list.
   *
   * The configured model is always present even when its provider is currently
   * unreachable, so a dropdown never silently discards a saved value.
   */
  async function summaryModelOptions(current: string) {
    const options = [{ value: "", label: "(none — truncate instead)" }]
    const seen = new Set<string>()

    try {
      const response = await client.config.providers()
      for (const provider of ((response as any)?.data?.providers ?? []) as any[]) {
        for (const model of Object.values(provider?.models ?? {}) as any[]) {
          const id = `${provider.id}/${model.id}`
          if (seen.has(id)) continue
          seen.add(id)
          options.push({ value: id, label: `${provider.name ?? provider.id} · ${model.name ?? model.id}` })
        }
      }
    } catch {
      // Fall through to whatever is configured.
    }

    if (current && !seen.has(current)) options.push({ value: current, label: `${current} (not currently available)` })
    return options
  }

  /**
   * Compact a rendered body with a model, in a scratch session deleted after.
   *
   * Returning null on any failure is deliberate: `parseBody` then falls back to
   * truncation, so a notification is never lost to a summariser problem.
   */
  const summarizer: Bark.Summarizer = async ({ text, parsing, kind }) => {
    const model = parsing.model || (await Bark.loadState()).defaultModel
    const [providerID, ...rest] = model.split("/")
    const modelID = rest.join("/")
    if (!providerID || !modelID) return null

    let sessionID: string | null = null
    try {
      const created = await client.session.create({ body: { title: SCRATCH_TITLE } } as any)
      sessionID = (created as any)?.data?.id ?? null
      if (!sessionID) return null

      const instruction =
        `Compress this ${kind} notification to at most ${parsing.maxChars} characters. ` +
        "Reply with the compressed text only: no preamble, quotes, or Markdown. " +
        "Keep concrete identifiers (file paths, error codes, commands) over prose." +
        (parsing.prompt ? `\n\nAlso: ${parsing.prompt}` : "") +
        `\n\n${text}`

      const response = await Promise.race([
        client.session.prompt({
          path: { id: sessionID },
          body: { model: { providerID, modelID }, parts: [{ type: "text", text: instruction }] },
        } as any),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), SUMMARY_TIMEOUT_MS)),
      ])
      if (!response || (response as any).error) return null

      const parts = (response as any)?.data?.parts ?? []
      const reply = (Array.isArray(parts) ? parts : [])
        .filter((part: any) => part?.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("\n")
        .trim()
      return reply === "" ? null : reply
    } catch {
      return null
    } finally {
      if (sessionID) await client.session.delete({ path: { id: sessionID } } as any).catch(() => {})
    }
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
     * One collapsed section per notification type, then one per subscriber.
     *
     * Six types times eleven fields is unreadable as a flat list, so each type
     * owns a `group` the dashboard renders collapsed. Subscribers get the same
     * treatment, which is what lets the device list be managed here — added,
     * renamed, muted per type, removed — instead of only through `bark_device`.
     */
    async settings() {
      const fresh = await Bark.loadState()
      const placeholders = Bark.TEMPLATE_KEYS.map((key) => `<${key}>`).join(", ")
      const modelOptions = await summaryModelOptions(fresh.defaultModel)

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
        {
          key: "defaultModel",
          label: "Default summarizer model",
          type: "select" as const,
          value: fresh.defaultModel,
          options: modelOptions,
          description: "Used by any type set to LLM compact that has no model of its own.",
        },

        // ── one collapsed section per notification type ──────────────────
        ...Bark.TYPE_IDS.flatMap((id) => {
          const type = fresh.types[id]
          const group = `${id} notification`
          const modeKey = `types.${id}.parsing.mode`
          return [
            {
              group,
              key: `types.${id}.enabled`,
              label: "Enabled",
              type: "boolean" as const,
              value: type.enabled !== false,
              description: `Send ${id} notifications.`,
            },
            {
              group,
              key: `types.${id}.title`,
              label: "Title template",
              type: "string" as const,
              value: type.title,
              placeholder: "✅ <session_title>",
              description: `Placeholders: ${placeholders}`,
            },
            {
              group,
              key: `types.${id}.body`,
              label: "Body template",
              type: "string" as const,
              value: type.body,
              multiline: true,
              placeholder: "<complete_summary>",
              description: "An empty known placeholder drops its line.",
            },
            {
              group,
              key: modeKey,
              label: "Info parsing",
              type: "select" as const,
              value: type.parsing.mode,
              options: [
                { value: "template", label: "template — render the script only" },
                { value: "llm", label: "LLM compact — summarize to fit" },
              ],
              description: "How the body text is produced before it is pushed.",
            },
            {
              group,
              key: `types.${id}.parsing.stripMarkdown`,
              label: "Remove Markdown",
              type: "boolean" as const,
              value: type.parsing.stripMarkdown,
              description: "Strip Markdown syntax; Bark renders none of it.",
            },
            {
              group,
              key: `types.${id}.parsing.maxChars`,
              label: "Max characters",
              type: "number" as const,
              value: type.parsing.maxChars,
              min: 20,
              max: 2000,
              description: "Budget for the body. Longer text is summarized, or truncated if that fails.",
            },
            {
              group,
              key: `types.${id}.parsing.model`,
              label: "Summarizer model",
              type: "select" as const,
              value: type.parsing.model,
              options: [{ value: "", label: "(use the default model)" }, ...modelOptions.slice(1)],
              // Only meaningful in llm mode, so it stays hidden otherwise.
              when: { key: modeKey, equals: ["llm"] },
              description: "Overrides the default model for this type only.",
            },
            {
              group,
              key: `types.${id}.parsing.prompt`,
              label: "Summarizer prompt",
              type: "string" as const,
              value: type.parsing.prompt,
              multiline: true,
              when: { key: modeKey, equals: ["llm"] },
              placeholder: "Keep the file paths and the error code.",
              description: "Extra instruction appended to the summarizer's prompt.",
            },
            {
              group,
              key: `types.${id}.level`,
              label: "Interruption level",
              type: "select" as const,
              value: type.level,
              options: Bark.LEVELS.map((level) => ({
                value: level,
                label: level === "passive" ? "passive — silent" : level,
              })),
              description: "passive pushes without a sound or banner.",
            },
            {
              group,
              key: `types.${id}.sound`,
              label: "Sound",
              type: "string" as const,
              value: type.sound,
              placeholder: "(app default)",
              description: "Bark sound name; empty uses the app default.",
            },
            {
              group,
              key: `types.${id}.icon`,
              label: "Icon",
              type: "string" as const,
              value: type.icon,
              placeholder: "https://…/icon.png",
              description: "HTTPS URL of a custom push icon.",
            },
            {
              group,
              key: `types.${id}.group`,
              label: "Bark group",
              type: "string" as const,
              value: type.group,
              placeholder: "opencode",
              description: "Bark group used to cluster notifications.",
            },
          ]
        }),

        // Subscribers are managed entirely on the Info tab's Subscribers
        // table — added, renamed, tested, removed, and muted per type — where
        // every device and every switch is visible at once. A collapsed
        // section per device hid exactly the comparison the table makes
        // trivial: which devices receive a given notification.
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
        if (value === "work" && wasAway) await Bark.flushQueue(fresh, summarizer)
        return
      }

      if (key === "defaultModel") {
        fresh.defaultModel = String(value ?? "")
        await Bark.saveState(fresh)
        Object.assign(state, fresh)
        return
      }

      // Parsing lives one level deeper than the presentation fields, so it is
      // matched first — `types.error.parsing.mode` would otherwise be read as
      // a presentation field called "parsing".
      const parsing = /^types\.([^.]+)\.parsing\.([^.]+)$/.exec(key)
      if (parsing) {
        const id = parsing[1] as Bark.TypeID
        const field = parsing[2]
        if (!Bark.TYPE_IDS.includes(id)) throw new Error(`unknown type: ${id}`)
        const target = fresh.types[id].parsing

        if (field === "mode") {
          if (!Bark.PARSE_MODES.includes(value as Bark.ParseMode)) throw new Error(`unknown parse mode: ${String(value)}`)
          target.mode = value as Bark.ParseMode
        } else if (field === "stripMarkdown") target.stripMarkdown = value === true
        else if (field === "maxChars") {
          const chars = Number(value)
          if (!Number.isFinite(chars)) throw new Error("maxChars must be a number")
          target.maxChars = Math.min(2000, Math.max(20, Math.round(chars)))
        } else if (field === "model" || field === "prompt") target[field] = String(value ?? "")
        else throw new Error(`unknown parsing field: ${field}`)

        await Bark.saveState(fresh)
        Object.assign(state, fresh)
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

      // A device key may contain dots, so the type suffix is matched from the
      // end rather than splitting the key on every separator.
      const perType = /^subscribers\.(.+)\.types\.([^.]+)$/.exec(key)
      if (perType) {
        const subscriber = fresh.subscribers.find((entry) => entry.key === perType[1])
        if (!subscriber) throw new Error("subscriber not found")
        const id = perType[2] as Bark.TypeID
        if (!Bark.TYPE_IDS.includes(id)) throw new Error(`unknown type: ${id}`)

        subscriber.profiles ??= {}
        const profile = (subscriber.profiles[id] ??= {})
        if (value === true) {
          // Inheriting is the default state, so an enabled type drops the
          // override rather than storing a redundant `enabled: true`.
          delete profile.enabled
          if (Object.keys(profile).length === 0) delete subscriber.profiles[id]
        } else profile.enabled = false

        await Bark.saveState(fresh)
        Object.assign(state, fresh)
        return
      }

      const subscriberField = /^subscribers\.(.+)\.(enabled|label)$/.exec(key)
      if (subscriberField) {
        const subscriber = fresh.subscribers.find((entry) => entry.key === subscriberField[1])
        if (!subscriber) throw new Error("subscriber not found")

        if (subscriberField[2] === "enabled") subscriber.enabled = value === true
        else {
          const label = String(value ?? "").trim()
          if (!label) throw new Error("label cannot be empty")
          subscriber.label = label
        }

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
          // A table rather than cards: every device carries the same six
          // switches, and the only useful question — which devices get
          // `approval`? — is answered by reading one column down the page.
          type: "table" as const,
          // On the Settings tab, because this *is* configuration: the rows
          // edit who receives what. Its table shape says how a list of devices
          // is best read, not that it became read-only information.
          tab: "settings" as const,
          noun: "subscriber",
          columns: [
            { label: "key" },
            { label: "on" },
            ...Bark.TYPE_IDS.map((id) => ({ label: id })),
          ],
          description:
            "One row per device. The type columns mute a notification on that device alone; " +
            "device keys are never shown, only the last four characters.",
          empty: "No subscribers yet — use Add subscriber above.",
          // Adding is not an operation on any row, so it sits on the header.
          action: "add-subscriber",
          items: fresh.subscribers.map((subscriber) => {
            const overrides = Object.keys(subscriber.profiles ?? {})
            const muted = overrides.filter((id) => subscriber.profiles?.[id as Bark.TypeID]?.enabled === false)

            return {
              title: subscriber.label,
              subtitle: muted.length ? `muted: ${muted.join(", ")}` : "inherits every type default",
              tone: subscriber.enabled ? ("ok" as const) : ("muted" as const),
              fields: [
                // Enough of the key to identify the device, never enough to push to it.
                { label: "key", value: "…" + subscriber.key.slice(-4) },
              ],
              controls: [
                // Delivery for the whole device, then one switch per type. Each
                // names the column it belongs in, so the table lays them out
                // under their headings instead of as a row of buttons.
                {
                  type: "toggle" as const,
                  action: "set-subscriber-enabled",
                  label: `Deliver to ${subscriber.label}`,
                  column: "on",
                  input: subscriber.key,
                  value: subscriber.enabled,
                },
                ...Bark.TYPE_IDS.map((id) => ({
                  type: "toggle" as const,
                  action: "set-subscriber-type",
                  label: `${subscriber.label} receives ${id}`,
                  column: id,
                  input: `${subscriber.key}:${id}`,
                  value: subscriber.profiles?.[id]?.enabled !== false,
                })),
                {
                  type: "prompt" as const,
                  action: "rename-subscriber",
                  label: "Rename",
                  // The action needs both the device and its new name, so the
                  // key is carried in `input` and the name is appended.
                  input: subscriber.key,
                  prompt: `New name for ${subscriber.label}:`,
                  value: subscriber.label,
                },
                {
                  type: "button" as const,
                  action: "test-subscriber",
                  label: "Test",
                  input: subscriber.key,
                },
                {
                  type: "button" as const,
                  action: "remove-subscriber",
                  label: "Remove",
                  input: subscriber.key,
                  danger: true,
                  confirm: `Remove ${subscriber.label}? Its device key is deleted from the configuration.`,
                },
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
            const results = await Bark.deliverEvent(fresh, id, sampleContext(id), summarizer)
            lines.push(`${id}: ${Bark.summarize(results)}`)
          }
          return lines.join("; ")
        },
      },
      "add-subscriber": {
        label: "Add subscriber",
        async run(input) {
          const raw = String(input ?? "").trim()
          if (!raw) throw new Error("device key cannot be empty")
          // The Bark app shows a full URL; accept it and keep only the key.
          const key = raw.replace(/^https?:\/\/[^/]+\//, "").replace(/\/.*$/, "").trim()
          if (!key) throw new Error("device key cannot be empty")

          const fresh = await Bark.loadState()
          if (fresh.subscribers.some((entry) => entry.key === key)) throw new Error("that device is already added")

          fresh.subscribers.push({ key, label: `设备 ${key.slice(0, 6)}`, enabled: true, profiles: {} })
          await Bark.saveState(fresh)
          Object.assign(state, fresh)
          log(`added subscriber ${key.slice(0, 6)}…`)
          return `已添加设备 ${key.slice(0, 6)}…`
        },
      },
      "remove-subscriber": {
        label: "Remove subscriber",
        // Reached from the subscriber's own row, which supplies the key. The
        // Settings button row passes no argument, so a copy there is dead.
        hidden: true,
        async run(input) {
          const key = String(input ?? "").trim()
          const fresh = await Bark.loadState()
          const before = fresh.subscribers.length
          fresh.subscribers = fresh.subscribers.filter((entry) => entry.key !== key)
          if (fresh.subscribers.length === before) throw new Error("subscriber not found")

          await Bark.saveState(fresh)
          Object.assign(state, fresh)
          log(`removed subscriber ${key.slice(0, 6)}…`)
          return `已删除设备 ${key.slice(0, 6)}…`
        },
      },
      "set-subscriber-enabled": {
        label: "Deliver to a subscriber",
        hidden: true,
        /**
         * A table toggle sends `<key>=<true|false>`.
         *
         * The requested state is sent rather than toggled here, so two rapid
         * clicks cannot leave the switch and the config disagreeing about
         * which one won.
         */
        async run(input) {
          const raw = String(input ?? "")
          const split = raw.lastIndexOf("=")
          if (split < 0) throw new Error("expected <device key>=<true|false>")

          const key = raw.slice(0, split).trim()
          const enabled = raw.slice(split + 1).trim() === "true"

          const fresh = await Bark.loadState()
          const subscriber = fresh.subscribers.find((entry) => entry.key === key)
          if (!subscriber) throw new Error("subscriber not found")

          subscriber.enabled = enabled
          await Bark.saveState(fresh)
          Object.assign(state, fresh)
          log(`${enabled ? "enabled" : "muted"} subscriber ${subscriber.label}`)
          return enabled ? `已启用 ${subscriber.label}` : `已静音 ${subscriber.label}`
        },
      },
      "set-subscriber-type": {
        label: "Mute one type on one subscriber",
        hidden: true,
        /** A column toggle sends `<key>:<type>=<true|false>`. */
        async run(input) {
          const raw = String(input ?? "")
          const split = raw.lastIndexOf("=")
          if (split < 0) throw new Error("expected <device key>:<type>=<true|false>")

          const target = raw.slice(0, split)
          const enabled = raw.slice(split + 1).trim() === "true"
          // A device key may contain ':', so the type is taken from the end.
          const colon = target.lastIndexOf(":")
          if (colon < 0) throw new Error("expected <device key>:<type>")

          const key = target.slice(0, colon).trim()
          const id = target.slice(colon + 1).trim() as Bark.TypeID
          if (!Bark.TYPE_IDS.includes(id)) throw new Error(`unknown type: ${id}`)

          const fresh = await Bark.loadState()
          const subscriber = fresh.subscribers.find((entry) => entry.key === key)
          if (!subscriber) throw new Error("subscriber not found")

          subscriber.profiles ??= {}
          const profile = (subscriber.profiles[id] ??= {})
          if (enabled) delete profile.enabled
          else profile.enabled = false
          // An override that says nothing is noise in the config file.
          if (Object.keys(profile).length === 0) delete subscriber.profiles[id]

          await Bark.saveState(fresh)
          Object.assign(state, fresh)
          return `${subscriber.label}: ${id} ${enabled ? "启用" : "静音"}`
        },
      },
      "rename-subscriber": {
        label: "Rename subscriber",
        hidden: true,
        /**
         * A row control carries its device in `input` and appends the value the
         * prompt collected, as `<key>=<label>`. A device key never contains
         * `=`, so the first one separates the two.
         */
        async run(input) {
          const raw = String(input ?? "")
          const split = raw.indexOf("=")
          if (split < 0) throw new Error("rename needs a device key and a name")

          const key = raw.slice(0, split).trim()
          const label = raw.slice(split + 1).trim()
          if (!label) throw new Error("name cannot be empty")

          const fresh = await Bark.loadState()
          const subscriber = fresh.subscribers.find((entry) => entry.key === key)
          if (!subscriber) throw new Error("subscriber not found")

          const previous = subscriber.label
          subscriber.label = label
          await Bark.saveState(fresh)
          Object.assign(state, fresh)
          log(`renamed subscriber "${previous}" → "${label}"`)
          return `已重命名为 ${label}`
        },
      },
      "test-subscriber": {
        label: "Send a test push to one subscriber",
        hidden: true,
        async run(input) {
          const key = String(input ?? "").trim()
          const fresh = await Bark.loadState()
          const subscriber = fresh.subscribers.find((entry) => entry.key === key)
          if (!subscriber) throw new Error("subscriber not found")

          // Deliver to this device alone, so a test proves one phone works
          // rather than pushing to every device to check one of them.
          const only: Bark.State = { ...fresh, subscribers: [{ ...subscriber, enabled: true }] }
          const results = await Bark.deliverEvent(only, "taskDone", sampleContext("taskDone"), summarizer)
          return `${subscriber.label}: ${Bark.summarize(results)}`
        },
      },
      flush: {
        label: "Flush queue",
        async run() {
          const flushed = await Bark.flushQueue(await Bark.loadState(), summarizer)
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

  // Announce once per process, not once per project instance, or 40+ copies of
  // the same line bury everything else.
  if (!(globalThis as Record<symbol, unknown>)[LOADED_KEY]) {
    ;(globalThis as Record<symbol, unknown>)[LOADED_KEY] = true
    const enabled = Bark.TYPE_IDS.filter((id) => state.types[id]?.enabled !== false)
    log(
      `loaded — ${state.subscribers.length} subscriber(s), ` +
        `${enabled.length}/${Bark.TYPE_IDS.length} types enabled, mode=${state.mode}`,
    )
    if (state.subscribers.length === 0) log("no subscribers configured — nothing will be pushed", "warn")
  }

  return {
    /** Map opencode lifecycle events onto Bark notification types. */
    event: async ({ event }) => {
      // opencode cannot unload a plugin, so a disabled plugin stays loaded and
      // simply stops acting. This is what makes the dashboard toggle immediate.
      if (!Registry.isEnabled(PLUGIN_ID)) return

      const properties = (event as any).properties ?? {}

      // Logged before the subscriber check, so the tab shows the lifecycle
      // even on a machine with no devices configured — "nothing happened" and
      // "nothing could happen" look identical otherwise.
      if (event.type === "session.created" || event.type === "session.updated") {
        log(`${event.type} ${properties.sessionID ?? ""}`.trim())
        return
      }

      if (state.subscribers.length === 0) {
        if (LIFECYCLE.has(event.type)) log(`${event.type} ignored — no subscribers configured`)
        return
      }

      // Re-read so a template edited from the dashboard applies to this push.
      const fresh = await Bark.loadState()

      if (event.type === "session.idle") {
        log(`session.idle ${properties.sessionID ?? ""} — sending taskDone`.trim())
        await Bark.emit(fresh, "taskDone", await contextFor(properties.sessionID, { event: event.type }), summarizer)
        return
      }
      if (event.type === "session.error") {
        const error = properties.error
        const detail = error?.data?.message || error?.name || "未知错误"
        log(`session.error ${properties.sessionID ?? ""}: ${detail}`.trim(), "warn")
        await Bark.emit(
          fresh,
          "error",
          await contextFor(properties.sessionID, { event: event.type, request_error: summarizeText(detail, 300) }),
          summarizer,
        )
        return
      }
      // `permission.updated` is what opencode publishes when a permission is
      // raised; there is no `permission.asked`. The payload is the Permission
      // itself, which is the only place that says what is being approved — the
      // session title alone cannot tell the two apart.
      if (event.type === "permission.updated") {
        const pattern = Array.isArray(properties.pattern) ? properties.pattern.join(", ") : properties.pattern
        log(`permission.updated — ${String(properties.type ?? "permission")} awaiting approval`)
        await Bark.emit(
          fresh,
          "approval",
          await contextFor(properties.sessionID, {
            event: event.type,
            permission_title: summarizeText(properties.title ?? "", 200),
            permission_type: String(properties.type ?? ""),
            permission_pattern: summarizeText(pattern ?? "", 120),
          }),
          summarizer,
        )
        return
      }
      if (event.type === "server.connected") {
        await Bark.emit(fresh, "start", { event: event.type, time: new Date().toLocaleString() }, summarizer)
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
            const flushed = await Bark.flushQueue(state, summarizer)
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
          const flushed = await Bark.flushQueue(state, summarizer)
          return {
            title: flushed.length === 0 ? "没有待发通知" : `已补发 ${flushed.length} 条通知`,
            output: JSON.stringify({ flushed: flushed.length, state: await snapshot() }, null, 2),
          }
        },
      }),
    },
  }
}
