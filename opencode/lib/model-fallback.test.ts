import test from 'node:test'
import assert from 'node:assert/strict'
import { createFallbackFetch } from './model-fallback.ts'

const primaryUrl = 'https://cpa.example/v1', fallbackUrl = 'http://127.0.0.1:8100/v1'
const request = { method: 'POST', headers: { authorization: 'Bearer primary-secret' }, body: JSON.stringify({ model: 'gpt-6-astra', messages: [{ role: 'user', content: 'hello' }], tools: [{ type: 'function' }], reasoning_effort: 'high', stream: true }) }

test('CPA success does not reach local provider', async () => {
  let calls = 0
  const f = createFallbackFetch({ primaryUrl, fallbackUrl, model: 'qwen', fetchImpl: async () => { calls++; return new Response('ok') } })
  assert.equal(await (await f(primaryUrl + '/chat/completions', request)).text(), 'ok')
  assert.equal(calls, 1)
})

for (const status of [401, 403, 404, 408, 429, 503]) test(`HTTP ${status} falls back with tools but without CPA secrets`, async () => {
  let calls = 0
  const f = createFallbackFetch({ primaryUrl, fallbackUrl, model: 'qwen', fetchImpl: async (url, init) => {
    if (++calls === 1) return new Response('unavailable', { status })
    assert.equal(url, fallbackUrl + '/chat/completions')
    assert.equal(new Headers(init?.headers).has('authorization'), false)
    const body = JSON.parse(String(init?.body)); assert.equal(body.model, 'qwen'); assert.equal(body.reasoning_effort, undefined); assert.equal(body.tools.length, 1)
    return new Response('local stream')
  } })
  assert.equal(await (await f(primaryUrl + '/chat/completions', request)).text(), 'local stream'); assert.equal(calls, 2)
})

test('invalid requests, canceled requests, and started streams are not replayed', async () => {
  let calls = 0
  const f = createFallbackFetch({ primaryUrl, fallbackUrl, model: 'qwen', fetchImpl: async () => { calls++; return new Response('bad', { status: 400 }) } })
  assert.equal((await f(primaryUrl + '/chat/completions', request)).status, 400)
  await assert.rejects(f(primaryUrl + '/chat/completions', { ...request, signal: AbortSignal.abort() }))
  assert.equal(calls, 1)
  const broken = createFallbackFetch({ primaryUrl, fallbackUrl, model: 'qwen', fetchImpl: async () => { calls++; return new Response(new ReadableStream({ start(c) { c.error(new Error('broken stream')) } })) } })
  await assert.rejects((await broken(primaryUrl + '/chat/completions', request)).text()); assert.equal(calls, 2)
})

test('transport failures fall back, and remote fallback endpoints are rejected', async () => {
  let calls = 0
  const f = createFallbackFetch({ primaryUrl, fallbackUrl, model: 'qwen', fetchImpl: async () => { if (++calls === 1) throw new TypeError('network'); return new Response('local') } })
  assert.equal(await (await f(primaryUrl + '/chat/completions', request)).text(), 'local')
  assert.throws(() => createFallbackFetch({ primaryUrl, fallbackUrl: 'https://other.example/v1', model: 'qwen' }), /loopback/)
})

test('a stalled primary falls back but caller cancellation never starts local inference', async () => {
  let calls = 0
  const f = createFallbackFetch({ primaryUrl, fallbackUrl, model: 'qwen', headerTimeoutMs: 10, fetchImpl: async (_url, init) => {
    if (++calls === 2) return new Response('local after timeout')
    return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
  } })
  assert.equal(await (await f(primaryUrl + '/chat/completions', request)).text(), 'local after timeout')
  assert.equal(calls, 2)
  const controller = new AbortController()
  const canceled = createFallbackFetch({ primaryUrl, fallbackUrl, model: 'qwen', fetchImpl: async (_url, init) => {
    calls++; controller.abort(); init?.signal?.throwIfAborted(); throw new Error('unreachable')
  } })
  await assert.rejects(canceled(primaryUrl + '/chat/completions', { ...request, signal: controller.signal }))
  assert.equal(calls, 3)
})
