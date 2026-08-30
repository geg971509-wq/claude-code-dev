import OpenAI from 'openai'
import { getSessionId } from 'src/bootstrap/state.js'
import { openaiAdapter } from 'src/services/providerUsage/adapters/openai.js'
import { updateProviderBuckets } from 'src/services/providerUsage/store.js'
import { getProxyFetchOptions } from 'src/utils/proxy.js'
import {
  CHATGPT_ACCOUNT_ID_HEADER,
  CHATGPT_CODEX_BASE_URL,
  CODEX_ORIGINATOR,
  DEFAULT_CODEX_API_BASE_URL,
  type CodexRequestContext,
} from './credentials.js'
import {
  applyCodexIdentityHeaders,
  createCodexRequestIdentity,
  type CodexRequestIdentity,
} from './requestMetadata.js'

export const DEFAULT_CODEX_BASE_URL = DEFAULT_CODEX_API_BASE_URL
export { CHATGPT_CODEX_BASE_URL, CHATGPT_ACCOUNT_ID_HEADER }

export const CODEX_TURN_STATE_HEADER = 'x-codex-turn-state'

export type CodexTurnState = {
  value?: string
}

export function createCodexTurnState(): CodexTurnState {
  return {}
}

let cachedClient: { key: string; client: OpenAI } | null = null

function resolveRequestIdentity(
  requestIdentity: CodexRequestIdentity | undefined,
): CodexRequestIdentity {
  if (requestIdentity) {
    return requestIdentity
  }

  return createCodexRequestIdentity({ sessionId: getSessionId() })
}

function withCodexIdentityHeaders(
  base: typeof fetch,
  turnState?: CodexTurnState,
  requestIdentity?: CodexRequestIdentity,
): typeof fetch {
  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const headers = new Headers(init?.headers)
    applyCodexIdentityHeaders(headers, resolveRequestIdentity(requestIdentity))
    if (turnState?.value && !headers.has(CODEX_TURN_STATE_HEADER)) {
      headers.set(CODEX_TURN_STATE_HEADER, turnState.value)
    }

    const response = await base(input, { ...init, headers })
    const responseTurnState = response.headers.get(CODEX_TURN_STATE_HEADER)
    if (turnState && !turnState.value && responseTurnState) {
      // Codex keeps the first turn-state token stable for the lifetime of a
      // single turn and never carries it into a later turn.
      turnState.value = responseTurnState
    }
    return response
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
      // Local usage display must not affect the request path.
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
    turnState?: CodexTurnState
    requestIdentity?: CodexRequestIdentity
  } & CodexRequestContext,
): OpenAI {
  const maxRetries = options.maxRetries ?? 0
  const ctx: CodexRequestContext = {
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    accountId: options.accountId,
  }
  const key = cacheKey(ctx, maxRetries)

  if (
    cachedClient &&
    cachedClient.key === key &&
    !options.fetchOverride &&
    !options.turnState &&
    !options.requestIdentity
  ) {
    return cachedClient.client
  }

  const baseFetch = options.fetchOverride ?? (globalThis.fetch as typeof fetch)
  const wrappedFetch = wrapFetchForUsage(
    withCodexIdentityHeaders(
      baseFetch,
      options.turnState,
      options.requestIdentity,
    ),
  )

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

  // A client carrying turn-scoped sticky routing state or request identity must
  // never be reused by another turn. Stateless clients remain cacheable.
  if (
    !options.fetchOverride &&
    !options.turnState &&
    !options.requestIdentity
  ) {
    cachedClient = { key, client }
  }

  return client
}

export function clearCodexClientCache(): void {
  cachedClient = null
}
