import OpenAI from 'openai'
import { getProxyFetchOptions } from 'src/utils/proxy.js'

/**
 * Environment variables:
 *
 * GROK_API_KEY (or XAI_API_KEY): Required. API key for the xAI Grok endpoint.
 * GROK_BASE_URL: Optional. Defaults to https://api.x.ai/v1.
 */

const DEFAULT_BASE_URL = 'https://api.x.ai/v1'

const cachedClients = new Map<number, OpenAI>()

export function getGrokClient(options?: {
  maxRetries?: number
  fetchOverride?: typeof fetch
  source?: string
}): OpenAI {
  const maxRetries = options?.maxRetries ?? 0
  const useCache = !options?.fetchOverride
  if (useCache) {
    const cachedClient = cachedClients.get(maxRetries)
    if (cachedClient) return cachedClient
  }

  const apiKey = process.env.GROK_API_KEY || process.env.XAI_API_KEY || ''
  const baseURL = process.env.GROK_BASE_URL || DEFAULT_BASE_URL

  const client = new OpenAI({
    apiKey,
    baseURL,
    maxRetries,
    timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    dangerouslyAllowBrowser: true,
    fetchOptions: getProxyFetchOptions({ forAnthropicAPI: false }),
    ...(options?.fetchOverride && { fetch: options.fetchOverride }),
  })

  if (useCache) {
    cachedClients.set(maxRetries, client)
  }

  return client
}

export function clearGrokClientCache(): void {
  cachedClients.clear()
}
