import { randomUUID } from 'crypto'
import type {
  BetaMessage,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { ProviderStreamError } from '@ant/model-provider'
import type { AgentId } from '../../../types/ids.js'
import type {
  AssistantMessage,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../../types/message.js'
import type { Tools } from '../../../Tool.js'
import { createCombinedAbortSignal } from '../../../utils/combinedAbortSignal.js'
import { logForDebugging } from '../../../utils/debug.js'
import {
  createAssistantAPIErrorMessage,
  createSystemAPIErrorMessage,
  normalizeContentFromAPI,
} from '../../../utils/messages.js'
import { queryCheckpoint } from '../../../utils/queryProfiler.js'
import { sleep } from '../../../utils/sleep.js'
import {
  asOpenAIRetryError,
  createThinkingLoopDetector,
  createThinkingLoopError,
  getOpenAIRequestMaxRetries,
  getOpenAIRetryDelayMs,
  getOpenAIStreamMaxRetries,
  getThinkingLoopBackoffMs,
  getThinkingLoopMaxRetries,
  isOpenAIUserAbortError,
  isSemanticOpenAIEvent,
  isThinkingLoopError,
  isTransientOpenAIError,
  updateOpenAIUsage,
  withOpenAIStreamIdleTimeout,
  type OpenAIUsageCounters,
} from './openaiShared.js'
import {
  logOpenAIRawLifecycle,
  logOpenAIRawStream,
  type OpenAIRawStreamRoute,
} from './rawStreamLogger.js'

export type OpenAIStreamAttempt = {
  stream: AsyncIterable<Record<string, unknown>>
  status: number
  requestId: string | null
  retryAfterMs: number | null
  cleanup: () => void
}

export type PreparedOpenAIStreamAttempt = {
  route: OpenAIRawStreamRoute
  createAttempt: (signal: AbortSignal) => Promise<OpenAIStreamAttempt>
}

type OpenAIStreamAdapter = (
  stream: AsyncIterable<Record<string, unknown>>,
  model: string,
) => AsyncIterable<BetaRawMessageStreamEvent>

type OpenAIStreamExecutorOptions = {
  agentId?: string
  source?: string
  includeErrorStack?: boolean
  startTimeMs?: number
  onCompleted?: (usage: OpenAIUsageCounters) => void
  maxTokenOverrideEnv?: string
}

export type OpenAIStreamExecutionSummary = {
  collectedMessages: AssistantMessage[]
  usage: OpenAIUsageCounters
  ttftMs: number
  requestId: string | null
}

type OpenAIStreamExecutorOutput =
  | StreamEvent
  | AssistantMessage
  | SystemAPIErrorMessage

function assembleFinalAssistantOutputs(params: {
  partialMessage: BetaMessage | null
  contentBlocks: Record<number, Record<string, unknown>>
  tools: Tools
  agentId: string | undefined
  usage: OpenAIUsageCounters
  stopReason: string | null
  maxTokenDisplayLimit: number
  maxTokenOverrideEnv: string
  requestId: string | null
}): (AssistantMessage | SystemAPIErrorMessage)[] {
  const {
    partialMessage,
    contentBlocks,
    tools,
    agentId,
    usage,
    stopReason,
    maxTokenDisplayLimit,
    maxTokenOverrideEnv,
    requestId,
  } = params
  const outputs: (AssistantMessage | SystemAPIErrorMessage)[] = []

  const allBlocks = Object.keys(contentBlocks)
    .sort((a, b) => Number(a) - Number(b))
    .map(key => contentBlocks[Number(key)])
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
          `Output truncated: response exceeded the ${maxTokenDisplayLimit} token limit. ` +
          `Set ${maxTokenOverrideEnv} or CLAUDE_CODE_MAX_OUTPUT_TOKENS to override.`,
        apiError: 'max_output_tokens',
        error: 'max_output_tokens',
      }),
    )
  }

  return outputs
}

/**
 * Execute a prepared OpenAI-compatible stream without owning provider setup,
 * model resolution, cost accounting, Langfuse labels, or terminal error UI.
 */
export async function* executeOpenAIStream(params: {
  preparedAttempt: PreparedOpenAIStreamAttempt
  adapter: OpenAIStreamAdapter
  model: string
  tools: Tools
  signal: AbortSignal
  options?: OpenAIStreamExecutorOptions
  maxTokenDisplayLimit: number
}): AsyncGenerator<
  OpenAIStreamExecutorOutput,
  OpenAIStreamExecutionSummary,
  void
> {
  const {
    preparedAttempt,
    adapter,
    model,
    tools,
    signal,
    maxTokenDisplayLimit,
  } = params
  const source = params.options?.source
  const agentId = params.options?.agentId
  const includeErrorStack = params.options?.includeErrorStack === true
  const maxTokenOverrideEnv =
    params.options?.maxTokenOverrideEnv ?? 'OPENAI_MAX_TOKENS'
  const requestMaxRetries = getOpenAIRequestMaxRetries()
  const streamMaxRetries = getOpenAIStreamMaxRetries()
  const thinkingLoopMaxRetries = getThinkingLoopMaxRetries()
  const collectedMessages: AssistantMessage[] = []
  const start = params.options?.startTimeMs ?? Date.now()
  let finalUsage: OpenAIUsageCounters = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
  let finalTtftMs = 0
  let finalRequestId: string | null = null
  let requestRetries = 0
  let streamRetries = 0
  let thinkingLoopRetries = 0
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
      queryCheckpoint('query_openai_request_start', { requestAttempt })
      attempt = await preparedAttempt.createAttempt(combinedSignal.signal)
      queryCheckpoint('query_openai_request_end', {
        requestAttempt,
        status: attempt.status,
      })
    } catch (error) {
      combinedSignal.cleanup()
      attemptController.abort()
      logOpenAIRawLifecycle({
        lifecycle: 'error',
        route: preparedAttempt.route,
        model,
        source,
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
        route: preparedAttempt.route,
        model,
        source,
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
        asOpenAIRetryError(error, includeErrorStack),
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
    const thinkingLoop =
      thinkingLoopRetries < thinkingLoopMaxRetries
        ? createThinkingLoopDetector()
        : null

    try {
      const timedStream = withOpenAIStreamIdleTimeout(attempt.stream, {
        abortAttempt: () => attemptController.abort(),
        userSignal: signal,
        requestId: attempt.requestId,
      })
      const rawStream = logOpenAIRawStream(timedStream, {
        route: preparedAttempt.route,
        model,
        source,
        streamId,
        requestAttempt,
        streamAttempt: streamRetries + 1,
        status: String(attempt.status),
        requestId: attempt.requestId ?? undefined,
      })
      const adaptedStream = adapter(rawStream, model)

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
            const index = event.index
            const contentBlock = event.content_block
            if (contentBlock.type === 'tool_use') {
              contentBlocks[index] = { ...contentBlock, input: '' }
            } else if (contentBlock.type === 'text') {
              contentBlocks[index] = { ...contentBlock, text: '' }
            } else if (contentBlock.type === 'thinking') {
              contentBlocks[index] = {
                ...contentBlock,
                thinking: '',
                signature: '',
              }
            } else {
              contentBlocks[index] = { ...contentBlock }
            }
            break
          }
          case 'content_block_delta': {
            const index = event.index
            const delta = event.delta
            const block = contentBlocks[index]
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
              if (thinkingLoop?.push(delta.thinking)) {
                throw createThinkingLoopError(attempt.requestId)
              }
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
                agentId,
                usage,
                stopReason,
                maxTokenDisplayLimit,
                maxTokenOverrideEnv,
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
            finalRequestId = attempt.requestId
            params.options?.onCompleted?.(usage)
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
        route: preparedAttempt.route,
        model,
        source,
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
      if (signal.aborted || isOpenAIUserAbortError(streamError)) {
        throw streamError
      }
      if (
        isThinkingLoopError(streamError) &&
        thinkingLoopRetries < thinkingLoopMaxRetries
      ) {
        thinkingLoopRetries++
        const delayMs = getThinkingLoopBackoffMs()
        logOpenAIRawLifecycle({
          lifecycle: 'retry',
          route: preparedAttempt.route,
          model,
          source,
          streamId,
          requestAttempt,
          streamAttempt: streamRetries + 1,
          status: String(attempt.status),
          requestId: attempt.requestId ?? undefined,
          phase: 'stream',
          attempt: thinkingLoopRetries,
          maxRetries: thinkingLoopMaxRetries,
          delayMs,
          error: streamError,
        })
        logForDebugging(
          `[OpenAI] Thinking loop (attempt ${thinkingLoopRetries}/${thinkingLoopMaxRetries}, resampling in ${delayMs}ms)`,
          { level: 'error' },
        )
        await sleep(delayMs, signal, { throwOnAbort: true })
        continue
      }
      if (
        !isTransientOpenAIError(streamError) ||
        streamRetries >= streamMaxRetries
      ) {
        throw streamError
      }

      streamRetries++
      const delayMs = getOpenAIRetryDelayMs(
        streamError,
        streamRetries,
        attempt.retryAfterMs,
      )
      logOpenAIRawLifecycle({
        lifecycle: 'retry',
        route: preparedAttempt.route,
        model,
        source,
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
        asOpenAIRetryError(streamError, includeErrorStack),
        delayMs,
        streamRetries,
        streamMaxRetries,
      )
      await sleep(delayMs, signal, { throwOnAbort: true })
      continue
    }

    break
  }

  return {
    collectedMessages,
    usage: finalUsage,
    ttftMs: finalTtftMs,
    requestId: finalRequestId,
  }
}
