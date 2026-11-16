import type { Plugin } from '@opencode-ai/plugin'
import { createFallbackFetch } from '../lib/model-fallback.ts'
import { createCodingPolicyFetch } from '../lib/coding-model-policy.ts'
import { CONFIG_DIR } from '../lib/paths.ts'
import path from 'node:path'
import * as Logs from '../lib/logs.ts'

export const ModelFallback: Plugin = async () => ({
  async config(config) {
    const providers = config.provider ?? {}
    for (const [id, provider] of Object.entries(providers)) {
      if (!provider.options?.baseURL) continue
      // Installed alongside the existing fallback hook; a missing policy retains its behavior.
      const fallback = id === 'cpa' && config.provider?.['local-vllm']?.options?.baseURL
        ? createFallbackFetch({ primaryUrl: String(provider.options.baseURL), fallbackUrl: String(config.provider['local-vllm'].options.baseURL), model: Object.keys(config.provider['local-vllm'].models ?? {})[0], apiKey: String(config.provider['local-vllm'].options.apiKey || '') })
        : globalThis.fetch
      provider.options.fetch = createCodingPolicyFetch({
        sourceUrl: String(provider.options.baseURL), providers,
        policyFile: path.join(CONFIG_DIR, 'coding-model-policy.json'), unconfiguredFetch: fallback,
        providersFile: path.join(CONFIG_DIR, 'opencode.json'),
        onAttempt: (model, outcome) => Logs.log('model-fallback', `Coding model routing: OpenCode/model routing — ${model}: ${outcome}.`, 'info'),
      })
    }
  },
})
