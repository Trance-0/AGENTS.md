/**
 * Choosing a model, and checking that the choice works.
 *
 * Several plugins let the user pick a small model for a background job —
 * summarising a task, proposing a session title — and each needs the same two
 * things: the list of models the server can actually reach, and a way to prove
 * the selected one answers usefully before trusting it with real work.
 *
 * Both were duplicated per plugin, which is worse than it sounds: the list and
 * the probe have to agree about what a model id looks like and how a provider
 * is reached, and two copies drift. This owns both.
 *
 * ## Why a test matters
 *
 * The setting accepts any `providerID/modelID`, and the plugins are deliberately
 * forgiving — a model that is missing, slow, or answers with prose instead of
 * the requested shape all fall back silently to a built-in parser. That is the
 * right behaviour for a background job and a terrible one for configuration:
 * every failure looks identical from the outside, and the only feedback is work
 * that is quietly never summarised. A probe turns each of those into a distinct,
 * visible answer.
 */

import * as ModelProbe from "./model-probe.ts"

/** The sentinel every caller uses for "no model". */
export const NONE = ""

export type Option = { value: string; label: string }

type Client = {
  session: {
    create(options: { body?: any; query?: { directory?: string } }): Promise<{ error?: unknown; data?: any }>
    prompt(options: { path: { id: string }; body: any; query?: { directory?: string } }): Promise<{ error?: unknown; data?: any }>
    delete(options: { path: { id: string }; query?: { directory?: string } }): Promise<{ error?: unknown; data?: unknown }>
  }
  config?: { providers(): Promise<{ data?: any }> }
}

/**
 * Every model the server currently offers, plus the configured one.
 *
 * The configured model is always present even when the provider is down or has
 * dropped it, marked so the reason it looks odd is visible. Silently omitting it
 * would make the select appear to have been changed by someone else.
 */
export async function options(client: Client, current: string, noneLabel: string): Promise<Option[]> {
  const out: Option[] = [{ value: NONE, label: noneLabel }]
  const seen = new Set<string>()

  try {
    const response = await client.config?.providers()
    for (const provider of (response?.data?.providers ?? []) as any[]) {
      for (const model of Object.values(provider?.models ?? {}) as any[]) {
        const id = `${provider.id}/${model.id}`
        if (seen.has(id)) continue
        seen.add(id)
        out.push({ value: id, label: `${provider.name ?? provider.id} — ${model.name ?? model.id}` })
      }
    }
  } catch {
    // The server could not be asked; the configured model is still offered.
  }

  if (current && current !== NONE && !seen.has(current)) {
    out.push({ value: current, label: `${current} (not currently available)` })
  }
  return out
}

/** One recorded test, kept so its reply survives a dashboard re-render. */
export type Probe = {
  model: string
  at: number
  ok: boolean
  elapsedMs: number
  text: string
  error: string | null
  /** Whether the reply matched the shape the caller needs. */
  usable: boolean
}

/**
 * The last test per plugin.
 *
 * On `globalThis` for the same reason the registry is: opencode instantiates a
 * plugin once per project directory, and a result recorded by one instance has
 * to be readable by the dashboard served from another.
 */
const KEY = Symbol.for("@dsh/opencode-model-probes")

function store(): Map<string, Probe> {
  const g = globalThis as Record<symbol, unknown>
  if (!g[KEY]) g[KEY] = new Map<string, Probe>()
  return g[KEY] as Map<string, Probe>
}

export function lastProbe(pluginID: string): Probe | null {
  return store().get(pluginID) ?? null
}

export type ChatTurn = { role: "user" | "assistant"; text: string; at: number; elapsedMs?: number; error?: string }

/**
 * The scratch conversation per plugin.
 *
 * In memory only, and never written anywhere: a test conversation exists to
 * judge a model, not to be kept. It dies with the opencode process, and
 * `clearChat` discards it on demand.
 */
const CHAT = Symbol.for("@dsh/opencode-model-chats")

function chats(): Map<string, ChatTurn[]> {
  const g = globalThis as Record<symbol, unknown>
  if (!g[CHAT]) g[CHAT] = new Map<string, ChatTurn[]>()
  return g[CHAT] as Map<string, ChatTurn[]>
}

export function chat(pluginID: string): ChatTurn[] {
  return chats().get(pluginID) ?? []
}

export function clearChat(pluginID: string): void {
  chats().delete(pluginID)
}

/** How many turns a scratch conversation keeps before dropping the oldest. */
const MAX_CHAT_TURNS = 40

/**
 * Send one message in the plugin's scratch conversation.
 *
 * Each exchange runs in its own throwaway session — the probe creates and
 * deletes one per call — so the transcript kept here is what makes the
 * conversation continuous. Nothing is persisted on either side.
 */
export async function say(input: {
  pluginID: string
  client: Client
  model: string
  message: string
  directory?: string | null
}): Promise<{ reply: string; ok: boolean; elapsedMs: number; error: string | null }> {
  if (!input.model || input.model === NONE) throw new Error("no model selected — nothing to talk to")
  const message = input.message.trim()
  if (!message) throw new Error("message cannot be empty")

  const history = chat(input.pluginID).filter((turn) => !turn.error)
  const result = await ModelProbe.probe({
    client: input.client,
    model: input.model,
    prompt: message,
    directory: input.directory ?? null,
    history: history.map((turn) => ({ role: turn.role, text: turn.text })),
  })

  const turns = [
    ...chat(input.pluginID),
    { role: "user" as const, text: message, at: Date.now() },
    {
      role: "assistant" as const,
      text: result.ok ? result.text : "",
      at: Date.now(),
      elapsedMs: result.elapsedMs,
      ...(result.ok ? {} : { error: result.error ?? "unknown error" }),
    },
  ]
  chats().set(input.pluginID, turns.slice(-MAX_CHAT_TURNS))

  return { reply: result.text, ok: result.ok, elapsedMs: result.elapsedMs, error: result.error }
}

/**
 * Run one prompt against `model` and record the result.
 *
 * `accepts` decides whether the reply is *usable*, which only the caller can
 * know: a title and a two-line summary are both valid replies to different
 * questions. Returns a one-line message for the toast; the full reply is read
 * back with `lastProbe`.
 */
export async function test(input: {
  pluginID: string
  client: Client
  model: string
  prompt: string
  directory?: string | null
  accepts?: (reply: string) => boolean
  /** Describes the expected shape when `accepts` rejects the reply. */
  expectation?: string
}): Promise<{ probe: Probe; message: string }> {
  if (!input.model || input.model === NONE) {
    throw new Error("no model selected — nothing to test")
  }

  const result = await ModelProbe.probe({
    client: input.client,
    model: input.model,
    prompt: input.prompt,
    directory: input.directory ?? null,
  })

  const usable = result.ok && (input.accepts ? input.accepts(result.text) : true)
  const probe: Probe = {
    model: input.model,
    at: Date.now(),
    ok: result.ok,
    elapsedMs: result.elapsedMs,
    text: result.text,
    error: result.error,
    usable,
  }
  store().set(input.pluginID, probe)

  const seconds = (result.elapsedMs / 1000).toFixed(1)
  if (!result.ok) return { probe, message: `${input.model} failed after ${seconds}s: ${result.error}` }
  if (!usable) {
    return {
      probe,
      message: `${input.model} replied in ${seconds}s, but ${input.expectation ?? "not in the expected shape"}. See the Info tab.`,
    }
  }
  return { probe, message: `${input.model} replied in ${seconds}s. See the Info tab.` }
}

/**
 * The settings field pair for a model: the picker and its test button.
 *
 * Returned together because they belong together — a selector with no way to
 * check the selection is what made a wrong model so hard to notice.
 */
export async function fields(input: {
  client: Client
  /** Setting key of the selector. */
  key: string
  label: string
  current: string
  noneLabel: string
  description: string
  /** Action the chat window sends messages through. */
  action: string
  /** Unused; kept so existing callers need no change. */
  prompt?: string
  group?: string
}): Promise<any[]> {
  return [
    {
      ...(input.group ? { group: input.group } : {}),
      key: input.key,
      // One self-contained control: the model list plus a chat window to try
      // it. Previously this was a select and a separate "test" action, which
      // meant two fields editing one concern and a reply that could only be
      // read on another tab.
      type: "model",
      label: input.label,
      value: input.current,
      options: await options(input.client, input.current, input.noneLabel),
      description: input.description,
      chatAction: input.action,
    },
  ]
}

/**
 * The Info-tab panel showing a test result, or nothing when none was run.
 *
 * A toast cannot hold a multi-line reply, and the reply's shape is the entire
 * point of testing a model for a structured job, so the verbatim text is shown
 * where it can be read.
 */
export function panel(input: {
  pluginID: string
  title: string
  action: string
  prompt: string
}): any[] {
  const probe = lastProbe(input.pluginID)
  if (!probe) return []

  const seconds = (probe.elapsedMs / 1000).toFixed(1)
  return [
    {
      key: "model-test",
      title: input.title,
      description: `${probe.model} — ${new Date(probe.at).toLocaleTimeString()}`,
      updatedAt: probe.at,
      items: [
        {
          title: probe.ok ? `replied in ${seconds}s` : `failed after ${seconds}s`,
          subtitle: probe.ok ? probe.text : (probe.error ?? "unknown error"),
          tone: !probe.ok ? ("error" as const) : probe.usable ? ("ok" as const) : ("warn" as const),
          fields: [
            { label: "model", value: probe.model },
            { label: "latency", value: `${probe.elapsedMs} ms` },
            { label: "usable", value: probe.ok ? (probe.usable ? "yes" : "no") : "—" },
          ],
          controls: [
            {
              type: "prompt" as const,
              action: input.action,
              label: "Run again",
              prompt: "Prompt to send:",
              value: input.prompt,
            },
          ],
        },
      ],
    },
  ]
}
