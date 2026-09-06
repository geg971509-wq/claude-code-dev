import type {
  BetaToolUnion,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import {
  anthropicMessagesToResponsesInput,
  anthropicToolChoiceToGrokResponses,
  anthropicToolsToGrokResponses,
  normalizeGrokReasoningEffort,
} from '@ant/model-provider'
import type { ResponseCreateParamsStreaming } from 'openai/resources/responses/responses.mjs'
import { getSessionId } from '../../../bootstrap/state.js'
import { addToTotalSessionCost } from '../../../cost-tracker.js'
import { recordLLMObservation } from '../../../services/langfuse/tracing.js'
import type { Tools } from '../../../Tool.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../../types/message.js'
import { toolToAPISchema } from '../../../utils/api.js'
import { resolveAppliedEffort } from '../../../utils/effort.js'
import { calculateUSDCost } from '../../../utils/modelCost.js'
import { normalizeMessagesForAPI } from '../../../utils/messages.js'
import type { SystemPrompt } from '../../../utils/systemPromptType.js'
import {
  convertMessagesToLangfuse,
  convertOutputToLangfuse,
  convertToolsToLangfuse,
} from '../../langfuse/convert.js'
import type { Options } from '../claude.js'
import { adaptResponsesStreamToAnthropic } from '../openai/responsesAdapter.js'
import { executeOpenAIStream } from '../openai/streamExecutor.js'
import { prepareGrokResponsesStreamRequest } from './client.js'

const DEFAULT_GROK_OUTPUT_LIMIT_FOR_DISPLAY = 64_000
const GROK_USD_TICKS_PER_USD = 10_000_000_000

function systemPromptInput(
  systemPrompt: SystemPrompt,
): Record<string, unknown>[] {
  if (systemPrompt.length === 0) return []
  return [
    {
      type: 'message',
      role: 'system',
      content: systemPrompt.join('\n\n'),
    },
  ]
}

async function* captureGrokReportedCost(
  stream: AsyncIterable<Record<string, unknown>>,
  onReportedCost: (costUSD: number) => void,
): AsyncGenerator<Record<string, unknown>, void> {
  for await (const event of stream) {
    const response =
      event.response && typeof event.response === 'object'
        ? (event.response as Record<string, unknown>)
        : undefined
    const usage =
      response?.usage && typeof response.usage === 'object'
        ? (response.usage as Record<string, unknown>)
        : undefined
    const ticks = usage?.cost_in_usd_ticks
    if (typeof ticks === 'number' && Number.isFinite(ticks) && ticks > 0) {
      onReportedCost(ticks / GROK_USD_TICKS_PER_USD)
    }
    yield event
  }
}

/**
 * Current grok-build default path for grok-4.5/4.6: public xAI Responses API.
 * Keep this provider-specific wrapper thin and reuse the shared Responses
 * parser/executor for retries, reasoning replay, function calls, images, and
 * terminal message assembly.
 */
export async function* queryModelGrokResponses(
  messages: Message[],
  systemPrompt: SystemPrompt,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
  grokModel: string,
): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  const messagesForAPI = normalizeMessagesForAPI(messages, tools)
  const input = [
    ...systemPromptInput(systemPrompt),
    ...anthropicMessagesToResponsesInput(messagesForAPI, {
      // xAI's public Responses API accepts remote image URLs; Codex's gateway
      // does not, which is why the shared converter defaults this to false.
      allowRemoteImageUrls: true,
    }),
  ]

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
  const standardTools = toolSchemas.filter((tool): tool is BetaToolUnion => {
    const value = tool as unknown as Record<string, unknown>
    return (
      value.type !== 'advisor_20260301' && value.type !== 'computer_20250124'
    )
  })
  const responseTools = anthropicToolsToGrokResponses(standardTools)
  const toolChoice = anthropicToolChoiceToGrokResponses(options.toolChoice)
  const appliedEffort = resolveAppliedEffort(options.model, options.effortValue)
  const reasoningEffort = normalizeGrokReasoningEffort(grokModel, appliedEffort)
  const sessionId = getSessionId()

  const requestRecord: Record<string, unknown> = {
    model: grokModel,
    input,
    stream: true,
    // grok-build forces store=false because the API default is true and would
    // violate zero-data-retention expectations for shell sessions.
    store: false,
    // Required to replay encrypted reasoning on the next turn and keep xAI's
    // server-side prefix cache stable across multi-turn tool loops.
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: sessionId,
    ...(responseTools.length > 0 && { tools: responseTools }),
    ...(toolChoice && { tool_choice: toolChoice }),
    ...(reasoningEffort && {
      reasoning: {
        effort: reasoningEffort,
        // grok-build requests concise summaries on Responses.
        summary: 'concise',
      },
    }),
    ...(options.maxOutputTokensOverride !== undefined && {
      max_output_tokens: options.maxOutputTokensOverride,
    }),
    ...(options.temperatureOverride !== undefined && {
      temperature: options.temperatureOverride,
    }),
    ...(options.outputFormat && {
      text: {
        format: {
          type: 'json_schema',
          name: 'structured_output',
          schema: options.outputFormat.schema,
          strict: true,
        },
      },
    }),
  }
  const request = requestRecord as unknown as ResponseCreateParamsStreaming
  const start = Date.now()
  let reportedCostUSD: number | undefined
  const execution = yield* executeOpenAIStream({
    preparedAttempt: prepareGrokResponsesStreamRequest({
      request,
      model: grokModel,
      sessionId,
      agentId: options.agentId ? String(options.agentId) : undefined,
      fetchOverride: options.fetchOverride as typeof fetch | undefined,
      source: options.querySource,
    }),
    adapter: (stream, model) =>
      adaptResponsesStreamToAnthropic(
        captureGrokReportedCost(stream, costUSD => {
          reportedCostUSD = costUSD
        }),
        model,
      ),
    model: grokModel,
    tools,
    signal,
    options: {
      agentId: options.agentId,
      source: options.querySource,
      includeErrorStack: options.verbose === true,
      startTimeMs: start,
      maxTokenOverrideEnv: 'GROK_MAX_TOKENS',
    },
    maxTokenDisplayLimit:
      options.maxOutputTokensOverride ?? DEFAULT_GROK_OUTPUT_LIMIT_FOR_DISPLAY,
  })

  if (execution.collectedMessages.length === 0) {
    throw new Error('Grok Responses API returned an empty streamed response')
  }

  if (execution.usage.input_tokens + execution.usage.output_tokens > 0) {
    const usage = execution.usage as unknown as BetaUsage
    const costUSD = reportedCostUSD ?? calculateUSDCost(grokModel, usage)
    addToTotalSessionCost(costUSD, usage, options.model)
  }

  recordLLMObservation(options.langfuseTrace ?? null, {
    model: grokModel,
    provider: 'grok',
    input: convertMessagesToLangfuse(messagesForAPI, systemPrompt),
    output: convertOutputToLangfuse(execution.collectedMessages),
    usage: execution.usage,
    startTime: new Date(start),
    endTime: new Date(),
    completionStartTime:
      execution.ttftMs > 0 ? new Date(start + execution.ttftMs) : undefined,
    tools: convertToolsToLangfuse(toolSchemas as unknown[]),
  })
}
