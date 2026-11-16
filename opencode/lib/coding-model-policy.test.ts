import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCodingPolicyFetch } from './coding-model-policy.ts'

const request = { method: 'POST', headers: { authorization: 'Bearer original-secret' }, body: JSON.stringify({ model: 'old', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function' }], reasoning_effort: 'xhigh', stream: true }) }
const providers = {
  cpa: { options: { baseURL: 'https://primary.example/v1', apiKey: 'cpa-key' }, models: { opus: {}, astra: {} } },
  deepseek: { options: { baseURL: 'https://deepseek.example/v1', apiKey: 'deepseek-key' }, models: { flash: {} } },
  vllm: { options: { baseURL: 'http://127.0.0.1:8100/v1' }, models: { qwen: {} } },
}
function fixture(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-policy-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'policy.json')
  fs.writeFileSync(file, JSON.stringify({ chain: [{ model: 'cpa/opus', effort: 'high' }, { model: 'cpa/astra', effort: 'medium' }, { model: 'deepseek/flash', effort: 'low' }, { model: 'vllm/qwen', effort: 'default' }] }))
  return file
}

test('four-model order, effort, tools and provider credentials survive failures correctly', async t => {
  const calls: { model: string; effort: string; auth: string | null }[] = []
  const policyFile = fixture(t)
  const fetcher = createCodingPolicyFetch({ sourceUrl: providers.cpa.options.baseURL, providers, policyFile, fetchImpl: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); assert.equal(body.tools.length, 1)
    calls.push({ model: body.model, effort: body.reasoning_effort, auth: new Headers(init?.headers).get('authorization') })
    return calls.length < 4 ? new Response('unavailable', { status: [503, 429, 402][calls.length - 1] }) : new Response('local reply')
  } })
  assert.equal(await (await fetcher(providers.cpa.options.baseURL + '/chat/completions', request)).text(), 'local reply')
  assert.deepEqual(calls, [
    { model: 'opus', effort: 'high', auth: 'Bearer cpa-key' }, { model: 'astra', effort: 'medium', auth: 'Bearer cpa-key' },
    { model: 'flash', effort: 'low', auth: 'Bearer deepseek-key' }, { model: 'qwen', effort: undefined, auth: null },
  ])
  fs.writeFileSync(policyFile, JSON.stringify({ chain: [{ model: 'vllm/qwen', effort: 'low' }] }))
  await fetcher(providers.cpa.options.baseURL + '/chat/completions', request)
  assert.equal(calls.at(-1)?.model, 'qwen'); assert.equal(calls.at(-1)?.effort, 'low')
})

test('missing models skip; bad requests, caller cancellation and broken streams do not replay', async t => {
  const policyFile = fixture(t)
  let calls = 0
  const fetcher = createCodingPolicyFetch({ sourceUrl: providers.cpa.options.baseURL, providers: { vllm: providers.vllm }, policyFile, fetchImpl: async () => { calls++; return new Response('bad request', { status: 400 }) } })
  assert.equal((await fetcher(providers.cpa.options.baseURL + '/chat/completions', request)).status, 400)
  assert.equal(calls, 1)
  await assert.rejects(fetcher(providers.cpa.options.baseURL + '/chat/completions', { ...request, signal: AbortSignal.abort() }))
  assert.equal(calls, 1)
  const stream = createCodingPolicyFetch({ sourceUrl: providers.cpa.options.baseURL, providers, policyFile, fetchImpl: async () => { calls++; return new Response(new ReadableStream({ start(c) { c.error(new Error('broken stream')) } })) } })
  await assert.rejects((await stream(providers.cpa.options.baseURL + '/chat/completions', request)).text())
  assert.equal(calls, 2)
})

test('transport and response header timeout advance; cancellation does not', async t => {
  const policyFile = fixture(t); let calls = 0
  const fetcher = createCodingPolicyFetch({ sourceUrl: providers.cpa.options.baseURL, providers, policyFile, headerTimeoutMs: 5, fetchImpl: async (_url, init) => {
    if (++calls === 1) throw new TypeError('network')
    if (calls === 2) return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('timeout')), { once: true }))
    return new Response('ok')
  } })
  assert.equal(await (await fetcher(providers.cpa.options.baseURL + '/chat/completions', request)).text(), 'ok'); assert.equal(calls, 3)
})
