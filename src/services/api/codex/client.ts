import OpenAI from 'openai'
import { openaiAdapter } from 'src/services/providerUsage/adapters/openai.js'
import { updateProviderBuckets } from 'src/services/providerUsage/store.js'
import { getSessionId } from 'src/bootstrap/state.js'
import { getProxyFetchOptions } from 'src/utils/proxy.js'
import {
  CHATGPT_ACCOUNT_ID_HEADER,
  CHATGPT_CODEX_BASE_URL,
  CODEX_ORIGINATOR,
  DEFAULT_CODEX_API_BASE_URL,
  type CodexRequestContext,
} from './credentials.js'

export const DEFAULT_CODEX_BASE_URL = DEFAULT_CODEX_API_BASE_URL
export { CHATGPT_CODEX_BASE_URL, CHATGPT_ACCOUNT_ID_HEADER }

let cachedClient: { key: string; client: OpenAI } | null = null

function withCodexIdentityHeaders(base: typeof fetch): typeof fetch {
  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const headers = new Headers(init?.headers)
    if (!headers.has('session-id')) {
      const sessionId = getSessionId()
      headers.set('session-id', sessionId)
      headers.set('thread-id', sessionId)
    }
    return base(input, { ...init, headers })
  }
  return wrapped as unknown as typeof fetch
}

function wrapFetchForUsage(base: typeof fetch): typeof fetch {
  const wrapped = async (
    ...args: Parameters<typeof fetch>
  ): Promise<Response> => {
    const res = await base(...args)
    try {
      updateProviderBuckets('codex', openaiAdapter.parseHeaders(res.headers))
    } catch {
      // Usage tracking must not affect the request path.
    }
    return res
  }
  return wrapped as unknown as typeof fetch
}

function cacheKey(ctx: CodexRequestContext, maxRetries: number): string {
  return `${ctx.baseURL}\0${ctx.apiKey}\0${ctx.accountId ?? ''}\0${maxRetries}`
}

export function getCodexClient(
  options: {
    maxRetries?: number
    fetchOverride?: typeof fetch
  } & CodexRequestContext,
): OpenAI {
  const maxRetries = options.maxRetries ?? 0
  const ctx: CodexRequestContext = {
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    accountId: options.accountId,
  }
  const key = cacheKey(ctx, maxRetries)

  if (cachedClient && cachedClient.key === key && !options.fetchOverride) {
    return cachedClient.client
  }

  const baseFetch = options.fetchOverride ?? (globalThis.fetch as typeof fetch)
  const wrappedFetch = wrapFetchForUsage(withCodexIdentityHeaders(baseFetch))

  const client = new OpenAI({
    apiKey: ctx.apiKey,
    baseURL: ctx.baseURL,
    maxRetries,
    timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    dangerouslyAllowBrowser: true,
    fetchOptions: getProxyFetchOptions({ forAnthropicAPI: false }),
    fetch: wrappedFetch,
    defaultHeaders: {
      originator: CODEX_ORIGINATOR,
      ...(ctx.accountId && { [CHATGPT_ACCOUNT_ID_HEADER]: ctx.accountId }),
    },
  })

  if (!options.fetchOverride) {
    cachedClient = { key, client }
  }

  return client
}

export function clearCodexClientCache(): void {
  cachedClient = null
}
