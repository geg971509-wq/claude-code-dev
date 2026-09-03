import { randomUUID } from 'crypto'
import OpenAI from 'openai'
import type { ResponseCreateParamsStreaming } from 'openai/resources/responses/responses.mjs'
import { getProxyFetchOptions } from 'src/utils/proxy.js'
import { getApiTimeoutMs } from 'src/utils/timeouts.js'
import { createResponsesStreamWithClient } from '../openai/responsesAdapter.js'
import type { PreparedOpenAIStreamAttempt } from '../openai/streamExecutor.js'

/**
 * Environment variables:
 *
 * GROK_API_KEY (or XAI_API_KEY): Required. API key for the xAI Grok endpoint.
 * GROK_BASE_URL: Optional. Defaults to https://api.x.ai/v1.
 */

const DEFAULT_BASE_URL = 'https://api.x.ai/v1'

const cachedClients = new Map<string, OpenAI>()

function getClientConfig(): { apiKey: string; baseURL: string } {
  return {
    apiKey: process.env.GROK_API_KEY || process.env.XAI_API_KEY || '',
    baseURL: process.env.GROK_BASE_URL || DEFAULT_BASE_URL,
  }
}

function getClientCacheKey(
  apiKey: string,
  baseURL: string,
  maxRetries: number,
): string {
  return `${baseURL}\0${apiKey}\0${maxRetries}`
}

export function getGrokClient(options?: {
  maxRetries?: number
  fetchOverride?: typeof fetch
  source?: string
}): OpenAI {
  const maxRetries = options?.maxRetries ?? 0
  const { apiKey, baseURL } = getClientConfig()
  const cacheKey = getClientCacheKey(apiKey, baseURL, maxRetries)
  const useCache = !options?.fetchOverride
  if (useCache) {
    const cachedClient = cachedClients.get(cacheKey)
    if (cachedClient) return cachedClient
  }

  const client = new OpenAI({
    apiKey,
    baseURL,
    maxRetries,
    timeout: getApiTimeoutMs(),
    dangerouslyAllowBrowser: true,
    fetchOptions: getProxyFetchOptions({ forAnthropicAPI: false }),
    ...(options?.fetchOverride && { fetch: options.fetchOverride }),
  })

  if (useCache) {
    cachedClients.set(cacheKey, client)
  }

  return client
}

export type GrokRequestIdentity = {
  model: string
  sessionId: string
  requestId?: string
  agentId?: string
  transientRetry?: number
}

/**
 * Request identity headers mirrored from grok-build's GrokRequestHeaders.
 * Fields for turn index/deployment/user IDs are intentionally omitted until
 * Claude Code has authoritative values for them; inventing identifiers would
 * be worse than leaving optional official headers absent.
 */
export function buildGrokRequestHeaders(
  identity: GrokRequestIdentity,
): Record<string, string> {
  return {
    'x-grok-conv-id': identity.sessionId,
    'x-grok-req-id': identity.requestId ?? randomUUID(),
    'x-grok-model-override': identity.model,
    'x-grok-session-id': identity.sessionId,
    ...(identity.agentId && { 'x-grok-agent-id': identity.agentId }),
    ...(identity.transientRetry !== undefined && {
      'x-grok-transient-retry': String(identity.transientRetry),
    }),
  }
}

/** Prepare the official xAI Responses stream while reusing the shared executor. */
export function prepareGrokResponsesStreamRequest(params: {
  request: ResponseCreateParamsStreaming
  model: string
  sessionId: string
  agentId?: string
  fetchOverride?: typeof fetch
  source?: string
}): PreparedOpenAIStreamAttempt {
  const requestId = randomUUID()
  let attemptIndex = 0
  const request = {
    ...params.request,
    prompt_cache_key: params.request.prompt_cache_key ?? params.sessionId,
  } as ResponseCreateParamsStreaming

  return {
    // The wire protocol is the public OpenAI-compatible Responses shape; the
    // raw logger currently groups this under its official-responses route.
    route: 'official-responses',
    createAttempt: async signal => {
      const transientRetry = attemptIndex > 0 ? attemptIndex : undefined
      attemptIndex++
      const client = getGrokClient({
        maxRetries: 0,
        fetchOverride: params.fetchOverride,
        source: params.source,
      })
      return createResponsesStreamWithClient({
        client,
        request,
        signal,
        headers: {
          Accept: 'text/event-stream',
          ...buildGrokRequestHeaders({
            model: params.model,
            sessionId: params.sessionId,
            requestId,
            agentId: params.agentId,
            transientRetry,
          }),
        },
      })
    },
  }
}

export function clearGrokClientCache(): void {
  cachedClients.clear()
}
