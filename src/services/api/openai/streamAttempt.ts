import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions.mjs'
import { getSessionId } from '../../../bootstrap/state.js'
import { adaptOpenAIStreamToAnthropic } from '@ant/model-provider'
import { isChatGPTAuthEnabled } from './chatgptAuth.js'
import { getOpenAIClient } from './client.js'
import {
  formatOpenAIPromptCacheKey,
  getOfficialOpenAIPromptCacheKey,
} from './openaiShared.js'
import type { OpenAIRawStreamRoute } from './rawStreamLogger.js'
import {
  buildOpenAIRequestBody,
  resolveOpenAIPromptCacheKey,
  shouldUseOpenAIResponsesAPI,
  type OpenAIJSONOutputFormat,
} from './requestBody.js'
import {
  adaptResponsesStreamToAnthropic,
  buildResponsesRequest,
  createChatGPTResponsesStream,
  createOfficialResponsesStream,
  type OpenAIStreamAttempt,
  type ResponsesReasoningEffort,
} from './responsesAdapter.js'

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
  const defaultPromptCacheKey = useChatGPTResponses
    ? formatOpenAIPromptCacheKey(getSessionId())
    : getOfficialOpenAIPromptCacheKey(
        process.env.OPENAI_BASE_URL,
        getSessionId(),
      )
  const promptCacheKey = defaultPromptCacheKey
    ? (resolveOpenAIPromptCacheKey() ?? defaultPromptCacheKey)
    : undefined

  return {
    route,
    promptCacheKey,
    createAttempt: async signal => {
      if (useChatGPTResponses) {
        return createChatGPTResponsesStream({
          request: buildResponsesRequest({
            model: request.model,
            messages: request.messages,
            tools: request.tools,
            toolChoice: request.toolChoice,
            reasoningEffort: request.reasoningEffort,
            promptCacheKey,
            outputFormat: request.outputFormat,
          }),
          signal,
          fetchOverride: request.fetchOverride,
        })
      }

      if (useOfficialResponses) {
        return createOfficialResponsesStream({
          request: buildResponsesRequest({
            model: request.model,
            messages: request.messages,
            tools: request.tools,
            toolChoice: request.toolChoice,
            reasoningEffort: request.reasoningEffort,
            maxOutputTokens: request.maxTokens,
            promptCacheKey,
            outputFormat: request.outputFormat,
          }),
          signal,
          fetchOverride: request.fetchOverride,
          source: request.source,
        })
      }

      const promise = getOpenAIClient({
        maxRetries: 0,
        fetchOverride: request.fetchOverride,
        source: request.source,
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
        }),
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
        retryAfterMs: null,
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
