/**
 * session-rename — retitle a session from what it actually did.
 *
 * opencode names a session from its first prompt and never revisits it, so the
 * picker fills up with titles describing the question that opened a session
 * rather than the work it turned into. Since the title is the only thing the
 * picker shows, a stale one is the difference between finding old work again
 * and not.
 *
 * When a turn completes the recent transcript is handed to a small model the
 * user chooses, under a prompt the user owns, and the answer becomes the new
 * title. The model is deliberately not the one driving the session: naming is a
 * one-line job that a cheap model does well and an expensive one should not be
 * paying for.
 *
 * With no model configured there is nothing to do the work, so the plugin
 * disables itself rather than guessing — a title derived by string-munging
 * would be no better than the one opencode already wrote.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import * as Rename from "../lib/rename.ts"
import * as Sessions from "../lib/session-store.ts"
import * as Registry from "../lib/registry.ts"
import * as Logs from "../lib/logs.ts"
import { isPlaceholderTitle } from "../lib/summarize.ts"

const PLUGIN_ID = "session-rename"

/** Why a session was passed over, or the title it was given. */
type Outcome = { sessionID: string; at: number; from: string; to: string | null; reason: string }

/**
 * Recent outcomes and the last time each session was renamed.
 *
 * Module state, which in this process is shared by every plugin instance:
 * opencode instantiates a plugin once per project directory, and the cooldown
 * has to hold across all of them or a session open in two projects would be
 * renamed twice in a row.
 */
const HISTORY: Outcome[] = []
const RENAMED_AT = new Map<string, number>()
/** Sessions being renamed right now, so overlapping idles make one call. */
const IN_FLIGHT = new Set<string>()

function record(outcome: Outcome): void {
  HISTORY.push(outcome)
  if (HISTORY.length > 50) HISTORY.splice(0, HISTORY.length - 50)
}

export const SessionRename: Plugin = async ({ client }) => {
  await Registry.init()

  const log = (message: string, level: Logs.Level = "info") => {
    Logs.log(PLUGIN_ID, message, level)
    client.app.log({ body: { service: PLUGIN_ID, level, message } }).catch(() => {})
  }

  /**
   * Without a model the plugin can do nothing, so it reads as disabled rather
   * than as enabled-but-silent.
   *
   * Only ever turns the plugin *off*: re-enabling at startup would undo a
   * toggle the user set by hand in the dashboard. Choosing a model is what
   * turns it back on, which is handled where that setting is written.
   */
  async function disableWithoutModel(model: string): Promise<void> {
    if (model !== Rename.NO_MODEL || !Registry.isEnabled(PLUGIN_ID)) return
    await Registry.setEnabled(PLUGIN_ID, false)
    log("disabled: no model configured")
  }

  await disableWithoutModel((await Rename.load()).model)

  /**
   * Build the prompt that will be sent for one session.
   *
   * Shared by the rename itself and the preview tool, so what the preview shows
   * is exactly what the model is asked.
   */
  function promptFor(config: Rename.Config, row: Sessions.SessionRow): string | null {
    const turns = Sessions.recentTurns(row.id, config.recentTurns)
    if (turns.length === 0) return null

    return Rename.render(config.prompt, {
      transcript: Rename.formatTranscript(turns),
      current_title: row.title,
      directory: row.directory,
      session_id: row.id,
      max_length: String(config.maxLength),
    })
  }

  /**
   * Rename one session, or explain why it was left alone.
   *
   * `force` is what the tool passes: asking for a rename by hand should not be
   * refused by the length threshold or the cooldown, which exist only to keep
   * the automatic path from calling a model for every trivial turn.
   */
  async function rename(sessionID: string, force = false): Promise<Outcome> {
    const config = await Rename.load()
    const outcome = (reason: string, to: string | null = null, from = ""): Outcome => {
      const result = { sessionID, at: Date.now(), from, to, reason }
      record(result)
      return result
    }

    if (config.model === Rename.NO_MODEL) return outcome("no model configured")
    // A scratch session is this plugin's own workspace; renaming it would start
    // a rename that creates another scratch session.
    if (Rename.isScratch(sessionID)) return outcome("scratch session")

    const row = Sessions.get(sessionID)
    if (!row) return outcome("session not found")
    if (row.title === Rename.SCRATCH_TITLE) return outcome("scratch session")
    // Subagent sessions are an implementation detail of their parent's turn and
    // never appear in the picker, so naming them serves nobody.
    if (row.parentID) return outcome("subagent session", null, row.title)

    if (!force) {
      if (config.mode === "placeholder" && !isPlaceholderTitle(row.title)) {
        return outcome("title already set", null, row.title)
      }
      if (Sessions.messageCount(sessionID) < config.minMessages) {
        return outcome(`fewer than ${config.minMessages} messages`, null, row.title)
      }
      const last = RENAMED_AT.get(sessionID)
      if (last !== undefined && Date.now() - last < config.cooldownSeconds * 1000) {
        return outcome("within cooldown", null, row.title)
      }
    }

    if (IN_FLIGHT.has(sessionID)) return outcome("already renaming", null, row.title)
    IN_FLIGHT.add(sessionID)

    try {
      const prompt = promptFor(config, row)
      if (!prompt) return outcome("nothing to summarise", null, row.title)

      const title = await Rename.proposeTitle({
        client: client as any,
        model: config.model,
        directory: row.directory || null,
        prompt,
        maxLength: config.maxLength,
      })

      // A model that timed out, failed or answered with prose leaves the
      // existing title alone: a wrong title is worse than a stale one.
      if (!title) return outcome("no usable title returned", null, row.title)
      if (title === row.title) {
        RENAMED_AT.set(sessionID, Date.now())
        return outcome("title unchanged", title, row.title)
      }

      const response = await client.session.update({
        path: { id: sessionID },
        body: { title },
        // The API is directory-scoped, so a session in another project is only
        // reachable when its own directory is named.
        ...(row.directory ? { query: { directory: row.directory } } : {}),
      })
      if (response.error) return outcome(`update failed: ${JSON.stringify(response.error).slice(0, 120)}`, null, row.title)

      RENAMED_AT.set(sessionID, Date.now())
      log(`renamed ${sessionID}: "${row.title}" → "${title}"`)
      return outcome("renamed", title, row.title)
    } finally {
      IN_FLIGHT.delete(sessionID)
    }
  }

  Registry.register({
    id: PLUGIN_ID,
    title: "Session Rename",
    description: "Retitle a session from its recent transcript using a small model you choose.",
    async settings() {
      const config = await Rename.load()
      const placeholders = Rename.TEMPLATE_KEYS.map((key) => `<${key}>`).join(", ")

      return [
        {
          key: "model",
          label: "Rename model",
          type: "select",
          value: config.model,
          options: await Rename.modelOptions(client as any, config.model),
          description: "Small model used to propose titles. With none selected the plugin disables itself.",
        },
        {
          key: "prompt",
          label: "Rename prompt",
          type: "string",
          value: config.prompt,
          placeholder: Rename.DEFAULT_PROMPT.split("\n")[0],
          description: `Instruction sent to the model; it owns the title format. Placeholders: ${placeholders}`,
        },
        {
          key: "mode",
          label: "When to rename",
          type: "select",
          value: config.mode,
          options: [
            { value: "always", label: "always — keep the title current" },
            { value: "placeholder", label: "placeholder — only name unnamed sessions" },
          ],
          description: "Whether a title that already says something may be replaced.",
        },
        {
          key: "minMessages",
          label: "Minimum messages",
          type: "number",
          value: config.minMessages,
          min: 0,
          max: 200,
          description: "Sessions shorter than this are left alone.",
        },
        {
          key: "maxLength",
          label: "Maximum title length",
          type: "number",
          value: config.maxLength,
          min: 16,
          max: 200,
          description: "Titles longer than this are clipped at a word boundary.",
        },
        {
          key: "recentTurns",
          label: "Turns read",
          type: "number",
          value: config.recentTurns,
          min: 1,
          max: 50,
          description: "How many recent turns the model is shown.",
        },
        {
          key: "cooldownSeconds",
          label: "Cooldown (s)",
          type: "number",
          value: config.cooldownSeconds,
          min: 0,
          max: 86400,
          description: "Minimum gap between two renames of the same session.",
        },
      ]
    },
    async update(key, value) {
      if (key === "model") {
        const model = String(value ?? "").trim()
        await Rename.save({ model })
        // Picking a model is the only thing that can turn the plugin on, so
        // that one choice is enough to start using it.
        if (model === Rename.NO_MODEL) await disableWithoutModel(model)
        else if (!Registry.isEnabled(PLUGIN_ID)) {
          await Registry.setEnabled(PLUGIN_ID, true)
          log(`enabled: renaming with ${model}`)
        }
        return
      }
      if (key === "prompt") {
        const prompt = String(value ?? "")
        // An empty prompt asks the model for nothing; restore the default
        // instead of silently disabling the feature.
        await Rename.save({ prompt: prompt.trim() === "" ? Rename.DEFAULT_PROMPT : prompt })
        return
      }
      if (key === "mode") {
        if (value !== "always" && value !== "placeholder") throw new Error("mode must be always or placeholder")
        await Rename.save({ mode: value })
        return
      }
      if (key === "minMessages" || key === "maxLength" || key === "recentTurns" || key === "cooldownSeconds") {
        const n = Number(value)
        if (!Number.isFinite(n)) throw new Error(`${key} must be a number`)
        await Rename.save({ [key]: n })
        return
      }
      throw new Error(`unknown setting: ${key}`)
    },
    async status() {
      const config = await Rename.load()
      const renamed = HISTORY.filter((entry) => entry.reason === "renamed").length
      return [
        {
          label: "model",
          value: config.model || "none",
          tone: config.model ? "ok" : "warn",
        },
        { label: "mode", value: config.mode, tone: "muted" },
        { label: "renamed", value: renamed, tone: renamed > 0 ? "ok" : "muted" },
        { label: "considered", value: HISTORY.length, tone: "muted" },
        {
          label: "state",
          value: config.model ? (Registry.isEnabled(PLUGIN_ID) ? "active" : "disabled") : "off (no model)",
          tone: config.model && Registry.isEnabled(PLUGIN_ID) ? "ok" : "warn",
        },
      ]
    },
    async panels() {
      const config = await Rename.load()
      return [
        {
          key: "prompt",
          title: "Rendered prompt",
          description:
            "The instruction as the model receives it, with sample values. Placeholders: " +
            Rename.TEMPLATE_KEYS.map((key) => `<${key}>`).join(", "),
          items: [
            {
              title: config.model || "no model configured",
              subtitle: Rename.render(config.prompt, {
                transcript: "User: the rename keeps firing on every turn\nAssistant: added a cooldown per session",
                current_title: "New session - 2026-09-19T03:07:10.578Z",
                directory: "D:\\Documents\\Github\\deepseek-harness",
                session_id: "ses_example0000000000000000",
                max_length: String(config.maxLength),
              }),
              tone: config.model ? "ok" : "warn",
              fields: [
                { label: "mode", value: config.mode },
                { label: "turns read", value: String(config.recentTurns) },
                { label: "max length", value: String(config.maxLength) },
              ],
            },
          ],
        },
        {
          key: "history",
          title: "Recent decisions",
          description: "Every session considered since opencode started, and what happened to it.",
          empty: "Nothing considered yet.",
          // Newest first: a rename that just fired is what anyone is looking for.
          items: [...HISTORY].reverse().map((entry) => ({
            title: entry.to ?? entry.from ?? entry.sessionID,
            subtitle: entry.to && entry.from ? `was: ${entry.from}` : entry.sessionID,
            group: entry.reason === "renamed" ? "renamed" : "skipped",
            tone: entry.reason === "renamed" ? ("ok" as const) : ("muted" as const),
            fields: [
              { label: "reason", value: entry.reason },
              { label: "at", value: new Date(entry.at).toLocaleTimeString() },
            ],
          })),
          filters: ["renamed", "skipped"],
        },
      ]
    },
  })

  return {
    event: async ({ event }) => {
      // opencode cannot unload a plugin, so a disabled one stays loaded and
      // simply stops acting. Without a model it is disabled by construction.
      if (!Registry.isEnabled(PLUGIN_ID)) return
      if (event.type !== "session.idle") return

      const sessionID = (event as any).properties?.sessionID
      if (typeof sessionID !== "string" || !sessionID) return

      // A rename is a convenience; failing to produce one must not disturb the
      // session that just finished. Routine skips are not logged — most turns
      // are one, and the Info tab already lists them.
      await rename(sessionID).catch((error) => {
        log(`rename failed for ${sessionID}: ${error instanceof Error ? error.message : String(error)}`, "warn")
      })
    },

    tool: {
      session_rename: tool({
        description:
          "Rename one session now by asking the configured model for a title from its recent transcript. " +
          "Ignores the length threshold and the cooldown that gate the automatic path.",
        args: {
          sessionID: tool.schema.string().describe("opencode session id to rename (ses_...)."),
        },
        async execute(args) {
          if (!Registry.isEnabled(PLUGIN_ID)) throw new Error("session-rename is disabled; configure a model first")
          const outcome = await rename(args.sessionID, true)
          return {
            title: outcome.to ? `renamed to: ${outcome.to}` : outcome.reason,
            output: JSON.stringify(outcome, null, 2),
          }
        },
      }),

      session_rename_preview: tool({
        description:
          "Render the rename prompt for one session without calling the model or changing the title, to check " +
          "the prompt template.",
        args: {
          sessionID: tool.schema.string().describe("opencode session id to render the prompt for (ses_...)."),
        },
        async execute(args) {
          const config = await Rename.load()
          const row = Sessions.get(args.sessionID)
          if (!row) throw new Error(`Unknown session: ${args.sessionID}`)

          const prompt = promptFor(config, row)
          return {
            title: prompt ? `prompt for "${row.title}"` : "nothing to summarise",
            output: JSON.stringify(
              { model: config.model || null, currentTitle: row.title, messages: Sessions.messageCount(row.id), prompt },
              null,
              2,
            ),
          }
        },
      }),

      session_rename_state: tool({
        description:
          "Return the session-rename configuration and what it has done since opencode started: the model, the " +
          "prompt template, and every session it considered.",
        args: {},
        async execute() {
          const config = await Rename.load()
          return {
            title: config.model ? `renaming with ${config.model}` : "off — no model configured",
            output: JSON.stringify(
              {
                configPath: Rename.configPath(),
                enabled: Registry.isEnabled(PLUGIN_ID),
                templateKeys: Rename.TEMPLATE_KEYS,
                config,
                history: [...HISTORY].reverse(),
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
