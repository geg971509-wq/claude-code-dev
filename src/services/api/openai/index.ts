import type {
  BetaToolUnion,
  BetaMessage,
  BetaRawMessageStreamEvent,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions.mjs'
import type { SystemPrompt } from '../../../utils/systemPromptType.js'
import type {
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  AssistantMessage,
  UserMessage,
} from '../../../types/message.js'
import type { AgentId } from '../../../types/ids.js'
import type { Tools } from '../../../Tool.js'
import { getSessionId } from '../../../bootstrap/state.js'
import { getOpenAIClient } from './client.js'
import {
  formatOpenAIErrorMessage,
  formatOpenAIErrorStack,
  formatOpenAIErrorWithStack,
  formatOpenAIPromptCacheKey,
  getOpenAIRequestMaxRetries,
  getOpenAIRetryDelayMs,
  getOpenAIStreamMaxRetries,
  isOpenAIUserAbortError,
  isTransientOpenAIError,
  toProviderHttpError,
  updateOpenAIUsage,
  withOpenAIStreamIdleTimeout,
  type OpenAIUsageCounters,
} from './openaiShared.js'
import {
  getAssistantMessageFromError,
  isProviderContextOverflowError,
  isProviderRateLimitError,
  isProviderRequestTooLargeError,
} from '../errors.js'
// Use Anthropic's abort class so claude.ts `instanceof APIUserAbortError` matches.
import { APIUserAbortError } from '@anthropic-ai/sdk'
import {
  anthropicMessagesToOpenAI,
  resolveOpenAIModel,
  adaptOpenAIStreamToAnthropic,
  anthropicToolsToOpenAI,
  anthropicToolChoiceToOpenAI,
  ProviderStreamError,
} from '@ant/model-provider'
import { isChatGPTAuthEnabled } from './chatgptAuth.js'
import {
  adaptResponsesStreamToAnthropic,
  buildResponsesRequest,
  createChatGPTResponsesStream,
  createOfficialResponsesStream,
  type OpenAIStreamAttempt,
  type ResponsesReasoningEffort,
} from './responsesAdapter.js'
import {
  logOpenAIRawLifecycle,
  logOpenAIRawStream,
  type OpenAIRawStreamRoute,
} from './rawStreamLogger.js'
import { normalizeMessagesForAPI } from '../../../utils/messages.js'
import { toolToAPISchema } from '../../../utils/api.js'
import {
  getEmptyToolPermissionContext,
  toolMatchesName,
} from '../../../Tool.js'
import { logForDebugging } from '../../../utils/debug.js'
import { addToTotalSessionCost } from '../../../cost-tracker.js'
import { calculateUSDCost } from '../../../utils/modelCost.js'
import {
  isOpenAIThinkingEnabled,
  resolveOpenAIMaxTokens,
  buildOpenAIRequestBody,
  shouldUseOpenAIResponsesAPI,
  resolveOpenAIPromptCacheKey,
} from './requestBody.js'
import { recordLLMObservation } from '../../../services/langfuse/tracing.js'
import {
  convertMessagesToLangfuse,
  convertOutputToLangfuse,
  convertToolsToLangfuse,
} from '../../../services/langfuse/convert.js'
export {
  isOpenAIThinkingEnabled,
  resolveOpenAIMaxTokens,
  buildOpenAIRequestBody,
  shouldUseOpenAIResponsesAPI,
  resolveOpenAIPromptCacheKey,
}
import { getModelMaxOutputTokens } from '../../../utils/context.js'
import type { Options } from '../claude.js'
import { randomUUID } from 'crypto'
import {
  createAssistantAPIErrorMessage,
  createSystemAPIErrorMessage,
  createUserMessage,
  normalizeContentFromAPI,
} from '../../../utils/messages.js'
import { createCombinedAbortSignal } from '../../../utils/combinedAbortSignal.js'
import { sleep } from '../../../utils/sleep.js'
import type { SDKAssistantMessageError } from '../../../entrypoints/agentSdkTypes.js'
import {
  isSearchExtraToolsEnabled,
  isDeferredToolsDeltaEnabled,
} from '../../../utils/searchExtraTools.js'
import {
  formatDeferredToolLine,
  isDeferredTool,
  SEARCH_EXTRA_TOOLS_TOOL_NAME,
} from '@claude-code-best/builtin-tools/tools/SearchExtraToolsTool/prompt.js'

function convertToResponsesReasoningEffort(
  effortValue: unknown,
): ResponsesReasoningEffort | undefined {
  if (effortValue === 'low') return 'low'
  if (effortValue === 'medium') return 'medium'
  if (effortValue === 'high') return 'high'
  if (effortValue === 'xhigh') return 'xhigh'
  if (effortValue === 'max') return 'max'
  if (typeof effortValue === 'number') return 'high'
  return undefined
}

function getChatGPTResponsesReasoningEffort(
  effortValue: unknown,
): ResponsesReasoningEffort | undefined {
  const envOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL?.toLowerCase()
  if (envOverride === 'auto' || envOverride === 'unset') return undefined
  return (
    convertToResponsesReasoningEffort(envOverride) ??
    convertToResponsesReasoningEffort(effortValue) ??
    'medium'
  )
}

/**
 * Mirrors the Anthropic request path's deferred-tool announcement for OpenAI.
 *
 * OpenAI-compatible endpoints cannot consume Anthropic's `defer_loading` or
 * `tool_reference` beta payloads directly, so the model needs the same textual
 * list of deferred MCP tool names that Anthropic receives before it can ask
 * SearchExtraToolsTool to load their full schemas.
 */
function prependDeferredToolListIfNeeded(
  messages: (AssistantMessage | UserMessage)[],
  tools: Tools,
  deferredToolNames: Set<string>,
  useSearchExtraTools: boolean,
): (AssistantMessage | UserMessage)[] {
  if (!useSearchExtraTools || isDeferredToolsDeltaEnabled()) return messages

  const deferredToolList = tools
    .filter(tool => deferredToolNames.has(tool.name))
    .map(formatDeferredToolLine)
    .sort()
    .join('\n')

  if (!deferredToolList) return messages

  return [
    createUserMessage({
      content: `<available-deferred-tools>\n${deferredToolList}\n</available-deferred-tools>`,
      isMeta: true,
    }),
    ...messages,
  ]
}

function isOpenAIConvertibleMessage(
  msg: Message,
): msg is AssistantMessage | UserMessage {
  return msg.type === 'assistant' || msg.type === 'user'
}

function isSemanticOpenAIEvent(event: BetaRawMessageStreamEvent): boolean {
  if (event.type === 'content_block_delta') {
    const delta = event.delta
    if (delta.type === 'text_delta') return delta.text.length > 0
    if (delta.type === 'thinking_delta') return delta.thinking.length > 0
    if (delta.type === 'signature_delta') return delta.signature.length > 0
    if (delta.type === 'input_json_delta') return delta.partial_json.length > 0
    return true
  }
  if (event.type !== 'content_block_start') return false
  const block = event.content_block
  if (block.type === 'tool_use') {
    return block.id.length > 0 || block.name.length > 0
  }
  if (block.type === 'text') return block.text.length > 0
  if (block.type === 'thinking') {
    return block.thinking.length > 0 || block.signature.length > 0
  }
  return true
}

function asRetryError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(formatOpenAIErrorMessage(error))
}

/**
 * Assemble the final AssistantMessage (and optional max_tokens error) from
 * accumulated stream state after a validated message_stop terminal event.
 */
function assembleFinalAssistantOutputs(params: {
  partialMessage: BetaMessage | null
  contentBlocks: Record<number, Record<string, unknown>>
  tools: Tools
  agentId: string | undefined
  usage: OpenAIUsageCounters
  stopReason: string | null
  maxTokens: number
  requestId: string | null
}): (AssistantMessage | SystemAPIErrorMessage)[] {
  const {
    partialMessage,
    contentBlocks,
    tools,
    agentId,
    usage,
    stopReason,
    maxTokens,
    requestId,
  } = params
  const outputs: (AssistantMessage | SystemAPIErrorMessage)[] = []

  const allBlocks = Object.keys(contentBlocks)
    .sort((a, b) => Number(a) - Number(b))
    .map(k => contentBlocks[Number(k)])
    .filter(Boolean)

  if (allBlocks.length > 0 && partialMessage) {
    outputs.push({
      message: {
        ...partialMessage,
        content: normalizeContentFromAPI(
          allBlocks as unknown as BetaMessage['content'],
          tools,
          agentId as AgentId | undefined,
        ),
        usage,
        stop_reason: stopReason,
        stop_sequence: null,
      } as AssistantMessage['message'],
      requestId: requestId ?? undefined,
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
    } as AssistantMessage)
  }

  if (stopReason === 'max_tokens') {
    outputs.push(
      createAssistantAPIErrorMessage({
        content:
          `Output truncated: response exceeded the ${maxTokens} token limit. ` +
          `Set OPENAI_MAX_TOKENS or CLAUDE_CODE_MAX_OUTPUT_TOKENS to override.`,
        apiError: 'max_output_tokens',
        error: 'max_output_tokens',
      }),
    )
  }

  return outputs
}

/**
 * OpenAI-compatible query path. Converts Anthropic-format messages/tools to
 * OpenAI format, calls the OpenAI-compatible endpoint, and converts the
 * SSE stream back to Anthropic BetaRawMessageStreamEvent for consumption
 * by the existing query pipeline.
 */
export async function* queryModelOpenAI(
  messages: Message[],
  systemPrompt: SystemPrompt,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  try {
    // 1. Resolve model name
    const openaiModel = resolveOpenAIModel(options.model)

    // 2. Normalize messages using shared preprocessing
    const messagesForAPI = normalizeMessagesForAPI(messages, tools)

    // 3. Check if tool search is enabled (similar to Anthropic path)
    const useSearchExtraTools = await isSearchExtraToolsEnabled(
      options.model,
      tools,
      options.getToolPermissionContext ||
        (async () => getEmptyToolPermissionContext()),
      options.agents || [],
      options.querySource,
    )

    // 4. Build deferred tools set (similar to Anthropic path)
    const deferredToolNames = new Set<string>()
    if (useSearchExtraTools) {
      for (const t of tools) {
        if (isDeferredTool(t)) deferredToolNames.add(t.name)
      }
    }

    // 5. Filter tools (similar to Anthropic path)
    // Never include deferred tools in the API tools array — they are invoked
    // via ExecuteExtraTool which looks them up from the global tool registry
    // at runtime. Keeping the tools array stable preserves the prompt cache.
    let filteredTools = tools
    if (useSearchExtraTools && deferredToolNames.size > 0) {
      filteredTools = tools.filter(tool => {
        // Always include non-deferred tools
        if (!deferredToolNames.has(tool.name)) return true
        // Always include SearchExtraToolsTool (so it can discover more tools)
        if (toolMatchesName(tool, SEARCH_EXTRA_TOOLS_TOOL_NAME)) return true
        // All other deferred tools are excluded — use ExecuteExtraTool instead
        return false
      })
    }

    // 6. Build tool schemas with deferLoading flag
    const toolSchemas = await Promise.all(
      filteredTools.map(tool =>
        toolToAPISchema(tool, {
          getToolPermissionContext: options.getToolPermissionContext,
          tools,
          agents: options.agents,
          allowedAgentTypes: options.allowedAgentTypes,
          model: options.model,
          deferLoading: useSearchExtraTools && deferredToolNames.has(tool.name),
        }),
      ),
    )

    // 7. Filter out non-standard tools (server tools like advisor)
    const standardTools = toolSchemas.filter(
      (t): t is BetaToolUnion & { type: string } => {
        const anyT = t as unknown as Record<string, unknown>
        return (
          anyT.type !== 'advisor_20260301' && anyT.type !== 'computer_20250124'
        )
      },
    )

    // 8. Convert messages and tools to OpenAI format
    const enableThinking = isOpenAIThinkingEnabled(openaiModel)
    const openAIConvertibleMessages = messagesForAPI.filter(
      isOpenAIConvertibleMessage,
    )
    const messagesWithDeferredToolList = prependDeferredToolListIfNeeded(
      openAIConvertibleMessages,
      tools,
      deferredToolNames,
      useSearchExtraTools,
    )
    const openaiMessages = anthropicMessagesToOpenAI(
      messagesWithDeferredToolList,
      systemPrompt,
      { enableThinking },
    )
    const openaiTools = anthropicToolsToOpenAI(standardTools)
    const openaiToolChoice = anthropicToolChoiceToOpenAI(options.toolChoice)
    const reasoningEffort = getChatGPTResponsesReasoningEffort(
      options.effortValue,
    )

    // 9. Log tool filtering details
    if (useSearchExtraTools) {
      const includedDeferredTools = filteredTools.filter(t =>
        deferredToolNames.has(t.name),
      ).length
      logForDebugging(
        `[OpenAI] Tool search enabled: ${includedDeferredTools}/${deferredToolNames.size} deferred tools included, total tools=${openaiTools.length}`,
      )
    } else {
      logForDebugging(
        `[OpenAI] Tool search disabled, total tools=${openaiTools.length}`,
      )
    }

    // 10. Compute max_tokens — required by most OpenAI-compatible endpoints.
    //     Without this the server uses a tiny default, and when
    //     thinking is enabled the thinking phase consumes the entire budget
    //     leaving no tokens for the final response.
    //
    //     Use upperLimit (not the slot-cap default) because the Anthropic path's
    //     slot-reservation cap (CAPPED_DEFAULT_MAX_TOKENS=8k) is paired with an
    //     auto-retry at 64k in query.ts. The OpenAI path has no such retry, so
    //     using the capped 8k default would silently truncate responses in
    //     multi-turn conversations where thinking consumes most of the budget.
    //
    //     Override priority:
    //     1. options.maxOutputTokensOverride (programmatic)
    //     2. OPENAI_MAX_TOKENS env var (OpenAI-specific, useful for local models
    //        with small context windows, e.g. RTX 3060 12GB running 65536-token models)
    //     3. CLAUDE_CODE_MAX_OUTPUT_TOKENS env var (generic override)
    //     4. upperLimit default (64000)
    const { upperLimit } = getModelMaxOutputTokens(openaiModel)
    const maxTokens = resolveOpenAIMaxTokens(
      upperLimit,
      options.maxOutputTokensOverride,
    )

    // 11. Call OpenAI API with streaming.
    // - ChatGPT subscription auth → Codex Responses (no max_output_tokens).
    // - API-key + capable base + o*/gpt-5* (or OPENAI_USE_RESPONSES=1) →
    //   official /v1/responses (with max_output_tokens).
    // - API-key otherwise → Chat Completions (custom proxies stay here by default).
    const useChatGPTResponses = isChatGPTAuthEnabled()
    const useOfficialResponses =
      !useChatGPTResponses && shouldUseOpenAIResponsesAPI(openaiModel)
    const openaiRoute: OpenAIRawStreamRoute = useChatGPTResponses
      ? 'chatgpt-responses'
      : useOfficialResponses
        ? 'official-responses'
        : 'chat-completions'
    const promptCacheKey =
      resolveOpenAIPromptCacheKey() ??
      formatOpenAIPromptCacheKey(getSessionId())
    logForDebugging(
      `[OpenAI] route=${openaiRoute} model=${openaiModel} messages=${openaiMessages.length}, tools=${openaiTools.length}, thinking=${enableThinking}, maxTokens=${maxTokens}, prompt_cache_key=${promptCacheKey}`,
    )
    const createAttempt = async (
      attemptSignal: AbortSignal,
    ): Promise<OpenAIStreamAttempt> => {
      if (useChatGPTResponses) {
        return createChatGPTResponsesStream({
          request: buildResponsesRequest({
            model: openaiModel,
            messages: openaiMessages,
            tools: openaiTools,
            toolChoice: openaiToolChoice,
            reasoningEffort,
            promptCacheKey,
          }),
          signal: attemptSignal,
          fetchOverride: options.fetchOverride as unknown as typeof fetch,
        })
      }
      if (useOfficialResponses) {
        return createOfficialResponsesStream({
          request: buildResponsesRequest({
            model: openaiModel,
            messages: openaiMessages,
            tools: openaiTools,
            toolChoice: openaiToolChoice,
            reasoningEffort,
            maxOutputTokens: maxTokens,
            promptCacheKey,
          }),
          signal: attemptSignal,
          fetchOverride: options.fetchOverride as unknown as typeof fetch,
          source: options.querySource,
        })
      }

      const promise = getOpenAIClient({
        maxRetries: 0,
        fetchOverride: options.fetchOverride as unknown as typeof fetch,
        source: options.querySource,
      }).chat.completions.create(
        buildOpenAIRequestBody({
          model: openaiModel,
          messages: openaiMessages,
          tools: openaiTools,
          toolChoice: openaiToolChoice,
          enableThinking,
          maxTokens,
          temperatureOverride: options.temperatureOverride,
          promptCacheKey,
          reasoningEffort:
            reasoningEffort === 'max' ? 'xhigh' : reasoningEffort,
        }),
        { signal: attemptSignal },
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
    }

    const requestMaxRetries = getOpenAIRequestMaxRetries()
    const streamMaxRetries = getOpenAIStreamMaxRetries()
    const collectedMessages: AssistantMessage[] = []
    const start = Date.now()
    let finalUsage: OpenAIUsageCounters = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }
    let finalTtftMs = 0
    let requestRetries = 0
    let streamRetries = 0
    let requestAttempt = 0

    for (;;) {
      requestAttempt++
      const streamId = randomUUID()
      const attemptController = new AbortController()
      const combinedSignal = createCombinedAbortSignal(signal, {
        signalB: attemptController.signal,
      })
      let attempt: OpenAIStreamAttempt

      try {
        attempt = await createAttempt(combinedSignal.signal)
      } catch (error) {
        combinedSignal.cleanup()
        attemptController.abort()
        logOpenAIRawLifecycle({
          lifecycle: 'error',
          route: openaiRoute,
          model: openaiModel,
          source: options.querySource,
          streamId,
          requestAttempt,
          streamAttempt: streamRetries + 1,
          phase: 'request',
          error,
        })
        if (
          signal.aborted ||
          isOpenAIUserAbortError(error) ||
          !isTransientOpenAIError(error) ||
          requestRetries >= requestMaxRetries
        ) {
          throw error
        }

        requestRetries++
        const delayMs = getOpenAIRetryDelayMs(error, requestRetries)
        logOpenAIRawLifecycle({
          lifecycle: 'retry',
          route: openaiRoute,
          model: openaiModel,
          source: options.querySource,
          streamId,
          requestAttempt,
          streamAttempt: streamRetries + 1,
          phase: 'request',
          attempt: requestRetries,
          maxRetries: requestMaxRetries,
          delayMs,
          error,
        })
        yield createSystemAPIErrorMessage(
          asRetryError(error),
          delayMs,
          requestRetries,
          requestMaxRetries,
        )
        await sleep(delayMs, signal, { throwOnAbort: true })
        continue
      }

      let partialMessage: BetaMessage | null = null
      const contentBlocks: Record<number, Record<string, unknown>> = {}
      let usage: OpenAIUsageCounters = {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }
      let stopReason: string | null = null
      let ttftMs = 0
      let committed = false
      let completed = false
      let eventCount = 0
      let streamError: unknown
      const prelude: StreamEvent[] = []

      try {
        const timedStream = withOpenAIStreamIdleTimeout(attempt.stream, {
          abortAttempt: () => attemptController.abort(),
          userSignal: signal,
          requestId: attempt.requestId,
        })
        const rawStream = logOpenAIRawStream(timedStream, {
          route: openaiRoute,
          model: openaiModel,
          source: options.querySource,
          streamId,
          requestAttempt,
          streamAttempt: streamRetries + 1,
          status: String(attempt.status),
          requestId: attempt.requestId ?? undefined,
        })
        const adaptedStream: AsyncIterable<BetaRawMessageStreamEvent> =
          openaiRoute === 'chat-completions'
            ? adaptOpenAIStreamToAnthropic(
                rawStream as AsyncIterable<ChatCompletionChunk>,
                openaiModel,
                { includeCacheWriteTokens: !!promptCacheKey },
              )
            : adaptResponsesStreamToAnthropic(rawStream, openaiModel)

        for await (const event of adaptedStream) {
          eventCount++
          if (
            !committed &&
            (isSemanticOpenAIEvent(event) || event.type === 'message_stop')
          ) {
            committed = true
            for (const bufferedEvent of prelude) yield bufferedEvent
            prelude.length = 0
          }

          switch (event.type) {
            case 'message_start': {
              partialMessage = event.message
              ttftMs = Date.now() - start
              if (event.message.usage) {
                usage = {
                  ...usage,
                  ...(event.message.usage as unknown as typeof usage),
                }
              }
              break
            }
            case 'content_block_start': {
              const idx = event.index
              const cb = event.content_block
              if (cb.type === 'tool_use') {
                contentBlocks[idx] = { ...cb, input: '' }
              } else if (cb.type === 'text') {
                contentBlocks[idx] = { ...cb, text: '' }
              } else if (cb.type === 'thinking') {
                contentBlocks[idx] = { ...cb, thinking: '', signature: '' }
              } else {
                contentBlocks[idx] = { ...cb }
              }
              break
            }
            case 'content_block_delta': {
              const idx = event.index
              const delta = event.delta
              const block = contentBlocks[idx]
              if (!block) break
              if (delta.type === 'text_delta') {
                block.text =
                  ((block.text as string | undefined) || '') + delta.text
              } else if (delta.type === 'input_json_delta') {
                block.input =
                  ((block.input as string | undefined) || '') +
                  delta.partial_json
              } else if (delta.type === 'thinking_delta') {
                block.thinking =
                  ((block.thinking as string | undefined) || '') +
                  delta.thinking
              } else if (delta.type === 'signature_delta') {
                block.signature = delta.signature
              }
              break
            }
            case 'content_block_stop':
              break
            case 'message_delta': {
              if (event.usage) {
                usage = updateOpenAIUsage(
                  usage,
                  event.usage as unknown as Parameters<
                    typeof updateOpenAIUsage
                  >[1],
                )
              }
              if (event.delta.stop_reason != null) {
                stopReason = event.delta.stop_reason
              }
              break
            }
            case 'message_stop': {
              completed = true
              if (partialMessage) {
                for (const output of assembleFinalAssistantOutputs({
                  partialMessage,
                  contentBlocks,
                  tools,
                  agentId: options.agentId,
                  usage,
                  stopReason,
                  maxTokens,
                  requestId: attempt.requestId,
                })) {
                  if (output.type === 'assistant') {
                    collectedMessages.push(output)
                  }
                  yield output
                }
              }
              finalUsage = usage
              finalTtftMs = ttftMs
              if (usage.input_tokens + usage.output_tokens > 0) {
                const costUSD = calculateUSDCost(
                  openaiModel,
                  usage as unknown as BetaUsage,
                )
                addToTotalSessionCost(
                  costUSD,
                  usage as unknown as BetaUsage,
                  options.model,
                )
              }
              break
            }
          }

          const streamEvent = {
            type: 'stream_event',
            event,
            ...(event.type === 'message_start' ? { ttftMs } : undefined),
          } as StreamEvent
          if (committed) yield streamEvent
          else prelude.push(streamEvent)
        }

        if (!completed) {
          throw new ProviderStreamError(
            'OpenAI stream ended before message_stop',
            {
              kind: 'premature_eof',
              retryable: true,
              terminal: false,
              completionState: 'open',
              requestId: attempt.requestId,
            },
          )
        }
      } catch (error) {
        streamError = error
        logOpenAIRawLifecycle({
          lifecycle: 'error',
          route: openaiRoute,
          model: openaiModel,
          source: options.querySource,
          streamId,
          requestAttempt,
          streamAttempt: streamRetries + 1,
          status: String(attempt.status),
          requestId: attempt.requestId ?? undefined,
          phase: 'stream',
          eventCount,
          error,
        })
      } finally {
        attempt.cleanup()
        combinedSignal.cleanup()
        attemptController.abort()
      }

      if (streamError !== undefined) {
        if (
          signal.aborted ||
          isOpenAIUserAbortError(streamError) ||
          committed ||
          !isTransientOpenAIError(streamError) ||
          streamRetries >= streamMaxRetries
        ) {
          throw streamError
        }

        streamRetries++
        const delayMs = getOpenAIRetryDelayMs(streamError, streamRetries)
        logOpenAIRawLifecycle({
          lifecycle: 'retry',
          route: openaiRoute,
          model: openaiModel,
          source: options.querySource,
          streamId,
          requestAttempt,
          streamAttempt: streamRetries,
          status: String(attempt.status),
          requestId: attempt.requestId ?? undefined,
          phase: 'stream',
          attempt: streamRetries,
          maxRetries: streamMaxRetries,
          delayMs,
          error: streamError,
        })
        yield createSystemAPIErrorMessage(
          asRetryError(streamError),
          delayMs,
          streamRetries,
          streamMaxRetries,
        )
        await sleep(delayMs, signal, { throwOnAbort: true })
        continue
      }

      break
    }

    recordLLMObservation(options.langfuseTrace ?? null, {
      model: openaiModel,
      provider: 'openai',
      input: convertMessagesToLangfuse(openaiMessages),
      output: convertOutputToLangfuse(collectedMessages),
      usage: {
        input_tokens: finalUsage.input_tokens,
        output_tokens: finalUsage.output_tokens,
        cache_creation_input_tokens: finalUsage.cache_creation_input_tokens,
        cache_read_input_tokens: finalUsage.cache_read_input_tokens,
      },
      startTime: new Date(start),
      endTime: new Date(),
      completionStartTime:
        finalTtftMs > 0 ? new Date(start + finalTtftMs) : undefined,
      tools: convertToolsToLangfuse(toolSchemas as unknown[]),
      ...(enableThinking && { thinking: { type: 'enabled' } }),
    })
  } catch (error) {
    // ESC / AbortSignal must not become "API Error: …" (Anthropic path rethrows).
    if (signal.aborted || isOpenAIUserAbortError(error)) {
      logForDebugging('[OpenAI] Aborted by user/signal', { level: 'info' })
      if (error instanceof APIUserAbortError) throw error
      throw new APIUserAbortError()
    }
    // Lift SDK/fetch errors into layered types (overflow / too-large / 429).
    const layered =
      isProviderContextOverflowError(error) ||
      isProviderRequestTooLargeError(error) ||
      isProviderRateLimitError(error)
        ? error
        : toProviderHttpError(error)
    if (
      layered &&
      (isProviderContextOverflowError(layered) ||
        isProviderRequestTooLargeError(layered) ||
        isProviderRateLimitError(layered))
    ) {
      logForDebugging(
        `[OpenAI] Layered error: ${formatOpenAIErrorMessage(layered)}`,
        { level: 'error' },
      )
      yield getAssistantMessageFromError(layered, options.model)
      return
    }
    const errorMessage = formatOpenAIErrorMessage(error)
    // Full stack + cause chain in debug log; short stack also on user surface.
    logForDebugging(
      `[OpenAI] Error: ${errorMessage}\n${formatOpenAIErrorStack(error, 16)}`,
      { level: 'error' },
    )
    yield createAssistantAPIErrorMessage({
      content: `API Error: ${formatOpenAIErrorWithStack(error, 8)}`,
      apiError: 'api_error',
      error: (error instanceof Error
        ? error
        : new Error(errorMessage)) as unknown as SDKAssistantMessageError,
    })
  }
}
