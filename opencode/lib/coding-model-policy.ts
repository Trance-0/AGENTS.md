import fs from 'node:fs'

export type CodingModel = { model: string; effort: string }
type Provider = { options?: { baseURL?: string; apiKey?: string }; models?: Record<string, { reasoning?: boolean }> }
type Options = {
  sourceUrl: string
  providers: Record<string, Provider>
  policyFile: string
  providersFile?: string
  fetchImpl?: typeof fetch
  unconfiguredFetch?: typeof fetch
  headerTimeoutMs?: number
  onAttempt?: (model: string, outcome: string) => void
}

// The policy is re-read per request so dashboard edits apply without losing sessions.
export function createCodingPolicyFetch(options: Options): typeof fetch {
  const send = options.fetchImpl ?? globalThis.fetch
  const source = new URL(options.sourceUrl)
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== source.origin || url.pathname !== source.pathname.replace(/\/$/, '') + '/chat/completions' || typeof init?.body !== 'string') return send(input, init)
    if (!fs.existsSync(options.policyFile)) return (options.unconfiguredFetch ?? send)(input, init)
    const providers: Record<string, Provider> = options.providersFile
      ? JSON.parse(fs.readFileSync(options.providersFile, 'utf8')).provider ?? {}
      : options.providers
    const policy = JSON.parse(fs.readFileSync(options.policyFile, 'utf8')) as { chain: CodingModel[] }
    if (!Array.isArray(policy.chain) || !policy.chain.length) throw new Error('Coding request stopped: OpenCode/model routing — model policy has no chain.')
    const original = JSON.parse(init.body)
    const cancel = init.signal ?? (input instanceof Request ? input.signal : undefined)
    const candidates = policy.chain.flatMap(entry => {
      const split = entry.model.indexOf('/'), providerID = entry.model.slice(0, split), modelID = entry.model.slice(split + 1)
      const provider = providers[providerID]
      if (split < 1 || !provider?.options?.baseURL || !provider.models?.[modelID] || (!['vllm', 'local-vllm'].includes(providerID) && !provider.options.apiKey)) {
        options.onAttempt?.(entry.model, 'skipped: provider/model is not configured'); return []
      }
      return [{ ...entry, provider, modelID }]
    })
    if (!candidates.length) throw new Error('Coding request stopped: OpenCode/model routing — no policy models are configured.')
    for (let index = 0; index < candidates.length; index++) {
      cancel?.throwIfAborted()
      const candidate = candidates[index], endpoint = new URL(candidate.provider.options!.baseURL!)
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('Coding request stopped: OpenCode/model routing — invalid configured provider URL.')
      // Construct each request independently: never carry another provider's auth or hints.
      const keys = ['messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'stream', 'stream_options', 'temperature', 'top_p', 'stop', 'presence_penalty', 'frequency_penalty', 'response_format']
      const body: Record<string, unknown> = Object.fromEntries(keys.filter(key => original[key] !== undefined).map(key => [key, original[key]]))
      body.model = candidate.modelID
      const limit = original.max_completion_tokens ?? original.max_tokens
      if (typeof limit === 'number') body.max_tokens = Math.min(limit, 32768)
      if (candidate.effort !== 'default') body.reasoning_effort = candidate.effort
      const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), options.headerTimeoutMs ?? 45000)
      try {
        options.onAttempt?.(candidate.model, 'request started')
        const response = await send(endpoint.href.replace(/\/$/, '') + '/chat/completions', {
          method: 'POST', signal: cancel ? AbortSignal.any([cancel, timeout.signal]) : timeout.signal,
          headers: { 'content-type': 'application/json', ...(candidate.provider.options?.apiKey ? { authorization: `Bearer ${candidate.provider.options.apiKey}` } : {}) },
          body: JSON.stringify(body),
        })
        if (![401, 402, 403, 404, 408, 429].includes(response.status) && response.status < 500 || index === candidates.length - 1) {
          options.onAttempt?.(candidate.model, `HTTP ${response.status}`); return response
        }
        options.onAttempt?.(candidate.model, `HTTP ${response.status}; trying next model`)
        await response.body?.cancel()
      } catch (error) {
        cancel?.throwIfAborted()
        options.onAttempt?.(candidate.model, timeout.signal.aborted ? 'response headers timed out' : 'transport failed')
        if (index === candidates.length - 1) throw error
      } finally { clearTimeout(timer) }
    }
    throw new Error('Coding request stopped: OpenCode/model routing — all model attempts failed.')
  }
}
