/**
 * Send one prompt to one model and report exactly what came back.
 *
 * Choosing a summariser or rename model is otherwise guesswork: the setting
 * accepts any `providerID/modelID`, and the only way to find out whether that
 * model exists, answers in time, and produces something parseable was to wait
 * for a real task to be summarised and inspect the result. A model that is
 * absent, slow, or answers with prose instead of the requested shape all look
 * identical from the outside — the plugin silently falls back to its parser.
 *
 * This runs the same round trip those features use, in a registered scratch
 * session that is deleted afterwards, and returns the raw reply plus the
 * latency. It is deliberately unopinionated about the answer's *shape*: the
 * caller decides whether the reply is usable, because what counts as usable
 * differs between a title and a summary.
 */

import * as Scratch from "./scratch.ts"

/** Title of the session a probe runs in; registered so nothing adopts it. */
export const PROBE_TITLE = Scratch.register("model probe")

/** A probe must never hang a settings page. */
const TIMEOUT_MS = 30_000

type Client = {
  session: {
    create(options: { body?: any; query?: { directory?: string } }): Promise<{ error?: unknown; data?: any }>
    prompt(options: { path: { id: string }; body: any; query?: { directory?: string } }): Promise<{ error?: unknown; data?: any }>
    delete(options: { path: { id: string }; query?: { directory?: string } }): Promise<{ error?: unknown; data?: unknown }>
  }
}

export type ProbeResult = {
  ok: boolean
  /** The model's reply verbatim, or "" when nothing usable came back. */
  text: string
  /** Round-trip time in milliseconds, including session setup and teardown. */
  elapsedMs: number
  /** Why the probe failed, when it did. */
  error: string | null
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
 * Ask `model` to answer `prompt`, and report what happened.
 *
 * Never throws: every failure is a result with `ok: false` and a reason, since
 * the caller is a settings page that has to render something either way.
 */
export async function probe(input: {
  client: Client
  model: string
  prompt: string
  directory?: string | null
  /** Earlier turns to replay, so a probe can continue a conversation. */
  history?: Array<{ role: "user" | "assistant"; text: string }>
}): Promise<ProbeResult> {
  const started = Date.now()
  const elapsed = () => Date.now() - started

  const [providerID, ...rest] = input.model.split("/")
  const modelID = rest.join("/")
  if (!providerID || !modelID) {
    return { ok: false, text: "", elapsedMs: elapsed(), error: "model must be 'providerID/modelID'" }
  }
  if (input.prompt.trim() === "") {
    return { ok: false, text: "", elapsedMs: elapsed(), error: "prompt cannot be empty" }
  }

  const query = input.directory ? { directory: input.directory } : undefined
  let sessionID: string | null = null

  try {
    const created = await input.client.session.create({ body: { title: PROBE_TITLE }, ...(query ? { query } : {}) })
    sessionID = created?.data?.id ?? null
    if (!sessionID) {
      return { ok: false, text: "", elapsedMs: elapsed(), error: "could not open a scratch session" }
    }

    // The scratch session is discarded after every exchange, so a follow-up
    // has to carry its own context. Replaying the transcript as one prompt is
    // what makes the conversation coherent without persisting anything.
    const outgoing = (input.history ?? []).length
      ? [
          ...(input.history ?? []).map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`),
          `User: ${input.prompt}`,
        ].join("\n\n")
      : input.prompt

    const response = await withTimeout(
      input.client.session.prompt({
        path: { id: sessionID },
        body: { model: { providerID, modelID }, parts: [{ type: "text", text: outgoing }] },
        ...(query ? { query } : {}),
      }),
    )

    if (response === null) {
      return { ok: false, text: "", elapsedMs: elapsed(), error: `no reply within ${TIMEOUT_MS / 1000}s` }
    }
    if (response.error) {
      const message = typeof response.error === "string" ? response.error : JSON.stringify(response.error)
      return { ok: false, text: "", elapsedMs: elapsed(), error: message.slice(0, 300) }
    }

    const text = extractText(response.data)
    if (!text) {
      return { ok: false, text: "", elapsedMs: elapsed(), error: "the model replied with no text" }
    }
    return { ok: true, text, elapsedMs: elapsed(), error: null }
  } catch (error) {
    return {
      ok: false,
      text: "",
      elapsedMs: elapsed(),
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    if (sessionID) {
      await input.client.session.delete({ path: { id: sessionID }, ...(query ? { query } : {}) }).catch(() => {})
    }
  }
}
