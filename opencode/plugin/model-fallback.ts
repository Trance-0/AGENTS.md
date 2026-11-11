import type { Plugin } from '@opencode-ai/plugin'
import { createFallbackFetch } from '../lib/model-fallback.ts'
import * as Logs from '../lib/logs.ts'

export const ModelFallback: Plugin = async () => ({
  async config(config) {
    const primary = config.provider?.cpa
    const local = config.provider?.['local-vllm']
    const model = Object.keys(local?.models ?? {})[0]
    if (!primary?.options?.baseURL || !local?.options?.baseURL || !model) return
    primary.options.fetch = createFallbackFetch({
      primaryUrl: String(primary.options.baseURL), fallbackUrl: String(local.options.baseURL), model,
      apiKey: typeof local.options.apiKey === 'string' ? local.options.apiKey : undefined,
      onFallback: cause => Logs.log('model-fallback', `CPA request unavailable: OpenCode/model routing — ${cause}; using local-vllm/${model}.`, 'warn'),
    })
  },
})
