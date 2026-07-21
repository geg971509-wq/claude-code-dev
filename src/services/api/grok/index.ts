import type {
  BetaToolUnion,
  BetaMessage,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { SystemPrompt } from '../../../utils/systemPromptType.js'
import type {
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  AssistantMessage,
} from '../../../types/message.js'
import type { Tools } from '../../../Tool.js'
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions/completions.mjs'
import { getGrokClient } from './client.js'
import {
  formatOpenAIAssistantAPIError,
  formatOpenAIErrorMessage,
  formatOpenAIErrorStack,
  isOpenAIUserAbortError,
  toProviderHttpError,
  type TransientRetryInfo,
  updateOpenAIUsage,
  withOpenAIStreamIdleTimeout,
  withTransientOpenAIRetry,
} from '../openai/openaiShared.js'
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
  anthropicToolsToOpenAI,
  anthropicToolChoiceToOpenAI,
  adaptOpenAIStreamToAnthropic,
  ProviderStreamError,
  resolveGrokModel,
} from '@ant/model-provider'
import { normalizeMessagesForAPI } from '../../../utils/messages.js'
import type { SDKAssistantMessageError } from '../../../entrypoints/agentSdkTypes.js'
import { toolToAPISchema } from '../../../utils/api.js'
import { logForDebugging } from '../../../utils/debug.js'
import { addToTotalSessionCost } from '../../../cost-tracker.js'
import { calculateUSDCost } from '../../../utils/modelCost.js'
import { recordLLMObservation } from '../../../services/langfuse/tracing.js'
import {
  convertMessagesToLangfuse,
  convertOutputToLangfuse,
  convertToolsToLangfuse,
} from '../../../services/langfuse/convert.js'
import type { Options } from '../claude.js'
import { randomUUID } from 'crypto'
import {
  createAssistantAPIErrorMessage,
  normalizeContentFromAPI,
} from '../../../utils/messages.js'

/**
 * Grok (xAI) query path. Grok uses an OpenAI-compatible API, so we reuse
 * the OpenAI message/tool converters and stream adapter. Only the client
 * (different base URL + API key) and model mapping are Grok-specific.
 */
export async function* queryModelGrok(
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
    const grokModel = resolveGrokModel(options.model)
    const messagesForAPI = normalizeMessagesForAPI(messages, tools)

    const toolSchemas = await Promise.all(
      tools.map(tool =>
        toolToAPISchema(tool, {
          getToolPermissionContext: options.getToolPermissionContext,
          tools,
          agents: options.agents,
          allowedAgentTypes: options.allowedAgentTypes,
          model: options.model,
        }),
      ),
    )
    const standardTools = toolSchemas.filter(
      (t): t is BetaToolUnion & { type: string } => {
        const anyT = t as unknown as Record<string, unknown>
        return (
          anyT.type !== 'advisor_20260301' && anyT.type !== 'computer_20250124'
        )
      },
    )

    const openaiMessages = anthropicMessagesToOpenAI(
      messagesForAPI,
      systemPrompt,
    )
    const openaiTools = anthropicToolsToOpenAI(standardTools)
    const openaiToolChoice = anthropicToolChoiceToOpenAI(options.toolChoice)

    const client = getGrokClient({
      maxRetries: 0,
      fetchOverride: options.fetchOverride as typeof fetch | undefined,
      source: options.querySource,
    })

    logForDebugging(
      `[Grok] Calling model=${grokModel}, messages=${openaiMessages.length}, tools=${openaiTools.length}`,
    )

    // Transient 5xx/connection failures retry here — the Grok path bypasses
    // withRetry.ts (same as the OpenAI path).
    const {
      data: stream,
      response,
      request_id,
    } = await withTransientOpenAIRetry(
      () =>
        client.chat.completions
          .create(
            {
              model: grokModel,
              messages: openaiMessages,
              ...(openaiTools.length > 0 && {
                tools: openaiTools,
                ...(openaiToolChoice && { tool_choice: openaiToolChoice }),
              }),
              stream: true,
              stream_options: { include_usage: true },
              ...(options.temperatureOverride !== undefined && {
                temperature: options.temperatureOverride,
              }),
            } as ChatCompletionCreateParamsStreaming,
            {
              signal,
            },
          )
          .withResponse(),
      {
        signal,
        onRetry: ({
          attempt,
          maxRetries,
          delayMs,
          error,
        }: TransientRetryInfo) =>
          logForDebugging(
            `[Grok] Transient error (attempt ${attempt}/${maxRetries}, retrying in ${delayMs}ms): ${formatOpenAIErrorMessage(error)}`,
            { level: 'error' },
          ),
      },
    )

    const requestId =
      request_id ??
      response.headers.get('x-request-id') ??
      response.headers.get('request-id')
    const timedStream = withOpenAIStreamIdleTimeout(stream, {
      abortAttempt: () => stream.controller.abort(),
      userSignal: signal,
      requestId,
    })
    const adaptedStream = adaptOpenAIStreamToAnthropic(
      timedStream as AsyncIterable<ChatCompletionChunk>,
      grokModel,
    )

    const contentBlocks: Record<number, Record<string, unknown>> = {}
    const collectedMessages: AssistantMessage[] = []
    let partialMessage: BetaMessage | null = null
    let usage: {
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens: number
      cache_read_input_tokens: number
    } = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }
    let stopReason: string | null = null
    let completed = false
    let ttftMs = 0
    const start = Date.now()

    try {
      for await (const event of adaptedStream) {
        switch (event.type) {
          case 'message_start': {
            partialMessage = event.message
            ttftMs = Date.now() - start
            if (event.message.usage) {
              usage = updateOpenAIUsage(
                usage,
                event.message.usage as unknown as Parameters<
                  typeof updateOpenAIUsage
                >[1],
              )
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
                ((block.input as string | undefined) || '') + delta.partial_json
            } else if (delta.type === 'thinking_delta') {
              block.thinking =
                ((block.thinking as string | undefined) || '') + delta.thinking
            } else if (delta.type === 'signature_delta') {
              block.signature = delta.signature
            }
            break
          }
          case 'content_block_stop':
            break
          case 'message_delta': {
            if (event.delta.stop_reason != null) {
              stopReason = event.delta.stop_reason
            }
            if (event.usage) {
              usage = updateOpenAIUsage(
                usage,
                event.usage as unknown as Parameters<
                  typeof updateOpenAIUsage
                >[1],
              )
            }
            break
          }
          case 'message_stop': {
            completed = true
            const allBlocks = Object.keys(contentBlocks)
              .sort((a, b) => Number(a) - Number(b))
              .map(key => contentBlocks[Number(key)])
              .filter(Boolean)
            if (partialMessage && allBlocks.length > 0) {
              const message: AssistantMessage = {
                message: {
                  ...partialMessage,
                  content: normalizeContentFromAPI(
                    allBlocks as unknown as BetaMessage['content'],
                    tools,
                    options.agentId,
                  ),
                  usage,
                  stop_reason: stopReason,
                  stop_sequence: null,
                } as AssistantMessage['message'],
                requestId: requestId ?? undefined,
                type: 'assistant',
                uuid: randomUUID(),
                timestamp: new Date().toISOString(),
              }
              collectedMessages.push(message)
              yield message
            }
            if (usage.input_tokens + usage.output_tokens > 0) {
              const costUSD = calculateUSDCost(
                grokModel,
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

        yield {
          type: 'stream_event',
          event,
          ...(event.type === 'message_start' ? { ttftMs } : undefined),
        } as StreamEvent
      }

      if (!completed) {
        throw new ProviderStreamError(
          'Grok stream closed before message_stop',
          {
            kind: 'premature_eof',
            retryable: true,
            terminal: false,
            completionState: 'open',
            requestId,
          },
        )
      }
    } finally {
      stream.controller.abort()
      void response.body?.cancel().catch(() => {})
    }

    // Record LLM observation in Langfuse (no-op if not configured)
    recordLLMObservation(options.langfuseTrace ?? null, {
      model: grokModel,
      provider: 'grok',
      input: convertMessagesToLangfuse(messagesForAPI, systemPrompt),
      output: convertOutputToLangfuse(collectedMessages),
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
      },
      startTime: new Date(start),
      endTime: new Date(),
      completionStartTime: ttftMs > 0 ? new Date(start + ttftMs) : undefined,
      tools: convertToolsToLangfuse(toolSchemas as unknown[]),
    })
  } catch (error) {
    // Match OpenAI/Anthropic: user abort is not an API error surface.
    if (signal.aborted || isOpenAIUserAbortError(error)) {
      logForDebugging('[Grok] Aborted by user/signal', { level: 'info' })
      if (error instanceof APIUserAbortError) throw error
      throw new APIUserAbortError()
    }
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
        `[Grok] Layered error: ${formatOpenAIErrorMessage(layered)}`,
        { level: 'error' },
      )
      yield getAssistantMessageFromError(layered, options.model)
      return
    }
    const errorMessage = formatOpenAIErrorMessage(error)
    logForDebugging(
      `[Grok] Error: ${errorMessage}\n${formatOpenAIErrorStack(error, 16)}`,
      { level: 'error' },
    )
    const surface = formatOpenAIAssistantAPIError(error, 8)
    yield createAssistantAPIErrorMessage({
      content: surface.content,
      apiError: surface.apiError,
      error: surface.error as SDKAssistantMessageError,
      errorDetails: surface.errorDetails,
    })
  }
}
