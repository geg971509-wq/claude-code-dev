import OpenAI from 'openai'
import type { ResponseCreateParamsStreaming } from 'openai/resources/responses/responses.mjs'
import { openaiAdapter } from 'src/services/providerUsage/adapters/openai.js'
import { updateProviderBuckets } from 'src/services/providerUsage/store.js'
import { getSessionId } from 'src/bootstrap/state.js'
import { abortable } from 'src/utils/abort.js'
import { getOrCreateUserID } from 'src/utils/config.js'
import { getProxyFetchOptions } from 'src/utils/proxy.js'
import { createResponsesStreamWithClient } from '../openai/responsesAdapter.js'
import type { PreparedOpenAIStreamAttempt } from '../openai/streamExecutor.js'
import {
  CHATGPT_ACCOUNT_ID_HEADER,
  CHATGPT_CODEX_BASE_URL,
  CODEX_ORIGINATOR,
  DEFAULT_CODEX_API_BASE_URL,
  forceRefreshCodexAuth,
  resolveCodexRequestContext,
  type CodexRequestContext,
} from './credentials.js'
import {
  applyCodexIdentityHeaders,
  buildCodexClientMetadata,
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
    applyCodexIdentityHeaders(
      headers,
      requestIdentity ??
        createCodexRequestIdentity({ sessionId: getSessionId() }),
    )
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

function cacheKey(
  ctx: CodexRequestContext,
  maxRetries: number,
  subscription: boolean,
): string {
  return `${ctx.baseURL}\0${ctx.apiKey}\0${ctx.accountId ?? ''}\0${maxRetries}\0${subscription}`
}

export function getCodexClient(
  options: {
    maxRetries?: number
    fetchOverride?: typeof fetch
    subscription?: boolean
    turnState?: CodexTurnState
    requestIdentity?: CodexRequestIdentity
  } & CodexRequestContext,
): OpenAI {
  const maxRetries = options.maxRetries ?? 0
  const subscription = options.subscription === true
  const ctx: CodexRequestContext = {
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    accountId: options.accountId,
  }
  const key = cacheKey(ctx, maxRetries, subscription)

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

function isUnauthorized(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { status?: unknown }).status === 401
  )
}

export function prepareCodexStreamRequest(params: {
  request: ResponseCreateParamsStreaming
  requestContext: CodexRequestContext
  subscription: boolean
  fetchOverride?: typeof fetch
}): PreparedOpenAIStreamAttempt {
  let replayedUnauthorized = false
  let requestContext = params.requestContext
  const sessionId = getSessionId()
  const turnState = createCodexTurnState()
  const requestIdentity = createCodexRequestIdentity({
    sessionId,
    installationId: getOrCreateUserID(),
  })
  const request = {
    ...params.request,
    prompt_cache_key:
      params.request.prompt_cache_key ?? requestIdentity.sessionId,
    client_metadata: buildCodexClientMetadata(requestIdentity),
  } as ResponseCreateParamsStreaming

  return {
    route: 'codex-responses',
    createAttempt: async signal => {
      for (;;) {
        if (params.subscription) {
          const latest = await resolveCodexRequestContext(signal)
          if (
            latest.baseURL !== params.requestContext.baseURL ||
            latest.accountId !== params.requestContext.accountId
          ) {
            throw new Error('Codex account changed before request retry')
          }
          requestContext = latest
        }
        const client = getCodexClient({
          maxRetries: 0,
          fetchOverride: params.fetchOverride,
          subscription: params.subscription,
          turnState,
          requestIdentity,
          ...requestContext,
        })
        try {
          return await createResponsesStreamWithClient({
            client,
            request,
            signal,
            headers: {
              Accept: 'text/event-stream',
            },
          })
        } catch (error) {
          if (
            !params.subscription ||
            !requestContext.accountId ||
            replayedUnauthorized ||
            !isUnauthorized(error)
          ) {
            throw error
          }

          replayedUnauthorized = true
          const rejectedAccessToken = requestContext.apiKey
          let refreshed
          try {
            refreshed = await abortable(
              forceRefreshCodexAuth(
                requestContext.accountId,
                rejectedAccessToken,
              ),
              signal,
            )
          } catch (refreshError) {
            if (signal.aborted) throw refreshError
            throw error
          }
          if (
            !refreshed?.accessToken ||
            refreshed.accountId !== requestContext.accountId ||
            refreshed.accessToken === rejectedAccessToken
          ) {
            throw error
          }
          requestContext = {
            ...requestContext,
            apiKey: refreshed.accessToken,
            accountId: refreshed.accountId,
          }
        }
      }
    },
  }
}
