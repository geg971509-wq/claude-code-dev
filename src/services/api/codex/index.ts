import { appendFileSync, chmodSync } from 'fs'
import { APIUserAbortError } from '@anthropic-ai/sdk'
import type { BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import {
  anthropicMessagesToResponsesInput,
  anthropicToolsToCodex,
  resolveCodexMaxTokens,
  resolveCodexModel,
} from '@ant/model-provider'
import type {
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
} from 'openai/resources/responses/responses.mjs'
import type { SystemPrompt } from '../../../utils/systemPromptType.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../../types/message.js'
import type { Tools } from '../../../Tool.js'
import { toolToAPISchema } from '../../../utils/api.js'
import { logForDebugging } from '../../../utils/debug.js'
import { getModelMaxOutputTokens } from '../../../utils/context.js'
import { resolveAppliedEffort } from '../../../utils/effort.js'
import {
  createAssistantAPIErrorMessage,
  normalizeMessagesForAPI,
} from '../../../utils/messages.js'
import { recordLLMObservation } from '../../../services/langfuse/tracing.js'
import {
  convertMessagesToLangfuse,
  convertOutputToLangfuse,
  convertToolsToLangfuse,
} from '../../../services/langfuse/convert.js'
import type { Options } from '../claude.js'
import { adaptResponsesStreamToAnthropic } from '../openai/responsesAdapter.js'
import { applyCodexReasoningToRequest } from '../openai/codexReasoning.js'
import { executeOpenAIStream } from '../openai/streamExecutor.js'
import { isOpenAIUserAbortError } from '../openai/openaiShared.js'
import { prepareCodexStreamRequest } from './client.js'
import {
  isCodexSubscriptionAuth,
  resolveCodexRequestContext,
} from './credentials.js'
import { getCodexConfigurationError, normalizeCodexError } from './errors.js'
import { sanitizeCodexRequest, toStreamingCodexRequest } from './preflight.js'

function dumpCodexPayload(
  body: ResponseCreateParamsNonStreaming | ResponseCreateParamsStreaming,
): void {
  const path = process.env.CODEX_DEBUG_PAYLOADS
  if (!path) return

  appendFileSync(
    path,
    `${JSON.stringify({ timestamp: new Date().toISOString(), body }, null, 2)}\n`,
    { mode: 0o600 },
  )
  chmodSync(path, 0o600)
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
    const input = anthropicMessagesToResponsesInput(messagesForAPI)
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
    const { upperLimit } = getModelMaxOutputTokens(model)
    const maxTokens = resolveCodexMaxTokens(
      upperLimit,
      options.maxOutputTokensOverride,
    )
    const subscription = isCodexSubscriptionAuth()
    const effort = resolveAppliedEffort(options.model, options.effortValue)
    const requestRecord: Record<string, unknown> = {
      model,
      input,
      store: false,
      stream: true,
      tool_choice: 'auto',
      include: ['reasoning.encrypted_content'],
      parallel_tool_calls: true,
      ...(!subscription && { max_output_tokens: maxTokens }),
      ...(systemPrompt.length > 0 && {
        instructions: systemPrompt.join('\n\n'),
      }),
      ...(codexTools.length > 0 && { tools: codexTools }),
      ...(!subscription &&
        options.temperatureOverride !== undefined && {
          temperature: options.temperatureOverride,
        }),
      ...(typeof effort === 'string' && { reasoning: { effort } }),
    }
    applyCodexReasoningToRequest(requestRecord, {
      model,
      provider: 'codex',
    })
    const requestBody = toStreamingCodexRequest(
      sanitizeCodexRequest(
        requestRecord as unknown as ResponseCreateParamsNonStreaming,
      ),
    )

    logForDebugging(
      `[Codex] Calling model=${model}, inputItems=${input.length}, tools=${codexTools.length}`,
    )
    dumpCodexPayload(requestBody)

    const requestContext = await resolveCodexRequestContext(signal)
    const preparedRequest = prepareCodexStreamRequest({
      request: requestBody,
      requestContext,
      subscription,
      fetchOverride: options.fetchOverride as typeof fetch | undefined,
    })
    const start = Date.now()
    const execution = yield* executeOpenAIStream({
      preparedAttempt: preparedRequest,
      adapter: adaptResponsesStreamToAnthropic,
      model,
      tools,
      signal,
      options: {
        agentId: options.agentId,
        source: options.querySource,
        startTimeMs: start,
        maxTokenOverrideEnv: 'CODEX_MAX_TOKENS',
      },
      maxTokenDisplayLimit: maxTokens,
    })

    if (execution.collectedMessages.length === 0) {
      yield createAssistantAPIErrorMessage({
        content: 'Codex returned an empty streamed response.',
        apiError: 'api_error',
        error: 'unknown',
      })
      return
    }

    recordLLMObservation(options.langfuseTrace ?? null, {
      model,
      provider: subscription ? 'codex-chatgpt' : 'codex',
      input: convertMessagesToLangfuse(messagesForAPI, systemPrompt),
      output: convertOutputToLangfuse(execution.collectedMessages),
      usage: execution.usage,
      startTime: new Date(start),
      endTime: new Date(),
      completionStartTime:
        execution.ttftMs > 0 ? new Date(start + execution.ttftMs) : undefined,
      tools: convertToolsToLangfuse(toolSchemas as unknown[]),
    })
  } catch (error) {
    if (
      signal.aborted ||
      error instanceof APIUserAbortError ||
      isOpenAIUserAbortError(error)
    ) {
      if (error instanceof APIUserAbortError) throw error
      throw new APIUserAbortError()
    }

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
