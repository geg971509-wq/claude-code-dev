import type { BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type {
  Response,
  ResponseCreateParamsNonStreaming,
} from 'openai/resources/responses/responses.mjs'
import { appendFileSync } from 'fs'
import type { SystemPrompt } from '../../../utils/systemPromptType.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../../types/message.js'
import type { Tools } from '../../../Tool.js'
import type { SDKAssistantMessageError } from '../../../entrypoints/agentSdkTypes.js'
import { toolToAPISchema } from '../../../utils/api.js'
import {
  createAssistantAPIErrorMessage,
  createSystemAPIErrorMessage,
  normalizeContentFromAPI,
  normalizeMessagesForAPI,
} from '../../../utils/messages.js'
import { logForDebugging } from '../../../utils/debug.js'
import { resolveAppliedEffort } from '../../../utils/effort.js'
import { sleep } from '../../../utils/sleep.js'
import { getSessionId } from '../../../bootstrap/state.js'
import type { Options } from '../claude.js'
import {
  getOpenAIRetryDelayMs,
  getOpenAIStreamMaxRetries,
  isOpenAIUserAbortError,
  isTransientOpenAIError,
} from '../openai/openaiShared.js'
import { applyCodexReasoningToRequest } from '../openai/codexReasoning.js'
import { recordLLMObservation } from '../../../services/langfuse/tracing.js'
import {
  convertMessagesToLangfuse,
  convertOutputToLangfuse,
  convertToolsToLangfuse,
} from '../../../services/langfuse/convert.js'
import {
  anthropicMessagesToCodexInput,
  anthropicToolsToCodex,
  resolveCodexModel,
} from '@ant/model-provider'
import {
  createCodexTurnState,
  getCodexClient,
  type CodexTurnState,
} from './client.js'
import {
  isCodexSubscriptionAuth,
  refreshCodexAuthAfterUnauthorized,
  resolveCodexRequestContext,
  type CodexRequestContext,
} from './credentials.js'
import {
  getCodexConfigurationError,
  isCodexUnauthorizedError,
  normalizeCodexError,
} from './errors.js'
import { sanitizeCodexRequest } from './preflight.js'
import {
  getCodexUsage,
  type CodexStreamResult,
  type CodexUsage,
  rawAssistantBlocksToAssistantMessage,
  type RawAssistantBlock,
  streamCodexAttempt,
} from './streaming.js'
import {
  responseToCodexAssistantBlocks,
  type CodexAssistantBlock,
} from './responseItems.js'

function asRetryError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function dumpCodexPayload(body: ResponseCreateParamsNonStreaming): void {
  const path = process.env.CODEX_DEBUG_PAYLOADS
  if (!path) {
    return
  }

  appendFileSync(
    path,
    `${JSON.stringify({ timestamp: new Date().toISOString(), body }, null, 2)}\n`,
  )
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * Official Codex does not send max_output_tokens by default. Preserve the
 * development client's explicit override as an opt-in extension, but omit the
 * model's local upper-limit default from the wire request.
 */
function resolveExplicitMaxOutputTokens(options: Options): number | undefined {
  const direct = options.maxOutputTokensOverride
  if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) {
    return Math.floor(direct)
  }
  return (
    parsePositiveInteger(process.env.CODEX_MAX_TOKENS) ??
    parsePositiveInteger(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS)
  )
}

function createCodexClientForTurn(
  context: CodexRequestContext,
  turnState: CodexTurnState,
  options: Options,
) {
  return getCodexClient({
    maxRetries: 0,
    fetchOverride: options.fetchOverride as typeof fetch | undefined,
    turnState,
    ...context,
  })
}

function selectAssistantBlocks(
  attemptResult: CodexStreamResult,
): CodexAssistantBlock[] {
  const completed = attemptResult.response
    ? responseToCodexAssistantBlocks(attemptResult.response)
    : []
  const hasCompletedAnswer = completed.some(
    block => block.type === 'text' || block.type === 'tool_use',
  )

  if (hasCompletedAnswer || attemptResult.assistantBlocks.length === 0) {
    return completed
  }

  // Some compatible gateways omit completed message items but still stream
  // text/tool deltas. Preserve any encrypted reasoning item that was present
  // and append the streamed answer as a compatibility fallback.
  return [
    ...completed,
    ...(attemptResult.assistantBlocks as CodexAssistantBlock[]),
  ]
}

function codexAssistantBlocksToAssistantMessage(
  blocks: CodexAssistantBlock[],
  response: Pick<Response, 'id' | 'model' | 'usage' | 'incomplete_details'>,
  tools: Tools,
  agentId?: string,
): AssistantMessage {
  const transportBlocks = blocks.filter(
    (block): block is RawAssistantBlock => block.type !== 'thinking',
  )
  const assistantMessage = rawAssistantBlocksToAssistantMessage(
    transportBlocks,
    response,
    tools,
    agentId,
  )

  // Keep completed response item order while delegating text/tool parsing to
  // the existing normalization layer. Thinking.signature carries the
  // encrypted_content required for the next store:false request.
  const normalizedContent: any[] = []
  for (const block of blocks) {
    if (block.type === 'thinking') {
      normalizedContent.push({
        type: 'thinking',
        thinking: block.thinking,
        signature: block.signature,
      })
      continue
    }
    normalizedContent.push(
      ...normalizeContentFromAPI([block] as any, tools, agentId as any),
    )
  }
  assistantMessage.message.content = normalizedContent as any

  return assistantMessage
}

export async function* queryModelCodex(
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
    const configurationError = getCodexConfigurationError()
    if (configurationError) {
      yield createAssistantAPIErrorMessage({
        content: configurationError.content,
        apiError: 'api_error',
        error: configurationError.error,
      })
      return
    }

    const model = resolveCodexModel(options.model)
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
    const codexTools = anthropicToolsToCodex(toolSchemas as BetaToolUnion[])
    const explicitMaxOutputTokens = resolveExplicitMaxOutputTokens(options)
    const sessionId = getSessionId()
    const input = anthropicMessagesToCodexInput(messagesForAPI)
    const appliedEffort = resolveAppliedEffort(
      options.model,
      options.effortValue,
    )
    const requestRecord: Record<string, unknown> = {
      model,
      input,
      store: false,
      stream: true,
      tool_choice: 'auto',
      include: ['reasoning.encrypted_content'],
      parallel_tool_calls: true,
      prompt_cache_key: sessionId,
      client_metadata: {
        session_id: sessionId,
        thread_id: sessionId,
        'x-codex-window-id': `${sessionId}:0`,
      },
      ...(systemPrompt.length > 0 && {
        instructions: systemPrompt.join('\n\n'),
      }),
      ...(codexTools.length > 0 && {
        tools: codexTools,
      }),
      ...(explicitMaxOutputTokens !== undefined && {
        max_output_tokens: explicitMaxOutputTokens,
      }),
      ...(typeof appliedEffort === 'string' && {
        reasoning: { effort: appliedEffort },
      }),
    }
    applyCodexReasoningToRequest(requestRecord, {
      model,
      provider: 'codex',
    })
    const requestBody = sanitizeCodexRequest(
      requestRecord as unknown as ResponseCreateParamsNonStreaming,
    )

    logForDebugging(
      `[Codex] Calling model=${model}, inputItems=${input.length}, tools=${codexTools.length}`,
    )
    dumpCodexPayload(requestBody)

    const turnState = createCodexTurnState()
    let requestContext = await resolveCodexRequestContext()
    let client = createCodexClientForTurn(requestContext, turnState, options)
    const streamMaxRetries = getOpenAIStreamMaxRetries()
    const start = Date.now()
    let attemptResult: CodexStreamResult | undefined
    let streamRetries = 0
    let recoveredUnauthorized = false

    for (;;) {
      try {
        const attemptStream = streamCodexAttempt({
          client,
          requestBody,
          signal,
          start,
          emitPrimaryEvents: true,
        })
        while (true) {
          const next = await attemptStream.next()
          if (next.done) {
            attemptResult = next.value
            break
          }
          yield next.value
        }
        break
      } catch (error) {
        if (
          !recoveredUnauthorized &&
          isCodexSubscriptionAuth() &&
          isCodexUnauthorizedError(error)
        ) {
          recoveredUnauthorized = true
          const rejectedAccessToken = requestContext.apiKey
          await refreshCodexAuthAfterUnauthorized(rejectedAccessToken)
          requestContext = await resolveCodexRequestContext()
          client = createCodexClientForTurn(requestContext, turnState, options)
          continue
        }

        if (
          signal.aborted ||
          isOpenAIUserAbortError(error) ||
          !isTransientOpenAIError(error) ||
          streamRetries >= streamMaxRetries
        ) {
          throw error
        }
        streamRetries++
        const delayMs = getOpenAIRetryDelayMs(error, streamRetries)
        yield createSystemAPIErrorMessage(
          asRetryError(error),
          delayMs,
          streamRetries,
          streamMaxRetries,
        )
        await sleep(delayMs, signal, { throwOnAbort: true })
      }
    }

    if (!attemptResult?.response) {
      yield createAssistantAPIErrorMessage({
        content: 'Codex returned an empty streamed response.',
        apiError: 'api_error',
        error: 'unknown',
      })
      return
    }

    const assistantBlocks = selectAssistantBlocks(attemptResult)
    if (assistantBlocks.length === 0) {
      yield createAssistantAPIErrorMessage({
        content: 'Codex returned an empty streamed response.',
        apiError: 'api_error',
        error: 'unknown',
      })
      return
    }

    const totalUsage: CodexUsage = getCodexUsage(attemptResult.response)
    const assistantMessage = codexAssistantBlocksToAssistantMessage(
      assistantBlocks,
      attemptResult.response,
      tools,
      options.agentId,
    )
    assistantMessage.message.usage = totalUsage as any
    yield assistantMessage

    recordLLMObservation(options.langfuseTrace ?? null, {
      model,
      provider:
        process.env.CODEX_LOGIN_METHOD === 'chatgpt_subscription'
          ? 'codex-chatgpt'
          : 'codex',
      input: convertMessagesToLangfuse(messagesForAPI, systemPrompt),
      output: convertOutputToLangfuse([assistantMessage]),
      usage: totalUsage,
      startTime: new Date(start),
      endTime: new Date(),
      completionStartTime:
        attemptResult.partialMessage !== undefined
          ? new Date(start)
          : undefined,
      tools: convertToolsToLangfuse(toolSchemas as unknown[]),
    })

    if (
      attemptResult.incompleteResponse?.incomplete_details?.reason ===
      'max_output_tokens'
    ) {
      const limitDescription = explicitMaxOutputTokens
        ? `the configured ${explicitMaxOutputTokens} token limit`
        : 'the model output token limit'
      yield createAssistantAPIErrorMessage({
        content: `Output truncated: response reached ${limitDescription}.`,
        apiError: 'max_output_tokens',
        error: 'max_output_tokens' as unknown as SDKAssistantMessageError,
      })
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const normalizedError = normalizeCodexError(error)
    logForDebugging(`[Codex] Error: ${errorMessage}`, { level: 'error' })
    yield createAssistantAPIErrorMessage({
      content: normalizedError.content,
      apiError: 'api_error',
      error: normalizedError.error,
    })
  }
}
