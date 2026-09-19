/**
 * Bark notification engine.
 *
 * Configuration lives at `~/.config/opencode/bark-notify.json`; the dsh and
 * Codex config files are migrated on first read, and the pre-template shape
 * (boolean `types`, plain `devices`) is upgraded in memory on every read.
 * Uses only `node:` builtins and `fetch`.
 *
 * Each notification type owns a message template and its Bark presentation,
 * and each subscriber may override any type independently, so one device can
 * stay silent for an event another device announces.
 */

import fsp from "node:fs/promises"
import path from "node:path"
import { LEGACY, STATE } from "./paths.ts"

export const BARK_BASE = "https://api.day.app"
export const TYPE_IDS = ["taskDone", "question", "approval", "error", "start", "quit"] as const

/** Bark interruption levels, least to most intrusive. `passive` pushes silently. */
export const LEVELS = ["passive", "active", "timeSensitive", "critical"] as const

/** Placeholders a title or body template may contain. */
export const TEMPLATE_KEYS = [
  "session_title",
  "complete_summary",
  "request_error",
  "permission_title",
  "permission_type",
  "permission_pattern",
  "directory",
  "session_id",
  "event",
  "time",
] as const

export type TypeID = (typeof TYPE_IDS)[number]
export type Level = (typeof LEVELS)[number]
export type TemplateKey = (typeof TEMPLATE_KEYS)[number]

/** The renderable context one event supplies to a template. */
export type Context = Partial<Record<TemplateKey, string>>

/**
 * How a notification's text is produced.
 *
 * `template` renders the configured title/body locally — deterministic, free,
 * and always available. `llm` asks a configured model to compress the same
 * rendered text down to something a notification banner can show; it costs a
 * request and can fail, so it falls back to the template result.
 */
export const PARSE_MODES = ["template", "llm"] as const
export type ParseMode = (typeof PARSE_MODES)[number]

/** Per-type info-parsing configuration. */
export type Parsing = {
  mode: ParseMode
  /** Strip Markdown from the rendered body. Applies to both modes. */
  stripMarkdown: boolean
  /** `providerID/modelID`; empty uses the plugin-wide default. */
  model: string
  /** Extra instruction appended to the summarizer's system prompt. */
  prompt: string
  /** Character budget the summary must fit into. */
  maxChars: number
}

/** How one notification type is presented. Templates render into title/body. */
export type Presentation = {
  enabled: boolean
  level: Level
  sound: string
  icon: string
  group: string
  title: string
  body: string
  parsing: Parsing
}

/** A subscriber's override for one type; absent fields inherit the type. */
export type Profile = Partial<Presentation>

export type Subscriber = { key: string; label: string; enabled: boolean; profiles: Partial<Record<TypeID, Profile>> }

export type State = {
  mode: "work" | "away"
  subscribers: Subscriber[]
  types: Record<TypeID, Presentation>
  /** `providerID/modelID` used by any type whose own model is empty. */
  defaultModel: string
}

/** Away-mode entries store the context, so a later template edit still applies. */
export type Queued = { kind: TypeID; context: Context; at: number }
export type Delivery = { key: string; ok: boolean; status: number; error?: string }

/**
 * Per-type defaults. `start` and `quit` are passive so session bookkeeping
 * never lights up the screen; anything awaiting a human is timeSensitive.
 */
/** Default parsing for a type. Only long, free-form bodies benefit from an LLM. */
function defaultParsing(mode: ParseMode = "template"): Parsing {
  return { mode, stripMarkdown: false, model: "", prompt: "", maxChars: 160 }
}

export function defaultTypes(): Record<TypeID, Presentation> {
  const base = { sound: "", icon: "", group: "opencode" }
  return {
    // An assistant's final message is the one body that is long and Markdown-
    // heavy, so it is the only type that strips Markdown by default.
    taskDone: {
      ...base,
      enabled: true,
      level: "active",
      title: "✅ <session_title>",
      body: "<complete_summary>",
      parsing: { ...defaultParsing(), stripMarkdown: true },
    },
    question: {
      ...base,
      enabled: true,
      level: "timeSensitive",
      title: "❓ 需要你的回应",
      body: "<session_title>",
      parsing: defaultParsing(),
    },
    approval: {
      ...base,
      enabled: true,
      level: "timeSensitive",
      title: "🔐 等待授权：<permission_type>",
      body: "<permission_title>\n<permission_pattern>\n<session_title>",
      parsing: defaultParsing(),
    },
    error: {
      ...base,
      enabled: true,
      level: "timeSensitive",
      title: "⚠️ 出错：<session_title>",
      body: "<request_error>",
      parsing: defaultParsing(),
    },
    start: { ...base, enabled: true, level: "passive", title: "🚀 会话开始", body: "<session_title>", parsing: defaultParsing() },
    quit: { ...base, enabled: true, level: "passive", title: "👋 会话结束", body: "<session_title>", parsing: defaultParsing() },
  }
}

function defaults(): State {
  return { mode: "work", subscribers: [], types: defaultTypes(), defaultModel: "" }
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/** Read a stored override, keeping only the fields actually present. */
function parseProfile(raw: unknown): Profile {
  const out: Profile = {}
  if (!raw || typeof raw !== "object") return out
  const value = raw as Record<string, unknown>
  if (typeof value.enabled === "boolean") out.enabled = value.enabled
  if (LEVELS.includes(value.level as Level)) out.level = value.level as Level
  for (const field of ["sound", "icon", "group", "title", "body"] as const) {
    if (typeof value[field] === "string") out[field] = value[field] as string
  }
  return out
}

/** Read stored parsing config over the supplied defaults. */
function parseParsing(raw: unknown, base: Parsing): Parsing {
  const out = { ...base }
  if (!raw || typeof raw !== "object") return out
  const value = raw as Record<string, unknown>
  if (PARSE_MODES.includes(value.mode as ParseMode)) out.mode = value.mode as ParseMode
  if (typeof value.stripMarkdown === "boolean") out.stripMarkdown = value.stripMarkdown
  if (typeof value.model === "string") out.model = value.model
  if (typeof value.prompt === "string") out.prompt = value.prompt
  if (typeof value.maxChars === "number" && Number.isFinite(value.maxChars)) {
    out.maxChars = Math.min(2000, Math.max(20, Math.round(value.maxChars)))
  }
  return out
}

function parse(text: string): State | null {
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null

  const state = defaults()
  if (parsed.mode === "work" || parsed.mode === "away") state.mode = parsed.mode

  // `devices` is the pre-template name for `subscribers`.
  const rawSubscribers = Array.isArray(parsed.subscribers) ? parsed.subscribers : parsed.devices
  if (Array.isArray(rawSubscribers)) {
    for (const entry of rawSubscribers) {
      if (!entry || typeof entry !== "object") continue
      const key = readString(entry.key).trim()
      if (!key) continue
      const profiles: Partial<Record<TypeID, Profile>> = {}
      if (entry.profiles && typeof entry.profiles === "object") {
        for (const id of TYPE_IDS) {
          const profile = parseProfile(entry.profiles[id])
          if (Object.keys(profile).length > 0) profiles[id] = profile
        }
      }
      state.subscribers.push({
        key,
        label: readString(entry.label).trim() || key.slice(0, 8),
        enabled: entry.enabled !== false,
        profiles,
      })
    }
  }

  if (typeof parsed.defaultModel === "string") state.defaultModel = parsed.defaultModel.trim()

  if (parsed.types && typeof parsed.types === "object") {
    for (const id of TYPE_IDS) {
      const raw = parsed.types[id]
      // The pre-template shape stored a bare boolean per type.
      if (typeof raw === "boolean") {
        state.types[id].enabled = raw
        continue
      }
      const parsing = parseParsing((raw as any)?.parsing, state.types[id].parsing)
      Object.assign(state.types[id], parseProfile(raw))
      state.types[id].parsing = parsing
    }
  }

  return state
}

// ── info parsing ───────────────────────────────────────────────────────────

/**
 * Strip Markdown to plain text for a notification banner.
 *
 * Bark renders no Markdown, so syntax that survives is noise: fenced code
 * becomes a `[code]` marker rather than a wall of source, and links keep their
 * text and drop the URL. This is deliberately a small, predictable transform,
 * not a parser — it runs on every push and must never throw.
 */
export function stripMarkdown(text: string): string {
  return String(text ?? "")
    // Fenced blocks first, so their content cannot be mistaken for prose.
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/~~~[\s\S]*?~~~/g, " [code] ")
    .replace(/`([^`]+)`/g, "$1")
    // Images before links: an image is a link with a leading `!`.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, " ")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/^\s*(\d+)\.\s+/gm, "$1. ")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

/** Collapse whitespace and truncate to `max` characters with an ellipsis. */
export function clamp(text: string, max: number): string {
  const collapsed = String(text ?? "").replace(/\s+/g, " ").trim()
  if (collapsed.length <= max) return collapsed
  return collapsed.slice(0, Math.max(1, max - 1)).trimEnd() + "…"
}

/** Read config, migrating the dsh/Codex files the first time through. */
export async function loadState(): Promise<State> {
  for (const file of [STATE.barkConfig, LEGACY.codexBarkConfig, LEGACY.barkConfig]) {
    try {
      const state = parse(await fsp.readFile(file, "utf8"))
      if (state) return state
    } catch {
      // Try the next candidate.
    }
  }
  return defaults()
}

export async function saveState(state: State): Promise<void> {
  await fsp.mkdir(path.dirname(STATE.barkConfig), { recursive: true })
  const payload = {
    mode: state.mode,
    defaultModel: state.defaultModel,
    subscribers: state.subscribers,
    types: state.types,
  }
  await fsp.writeFile(STATE.barkConfig, JSON.stringify(payload, null, 2) + "\n", "utf8")
}

// ── templates ──────────────────────────────────────────────────────────────

/**
 * Substitute `<placeholder>` tokens from `context`. A known key with no value
 * renders empty and its line is dropped; an unknown key is left verbatim so a
 * typo stays visible instead of silently deleting text.
 */
export function render(template: string, context: Context): string {
  const filled = String(template ?? "").replace(/<([a-z_]+)>/g, (whole, key: string) => {
    if (!TEMPLATE_KEYS.includes(key as TemplateKey)) return whole
    return context[key as TemplateKey] ?? ""
  })
  return filled
    .split("\n")
    .filter((line) => line.trim() !== "")
    .join("\n")
    .trim()
}

/** Merge a type's defaults with one subscriber's override for that type. */
export function resolveProfile(state: State, kind: TypeID, subscriber: Subscriber): Presentation {
  const base = state.types[kind]
  const override = subscriber.profiles?.[kind] ?? {}
  const merged: Presentation = { ...base, ...override }
  // An empty override string means "inherit", not "blank".
  for (const field of ["title", "body", "sound", "icon", "group"] as const) {
    if (readString(override[field]).trim() === "") merged[field] = base[field]
  }
  return merged
}

/** Whether `kind` reaches `subscriber`: the type and the profile must agree. */
export function subscribes(state: State, kind: TypeID, subscriber: Subscriber): boolean {
  if (!subscriber.enabled) return false
  if (state.types[kind].enabled === false) return false
  return subscriber.profiles?.[kind]?.enabled !== false
}

// ── push ───────────────────────────────────────────────────────────────────

export function buildURL(key: string, title: string, body: string, options: Partial<Presentation> = {}): string {
  const segments = [key, title]
  if (body) segments.push(body)
  const url = new URL(BARK_BASE + "/" + segments.map(encodeURIComponent).join("/"))
  for (const field of ["level", "sound", "icon", "group"] as const) {
    const value = readString(options[field]).trim()
    if (value !== "") url.searchParams.set(field, value)
  }
  return url.toString()
}

async function push(key: string, title: string, body: string, options: Partial<Presentation> = {}): Promise<Delivery> {
  try {
    const response = await fetch(buildURL(key, title, body, options), { method: "GET" })
    return { key, ok: response.status >= 200 && response.status < 300, status: response.status }
  } catch (error) {
    return { key, ok: false, status: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Push one literal title/body to every enabled subscriber. */
export async function deliver(
  state: State,
  title: string,
  body: string,
  options: Partial<Presentation> = {},
): Promise<Delivery[]> {
  return Promise.all(
    state.subscribers.filter((subscriber) => subscriber.enabled).map((s) => push(s.key, title, body, options)),
  )
}

/**
 * Compresses a rendered body for a notification banner.
 *
 * Supplied by the plugin, which owns provider credentials; the engine stays
 * free of network and config concerns. Returning null means "could not
 * summarize", and the caller keeps the template result.
 */
export type Summarizer = (input: { text: string; parsing: Parsing; kind: TypeID }) => Promise<string | null>

/**
 * Apply a type's info parsing to an already-rendered body.
 *
 * Markdown stripping runs first so the model never sees syntax it would have
 * to ignore, and so template mode benefits from it too. An LLM failure falls
 * back to the clamped template text: a notification with a blunt body beats
 * no notification at all.
 */
export async function parseBody(
  body: string,
  parsing: Parsing,
  kind: TypeID,
  summarize?: Summarizer,
): Promise<string> {
  const cleaned = parsing.stripMarkdown ? stripMarkdown(body) : body
  if (parsing.mode !== "llm" || !summarize) return clamp(cleaned, parsing.maxChars)
  if (cleaned.trim() === "") return ""
  // Already short enough: a request would cost latency and buy nothing.
  if (cleaned.length <= parsing.maxChars) return clamp(cleaned, parsing.maxChars)

  try {
    const summary = await summarize({ text: cleaned, parsing, kind })
    if (summary && summary.trim() !== "") return clamp(summary, parsing.maxChars)
  } catch {
    // Fall through to the template result.
  }
  return clamp(cleaned, parsing.maxChars)
}

/**
 * Render and push one event. Each subscriber resolves its own profile, so
 * titles, bodies, levels, icons and the per-type toggle are per device.
 * Subscribers that opted out of this type are omitted from the results.
 *
 * Bodies are parsed per distinct rendered text rather than per subscriber, so
 * two devices sharing a template cost one summarization, not two.
 */
export async function deliverEvent(
  state: State,
  kind: TypeID,
  context: Context,
  summarize?: Summarizer,
): Promise<Delivery[]> {
  const targets = state.subscribers.filter((subscriber) => subscribes(state, kind, subscriber))
  const parsed = new Map<string, string>()

  const results: Delivery[] = []
  for (const subscriber of targets) {
    const profile = resolveProfile(state, kind, subscriber)
    const rendered = render(profile.body, context)
    const cacheKey = `${profile.parsing.mode}:${profile.parsing.stripMarkdown}:${profile.parsing.maxChars}:${rendered}`
    if (!parsed.has(cacheKey)) parsed.set(cacheKey, await parseBody(rendered, profile.parsing, kind, summarize))
    results.push(await push(subscriber.key, render(profile.title, context), parsed.get(cacheKey)!, profile))
  }
  return results
}

// ── away-mode queue ────────────────────────────────────────────────────────
// In `away` mode notifications are parked on disk instead of pushed, so they
// survive across restarts and can be replayed when the mode returns to `work`.
// The context is queued rather than the rendered text, so a template edited
// while away applies when the queue is finally flushed.

export async function loadQueue(): Promise<Queued[]> {
  try {
    const parsed = JSON.parse(await fsp.readFile(STATE.barkQueue, "utf8"))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function saveQueue(items: Queued[]): Promise<void> {
  await fsp.mkdir(path.dirname(STATE.barkQueue), { recursive: true })
  await fsp.writeFile(STATE.barkQueue, JSON.stringify(items, null, 2) + "\n", "utf8")
}

export async function enqueue(kind: TypeID, context: Context): Promise<number> {
  const items = await loadQueue()
  items.push({ kind, context, at: Date.now() })
  await saveQueue(items)
  return items.length
}

export async function flushQueue(state: State): Promise<Delivery[]> {
  const items = await loadQueue()
  const results: Delivery[] = []
  for (const item of items) {
    // Entries written before templates carried rendered title/body instead.
    const legacy = item as unknown as { title?: string; body?: string }
    if (item.context === undefined && typeof legacy.title === "string") {
      results.push(...(await deliver(state, legacy.title, legacy.body ?? "")))
    } else {
      results.push(...(await deliverEvent(state, item.kind, item.context ?? {})))
    }
  }
  await saveQueue([])
  return results
}

/**
 * Emit one event notification, honouring the enabled types and focus mode.
 * Returns null when no subscriber wants the type, a queue marker when away,
 * and the per-device results when delivered.
 */
export async function emit(
  state: State,
  kind: TypeID,
  context: Context,
): Promise<{ queued: number } | Delivery[] | null> {
  if (!state.subscribers.some((subscriber) => subscribes(state, kind, subscriber))) return null
  if (state.mode !== "work") return { queued: await enqueue(kind, context) }
  return deliverEvent(state, kind, context)
}

export function summarize(results: Delivery[]): string {
  if (results.length === 0) return "没有匹配的订阅者"
  const ok = results.filter((entry) => entry.ok).length
  return ok === results.length ? `已发送到 ${ok} 台设备` : `已发送到 ${ok}/${results.length} 台设备`
}
