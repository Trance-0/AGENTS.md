/**
 * Titles and summaries for queued tasks.
 *
 * A task named "New session - 2026-09-19T02:42:59.433Z" tells you nothing about
 * what it is, which makes the queue unreadable exactly when it matters — when
 * several tasks are waiting and you have to decide which to keep.
 *
 * Two strategies, in order:
 *
 *   1. **A model**, when one is configured. Summarising a prompt is the kind of
 *      small, well-bounded job a cheap local model does well, so this is what
 *      the `summaryModel` setting selects. It is also the seam the planned
 *      auto-distribution work will reuse.
 *   2. **A plain parser** otherwise, and whenever the model is unavailable,
 *      slow or returns something unusable. It never leaves the process, so the
 *      queue keeps working with no model configured at all.
 *
 * The fallback is not a degraded mode to be avoided: it is the default, and the
 * model is an optional improvement on top of it.
 */

/** Sentinel meaning "no model — use the parser". Kept out of the model list. */
export const NO_MODEL = ""

/**
 * Title given to the throwaway session a model summary runs in.
 *
 * The task runner wraps every new session so it occupies a concurrency slot,
 * which would also wrap this one — and wrapping it queues a task, whose own
 * summary creates another scratch session, and so on. Exporting the title lets
 * the wrapper recognise and skip these, breaking the feedback loop at its
 * source rather than cleaning up after it.
 */
export const SCRATCH_TITLE = "task-queue summary"

/** Offered when nothing else is known; a small local model suits the job. */
export const SUGGESTED_MODEL = "freetoken/Qwen3.8-27B-NVFP4"

/** A model call must never hold up the queue. */
const TIMEOUT_MS = 20_000

const MAX_TITLE = 72

type Client = {
  session: {
    create(options: { body?: any; query?: { directory?: string } }): Promise<{ error?: unknown; data?: any }>
    prompt(options: { path: { id: string }; body: any; query?: { directory?: string } }): Promise<{ error?: unknown; data?: any }>
    delete(options: { path: { id: string }; query?: { directory?: string } }): Promise<{ error?: unknown; data?: unknown }>
  }
}

export type Summary = {
  title: string
  /** One-line description, or null when only a title could be derived. */
  detail: string | null
  source: "model" | "parser"
}

/* ------------------------------------------------------------------ *
 * Plain parser
 * ------------------------------------------------------------------ */

/** Chatter that carries no information about what the task actually is. */
const NOISE = [
  /^(please|pls|ok|okay|now|so|then|also|and|but|hi|hey|hello)\b[,:]?\s*/i,
  /^(can you|could you|would you|i want you to|i need you to|i'd like you to|let's|lets)\s+/i,
  /^(help me|assist me)\s+(to\s+)?/i,
]

/** A placeholder title carries no meaning, so it is worth replacing. */
export function isPlaceholderTitle(title: string): boolean {
  const text = title.trim()
  if (!text) return true
  if (/^new session\b/i.test(text)) return true
  if (/^session\s+[0-9a-z_-]+$/i.test(text)) return true
  if (/^untitled\b/i.test(text)) return true
  // A bare timestamp, with or without a label.
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/i.test(text)) return true
  return false
}

function tidy(text: string): string {
  let out = text.replace(/\s+/g, " ").trim()
  // Strip fenced code and inline markup, which read badly when truncated.
  out = out.replace(/```[\s\S]*?```/g, " ").replace(/`([^`]+)`/g, "$1")
  for (const pattern of NOISE) out = out.replace(pattern, "")
  return out.trim()
}

function clip(text: string, limit = MAX_TITLE): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  // Prefer a word boundary so the result does not end mid-word.
  const cut = trimmed.slice(0, limit)
  const space = cut.lastIndexOf(" ")
  return (space > limit * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "") + "…"
}

/**
 * Derive a title from the opening prompts without a model.
 *
 * The first sentence of the first real instruction is almost always the task,
 * so that is what this takes.
 */
export function parseSummary(prompts: string[]): Summary {
  const cleaned = prompts.map(tidy).filter((text) => text.length > 0)
  if (cleaned.length === 0) return { title: "Untitled task", detail: null, source: "parser" }

  const first = cleaned[0]
  // Sentence-ish split: the first clause usually states the goal.
  const sentence = first.split(/(?<=[.!?])\s+|\n/)[0]?.trim() || first
  const title = clip(sentence.charAt(0).toUpperCase() + sentence.slice(1))

  const rest = (sentence.length < first.length ? first.slice(sentence.length) : cleaned[1] ?? "").trim()
  return { title, detail: rest ? clip(rest, 160) : null, source: "parser" }
}

/* ------------------------------------------------------------------ *
 * Model-backed
 * ------------------------------------------------------------------ */

const INSTRUCTION =
  "Summarise the following coding-session request. Reply with exactly two lines and nothing else:\n" +
  "Line 1: TITLE: a specific imperative title, at most 8 words, naming the concrete artefact or behaviour.\n" +
  "Line 2: SUMMARY: one sentence, at most 25 words, describing what the session is doing.\n" +
  "Do not restate these instructions, use markdown, or add commentary.\n\n"

function parseModelReply(text: string): { title: string; detail: string | null } | null {
  const title = text.match(/^\s*TITLE:\s*(.+)$/im)?.[1]?.trim()
  const detail = text.match(/^\s*SUMMARY:\s*(.+)$/im)?.[1]?.trim()
  if (!title) return null

  // A model that echoes the instructions is not answering.
  if (/^(title|summary)\b/i.test(title) || title.length < 3) return null
  return { title: clip(title.replace(/^["']|["']$/g, "")), detail: detail ? clip(detail, 160) : null }
}

/**
 * Summarise with a model, in a scratch session that is deleted afterwards.
 *
 * A throwaway session keeps the summary out of the user's history and away from
 * the transcript being summarised, which must not be perturbed by having been
 * looked at.
 */
async function modelSummary(client: Client, model: string, directory: string | null, prompts: string[]): Promise<Summary | null> {
  const [providerID, ...rest] = model.split("/")
  const modelID = rest.join("/")
  if (!providerID || !modelID) return null

  const query = directory ? { directory } : undefined
  let sessionID: string | null = null

  try {
    const created = await client.session.create({ body: { title: SCRATCH_TITLE }, ...(query ? { query } : {}) })
    sessionID = created?.data?.id ?? null
    if (!sessionID) return null

    const body = {
      model: { providerID, modelID },
      parts: [{ type: "text", text: INSTRUCTION + prompts.join("\n\n").slice(0, 4000) }],
    }

    const response = await withTimeout(client.session.prompt({ path: { id: sessionID }, body, ...(query ? { query } : {}) }))
    if (!response || response.error) return null

    const text = extractText(response.data)
    const parsed = text ? parseModelReply(text) : null
    return parsed ? { ...parsed, source: "model" } : null
  } catch {
    return null
  } finally {
    if (sessionID) {
      await client.session.delete({ path: { id: sessionID }, ...(query ? { query } : {}) }).catch(() => {})
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
 * Summarise a session, preferring the configured model and always falling back
 * to the parser. Never throws: a summary is a convenience, not a dependency.
 */
export async function summarize(input: {
  client: Client
  model: string
  directory: string | null
  prompts: string[]
}): Promise<Summary> {
  const fallback = parseSummary(input.prompts)
  if (!input.model || input.model === NO_MODEL) return fallback
  if (input.prompts.length === 0) return fallback

  const summary = await modelSummary(input.client, input.model, input.directory, input.prompts).catch(() => null)
  // A model that failed, timed out or answered unusably leaves the parser's
  // result in place rather than degrading the queue.
  return summary ?? fallback
}
