import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions/completions.mjs'
import { getSessionId } from '../../../bootstrap/state.js'
import {
  adaptOpenAIStreamToAnthropic,
  parseRetryAfterMs,
} from '@ant/model-provider'
import { getOrCreateUserID } from '../../../utils/config.js'
import {
  isChatGPTAuthEnabled,
  refreshChatGPTAuthAfterUnauthorized,
} from './chatgptAuth.js'
import { getOpenAIClient } from './client.js'
import { applyKimiAuthToEnv, isKimiAuthEnabled } from './kimiAuth.js'
import { getOfficialOpenAIPromptCacheKey } from './openaiShared.js'
import type { OpenAIRawStreamRoute } from './rawStreamLogger.js'
import {
  buildOpenAIRequestBody,
  resolveOpenAIPromptCacheKey,
  shouldUseOpenAIResponsesAPI,
  type OpenAIJSONOutputFormat,
} from './requestBody.js'
import {
  adaptResponsesStreamToAnthropic,
  buildChatGPTResponsesRequest,
  buildOfficialResponsesRequest,
  createChatGPTResponsesStream,
  createOfficialResponsesStream,
  type OpenAIStreamAttempt,
  type ResponsesReasoningEffort,
} from './responsesAdapter.js'
import { resolveCodexResponsesReasoningEffort } from './codexReasoning.js'

export type OpenAIStreamRequest = {
  model: string
  messages: unknown[]
  tools: unknown[]
  toolChoice: unknown
  enableThinking: boolean
  maxTokens: number
  temperatureOverride?: number
  reasoningEffort?: ResponsesReasoningEffort
  outputFormat?: OpenAIJSONOutputFormat
  stopSequences?: string[]
  fetchOverride?: typeof fetch
  source?: string
}

export type PreparedOpenAIStreamRequest = {
  route: OpenAIRawStreamRoute
  promptCacheKey?: string
  createAttempt: (signal: AbortSignal) => Promise<OpenAIStreamAttempt>
}

function getHttpErrorStatus(error: unknown): number | null {
  if (
    error &&
    typeof error === 'object' &&
    typeof (error as { status?: unknown }).status === 'number'
  ) {
    return (error as { status: number }).status
  }
  return null
}

export function prepareOpenAIStreamRequest(
  request: OpenAIStreamRequest,
): PreparedOpenAIStreamRequest {
  const useChatGPTResponses = isChatGPTAuthEnabled()
  const useOfficialResponses =
    !useChatGPTResponses && shouldUseOpenAIResponsesAPI(request.model)
  const route: OpenAIRawStreamRoute = useChatGPTResponses
    ? 'chatgpt-responses'
    : useOfficialResponses
      ? 'official-responses'
      : 'chat-completions'
  const sessionId = getSessionId()
  // ChatGPT/Codex private Responses: prompt_cache_key defaults to raw session_id
  // (codex-rs ModelClient::prompt_cache_key). API-key paths only auto-attach a
  // sticky key on official OpenAI hosts — OPENAI_USE_RESPONSES=1 on a custom
  // proxy must not inherit ccb: keys (compatible providers ignore or reject
  // OpenAI-specific params). Explicit OPENAI_PROMPT_CACHE_KEY only overrides
  // when a default key is already allowed for this host.
  const defaultPromptCacheKey = useChatGPTResponses
    ? sessionId
    : getOfficialOpenAIPromptCacheKey(process.env.OPENAI_BASE_URL, sessionId)
  const promptCacheKey = defaultPromptCacheKey
    ? (resolveOpenAIPromptCacheKey() ?? defaultPromptCacheKey)
    : undefined
  const responsesReasoningEffort =
    route === 'chat-completions'
      ? request.reasoningEffort
      : (resolveCodexResponsesReasoningEffort({
          model: request.model,
          configured: request.reasoningEffort,
          provider: 'openai',
        }) as ResponsesReasoningEffort | undefined)

  return {
    route,
    promptCacheKey,
    createAttempt: async signal => {
      if (useChatGPTResponses) {
        const createChatGPTAttempt = () =>
          createChatGPTResponsesStream({
            request: buildChatGPTResponsesRequest({
              model: request.model,
              messages: request.messages,
              tools: request.tools,
              toolChoice: request.toolChoice,
              reasoningEffort: responsesReasoningEffort,
              promptCacheKey,
              sessionId,
              // Inject here so buildChatGPTResponsesRequest stays I/O-free.
              installationId: getOrCreateUserID(),
              outputFormat: request.outputFormat,
            }),
            signal,
            sessionId,
            fetchOverride: request.fetchOverride,
          })

        try {
          return await createChatGPTAttempt()
        } catch (error) {
          if (getHttpErrorStatus(error) !== 401) {
            throw error
          }
          await refreshChatGPTAuthAfterUnauthorized()
          return createChatGPTAttempt()
        }
      }

      if (useOfficialResponses) {
        return createOfficialResponsesStream({
          request: buildOfficialResponsesRequest({
            model: request.model,
            messages: request.messages,
            tools: request.tools,
            toolChoice: request.toolChoice,
            reasoningEffort: responsesReasoningEffort,
            maxOutputTokens: request.maxTokens,
            promptCacheKey,
            outputFormat: request.outputFormat,
          }),
          signal,
          sessionId,
          fetchOverride: request.fetchOverride,
          source: request.source,
        })
      }

      // Kimi Code subscription: mirror the OAuth access token into
      // OPENAI_API_KEY (refreshing first when near expiry) so the plain
      // chat-completions path picks it up.
      if (isKimiAuthEnabled()) {
        await applyKimiAuthToEnv()
      }

      const promise = getOpenAIClient({
        maxRetries: 0,
        fetchOverride: request.fetchOverride,
        source: request.source,
        // The SDK's ReasoningEffort union is OpenAI-specific and has no `max`,
        // which Moonshot requires — cast at the boundary rather than lying
        // about what the body builder can emit.
      }).chat.completions.create(
        buildOpenAIRequestBody({
          model: request.model,
          messages: request.messages,
          tools: request.tools,
          toolChoice: request.toolChoice,
          enableThinking: request.enableThinking,
          maxTokens: request.maxTokens,
          temperatureOverride: request.temperatureOverride,
          promptCacheKey,
          reasoningEffort:
            request.reasoningEffort === 'max'
              ? 'xhigh'
              : request.reasoningEffort,
          outputFormat: request.outputFormat,
          stopSequences: request.stopSequences,
        }) as unknown as ChatCompletionCreateParamsStreaming,
        { signal },
      )
      const { data, response, request_id } = await promise.withResponse()
      return {
        stream: data as unknown as AsyncIterable<Record<string, unknown>>,
        status: response.status,
        requestId:
          request_id ??
          response.headers.get('x-request-id') ??
          response.headers.get('request-id'),
        retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
        cleanup: () => {
          data.controller.abort()
          void response.body?.cancel().catch(() => {})
        },
      }
    },
  }
}

export function adaptPreparedOpenAIStream(
  prepared: PreparedOpenAIStreamRequest,
  stream: AsyncIterable<Record<string, unknown>>,
  model: string,
) {
  return prepared.route === 'chat-completions'
    ? adaptOpenAIStreamToAnthropic(
        stream as AsyncIterable<ChatCompletionChunk>,
        model,
        { includeCacheWriteTokens: !!prepared.promptCacheKey },
      )
    : adaptResponsesStreamToAnthropic(stream, model)
}
