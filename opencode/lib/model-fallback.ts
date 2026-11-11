type Options = {
  primaryUrl: string
  fallbackUrl: string
  model: string
  apiKey?: string
  headerTimeoutMs?: number
  fetchImpl?: typeof fetch
  onFallback?: (cause: string) => void
}

// Retry only before returning a response: never replay a partially streamed turn.
export function createFallbackFetch(options: Options): typeof fetch {
  const primary = new URL(options.primaryUrl)
  const local = new URL(options.fallbackUrl)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(local.hostname) || !['http:', 'https:'].includes(local.protocol)) {
    throw new Error('Fallback unavailable: OpenCode/model routing — fallback must be a loopback HTTP endpoint.')
  }
  const send = options.fetchImpl ?? globalThis.fetch
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== primary.origin || url.pathname !== primary.pathname.replace(/\/$/, '') + '/chat/completions' || typeof init?.body !== 'string') {
      return send(input, init)
    }
    const body = JSON.parse(init.body)
    const cancel = init.signal ?? (input instanceof Request ? input.signal : undefined)
    cancel?.throwIfAborted()
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), options.headerTimeoutMs ?? 45000)
    let cause: string
    try {
      const response = await send(input, { ...init, signal: cancel ? AbortSignal.any([cancel, timeout.signal]) : timeout.signal })
      if (![401, 403, 404, 408, 429].includes(response.status) && response.status < 500) return response
      cause = `primary HTTP ${response.status}`
      await response.body?.cancel()
    } catch (error) {
      cancel?.throwIfAborted()
      cause = timeout.signal.aborted ? 'primary response timeout' : 'primary transport failure'
    } finally { clearTimeout(timer) }
    cancel?.throwIfAborted()
    options.onFallback?.(cause)
    // Do not forward CPA authorization, provider hints, or reasoning settings.
    const allowed = ['messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'stream', 'stream_options', 'temperature', 'top_p', 'stop', 'presence_penalty', 'frequency_penalty', 'response_format']
    const request = Object.fromEntries(allowed.filter(key => body[key] !== undefined).map(key => [key, body[key]]))
    request.model = options.model
    const limit = body.max_completion_tokens ?? body.max_tokens
    if (typeof limit === 'number') request.max_tokens = Math.min(limit, 32768)
    return send(local.href.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', signal: cancel,
      headers: { 'content-type': 'application/json', ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) },
      body: JSON.stringify(request),
    })
  }
}
