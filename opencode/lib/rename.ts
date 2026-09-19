/**
 * Session renaming — config, prompt rendering and the model call.
 *
 * opencode titles a session from its first prompt and never revisits it, so a
 * session that started as "fix the failing test" is still called that after it
 * became three hours of scheduler work. The title is the only thing the session
 * picker shows, which makes a stale one the difference between finding old work
 * and not.
 *
 * The rename is a small, bounded job — read the last few turns, emit one line —
 * so it is handed to a cheap model the user picks, kept away from whatever
 * model is driving the session itself. With no model configured there is
 * nothing to do the work, so the plugin stays inert rather than guessing: a
 * parser-derived title would be no better than the one opencode already wrote.
 */

import fsp from "node:fs/promises"
import path from "node:path"
import { CONFIG_DIR } from "./paths.ts"

/** Sentinel meaning "no model", which leaves the plugin inactive. */
export const NO_MODEL = ""

/** A rename must never hold up the session that just went idle. */
const TIMEOUT_MS = 20_000

/** Placeholders the prompt template understands. */
export const TEMPLATE_KEYS = ["transcript", "current_title", "directory", "session_id", "max_length"] as const

export type TemplateKey = (typeof TEMPLATE_KEYS)[number]
export type Context = Partial<Record<TemplateKey, string>>

/**
 * When a completed turn is allowed to rewrite the title.
 *
 * `always` keeps the title tracking what the session has become; `placeholder`
 * only fills in a title that says nothing, for anyone who names sessions by
 * hand and does not want that overwritten.
 */
export type Mode = "always" | "placeholder"

export type Config = {
  /** `providerID/modelID`, or "" for none — which disables the plugin. */
  model: string
  /** Instruction sent to the model; owns the format of the title. */
  prompt: string
  mode: Mode
  /** Sessions shorter than this are not worth a model call. */
  minMessages: number
  /** Titles are clipped to this many characters. */
  maxLength: number
  /** How many recent turns are shown to the model. */
  recentTurns: number
  /** Minimum gap between two renames of the same session. */
  cooldownSeconds: number
}

export const DEFAULT_PROMPT = [
  "Rename this coding session so it can be found again months later.",
  "Reply with the new title on a single line and nothing else.",
  "",
  "Rules:",
  "- at most <max_length> characters",
  "- name the concrete artefact, feature or bug the session is about",
  "- imperative mood, no trailing period, no quotes, no markdown",
  "- prefer what the session became over what it was first asked",
  "",
  "Current title: <current_title>",
  "Directory: <directory>",
  "",
  "Recent conversation:",
  "<transcript>",
].join("\n")

export const DEFAULTS: Config = {
  model: NO_MODEL,
  prompt: DEFAULT_PROMPT,
  mode: "always",
  minMessages: 4,
  maxLength: 60,
  recentTurns: 8,
  cooldownSeconds: 300,
}

const CONFIG_PATH = path.join(CONFIG_DIR, "session-rename.json")

export function configPath(): string {
  return CONFIG_PATH
}

export async function load(): Promise<Config> {
  try {
    const parsed = JSON.parse(await fsp.readFile(CONFIG_PATH, "utf8"))
    if (!parsed || typeof parsed !== "object") return { ...DEFAULTS }
    return {
      // An explicit "" means "no model"; only an absent key takes the default.
      model: typeof parsed.model === "string" ? parsed.model.trim() : DEFAULTS.model,
      // An empty prompt would ask the model for nothing, so it falls back.
      prompt: typeof parsed.prompt === "string" && parsed.prompt.trim() !== "" ? parsed.prompt : DEFAULTS.prompt,
      mode: parsed.mode === "placeholder" ? "placeholder" : DEFAULTS.mode,
      minMessages: clamp(parsed.minMessages, 0, 200, DEFAULTS.minMessages),
      maxLength: clamp(parsed.maxLength, 16, 200, DEFAULTS.maxLength),
      recentTurns: clamp(parsed.recentTurns, 1, 50, DEFAULTS.recentTurns),
      cooldownSeconds: clamp(parsed.cooldownSeconds, 0, 86_400, DEFAULTS.cooldownSeconds),
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

export async function save(patch: Partial<Config>): Promise<Config> {
  const next = { ...(await load()), ...patch }
  await fsp.mkdir(path.dirname(CONFIG_PATH), { recursive: true })
  const temp = CONFIG_PATH + ".tmp"
  await fsp.writeFile(temp, JSON.stringify(next, null, 2) + "\n", "utf8")
  await fsp.rename(temp, CONFIG_PATH)
  return next
}

/* ------------------------------------------------------------------ *
 * Prompt
 * ------------------------------------------------------------------ */

/**
 * Substitute the placeholders into the user's prompt.
 *
 * A known placeholder with no value renders empty; an unknown one is left
 * verbatim so a typo stays visible instead of silently vanishing.
 */
export function render(template: string, context: Context): string {
  return template.replace(/<([a-z_]+)>/g, (match, key: string) =>
    (TEMPLATE_KEYS as readonly string[]).includes(key) ? context[key as TemplateKey] ?? "" : match,
  )
}

/** Turns as the model sees them: speaker-labelled, trimmed, oldest first. */
export function formatTranscript(turns: Array<{ role: string; text: string }>, budget = 6000): string {
  const lines = turns.map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text.replace(/\s+/g, " ").trim()}`)
  // Keep the newest turns when the budget runs out: they say what the session
  // has become, which is the whole point of renaming it.
  const out: string[] = []
  let used = 0
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].slice(0, 1200)
    if (used + line.length > budget) break
    out.unshift(line)
    used += line.length
  }
  return out.join("\n")
}

/**
 * Turn a model reply into a usable title, or null when it is not one.
 *
 * Small models like to answer with `Title: "…"`, a markdown heading, or a
 * paragraph of reasoning. The first is worth salvaging; the last is not a title
 * at all, and using it would be worse than leaving the old one in place.
 */
export function sanitizeTitle(reply: string, maxLength: number): string | null {
  const first = String(reply ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "" && !/^```/.test(line))
  if (!first) return null

  let title = first
    .replace(/^#{1,6}\s*/, "")
    .replace(/^(?:new\s+)?title\s*[:：]\s*/i, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.。]+$/, "")
    .trim()

  if (title.length < 3) return null
  // A reply that overruns the length it was given by this much is commentary,
  // not a title obeying the instruction, and clipping it would only produce a
  // truncated sentence.
  if (title.length > maxLength * 2) return null
  if (title.length > maxLength) {
    const cut = title.slice(0, maxLength)
    const space = cut.lastIndexOf(" ")
    title = (space > maxLength * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")
  }
  return title
}

/* ------------------------------------------------------------------ *
 * Model call
 * ------------------------------------------------------------------ */

type Client = {
  session: {
    create(options: { body?: any; query?: { directory?: string } }): Promise<{ error?: unknown; data?: any }>
    prompt(options: { path: { id: string }; body: any; query?: { directory?: string } }): Promise<{ error?: unknown; data?: any }>
    delete(options: { path: { id: string }; query?: { directory?: string } }): Promise<{ error?: unknown; data?: unknown }>
  }
  config?: { providers(): Promise<{ data?: any }> }
}

/** Title of the throwaway session the rename runs in. */
export const SCRATCH_TITLE = "session-rename: proposing a title"

/**
 * Sessions this plugin created to do its own work.
 *
 * A scratch session goes idle like any other, and renaming it would start a
 * rename that creates another scratch session, so they are remembered and
 * skipped. Module state is per process, which is the same scope as the
 * scratch sessions themselves.
 */
const SCRATCH = new Set<string>()

export function isScratch(sessionID: string): boolean {
  return SCRATCH.has(sessionID)
}

/**
 * Ask the model for a title, in a scratch session that is deleted afterwards.
 *
 * The session being renamed must not be perturbed by having been read, so the
 * prompt is never sent to it: a title would otherwise appear in the user's own
 * transcript as though they had asked for one.
 */
export async function proposeTitle(input: {
  client: Client
  model: string
  directory: string | null
  prompt: string
  maxLength: number
}): Promise<string | null> {
  const [providerID, ...rest] = input.model.split("/")
  const modelID = rest.join("/")
  if (!providerID || !modelID) return null

  const query = input.directory ? { directory: input.directory } : undefined
  let sessionID: string | null = null

  try {
    const created = await input.client.session.create({ body: { title: SCRATCH_TITLE }, ...(query ? { query } : {}) })
    sessionID = created?.data?.id ?? null
    if (!sessionID) return null
    SCRATCH.add(sessionID)

    const response = await withTimeout(
      input.client.session.prompt({
        path: { id: sessionID },
        body: { model: { providerID, modelID }, parts: [{ type: "text", text: input.prompt }] },
        ...(query ? { query } : {}),
      }),
    )
    if (!response || response.error) return null

    return sanitizeTitle(extractText(response.data), input.maxLength)
  } catch {
    return null
  } finally {
    if (sessionID) {
      await input.client.session.delete({ path: { id: sessionID }, ...(query ? { query } : {}) }).catch(() => {})
      SCRATCH.delete(sessionID)
    }
  }
}

function extractText(data: any): string {
  const parts = data?.parts ?? data?.message?.parts ?? []
  if (!Array.isArray(parts)) return ""
  return parts
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
    .trim()
}

function withTimeout<T>(promise: Promise<T>): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS))])
}

/**
 * Models offered by the Settings dropdown.
 *
 * "none" is always first, since that is what turns the plugin off, and the
 * configured model is always present even when its provider is unreachable — a
 * dropdown that silently dropped the saved value would look like the setting
 * had been lost.
 */
export async function modelOptions(client: Client, current: string): Promise<Array<{ value: string; label: string }>> {
  const options = [{ value: NO_MODEL, label: "none — renaming off" }]
  const seen = new Set<string>()

  try {
    const response = await client.config?.providers()
    for (const provider of (response?.data?.providers ?? []) as any[]) {
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
