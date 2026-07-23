import { randomUUID } from 'crypto'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import {
  finishReasonToAnthropicStopReason,
  normalizeResponsesFinishReason,
  ProviderStreamError,
} from '@ant/model-provider'
import type {
  ResponseCreateParamsStreaming,
  ResponseIncludable,
  ResponseInput,
} from 'openai/resources/responses/responses.mjs'
import { getValidChatGPTAuth } from './chatgptAuth.js'
import { getOpenAIClient } from './client.js'
import { throwHttpStatusError } from './openaiShared.js'
import {
  isAzureResponsesBaseURL,
  type OpenAIJSONOutputFormat,
} from './requestBody.js'
import { createCombinedAbortSignal } from '../../../utils/combinedAbortSignal.js'
import { getProxyFetchOptions } from '../../../utils/proxy.js'

type ResponsesInputItem = Record<string, unknown>
type ResponsesTool = {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
  strict: false
}
export type ResponsesReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

export type ChatGPTResponsesRequest = {
  model: string
  stream: true
  /** Codex: true only for Azure Responses endpoints; else false. */
  store: boolean
  input: ResponsesInputItem[]
  instructions?: string
  tools?: ResponsesTool[]
  tool_choice?: unknown
  reasoning?: { effort: ResponsesReasoningEffort; summary?: 'auto' }
  parallel_tool_calls: true
  include?: string[]
  text?: {
    format: {
      type: 'json_schema'
      name: string
      schema: Record<string, unknown>
      strict: true
    }
  }
  /** Sticky cache routing key — stable for the CCB session. Omitted when unset. */
  prompt_cache_key?: string
  client_metadata?: Record<string, string>
}

type ResponsesRequestParams = {
  model: string
  messages: unknown[]
  tools: unknown[]
  toolChoice: unknown
  reasoningEffort?: ResponsesReasoningEffort
  /** Override for tests; production uses the current CCB session id. */
  promptCacheKey?: string
  sessionId?: string
  /** Default true: request encrypted reasoning for store:false multi-turn. */
  includeEncryptedReasoning?: boolean
  outputFormat?: OpenAIJSONOutputFormat
  /** Defaults from OPENAI_BASE_URL azure markers when omitted. */
  store?: boolean
}

// isAzureResponsesBaseURL lives in requestBody.ts (shared with routing).
export { isAzureResponsesBaseURL } from './requestBody.js'

type AnthropicUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  reasoning_tokens?: number
}

const ENCRYPTED_REASONING_INCLUDE: ResponseIncludable =
  'reasoning.encrypted_content'

export type OpenAIStreamAttempt = {
  stream: AsyncIterable<Record<string, unknown>>
  status: number
  requestId: string | null
  retryAfterMs: number | null
  cleanup: () => void
}

function readResponseHeader(response: Response, name: string): string | null {
  return response.headers.get(name)
}

function responseRequestId(
  response: Response,
  sdkRequestId?: string | null,
): string | null {
  return (
    sdkRequestId ??
    readResponseHeader(response, 'x-request-id') ??
    readResponseHeader(response, 'request-id')
  )
}

function responseRetryAfterMs(response: Response): number | null {
  const value = readResponseHeader(response, 'retry-after')
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const dateMs = Date.parse(value)
  if (!Number.isFinite(dateMs)) return null
  return Math.max(0, dateMs - Date.now())
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => {
      if (!part || typeof part !== 'object') return ''
      const record = part as Record<string, unknown>
      if (typeof record.text === 'string') return record.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/** Responses API requires user content as input_text / input_image parts (not raw strings). */
function convertUserContent(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return content ? [{ type: 'input_text', text: content }] : []
  }
  if (!Array.isArray(content)) {
    const text = textFromContent(content)
    return text ? [{ type: 'input_text', text }] : []
  }
  const result: Array<Record<string, unknown>> = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const record = part as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') {
      result.push({ type: 'input_text', text: record.text })
    } else if (record.type === 'image_url') {
      const imageUrl = record.image_url as Record<string, unknown> | undefined
      if (typeof imageUrl?.url === 'string') {
        result.push({ type: 'input_image', image_url: imageUrl.url })
      }
    } else if (
      typeof record.text === 'string' &&
      (record.type === undefined || record.type === 'input_text')
    ) {
      result.push({ type: 'input_text', text: record.text })
    }
  }
  if (result.length > 0) return result
  const fallback = textFromContent(content)
  return fallback ? [{ type: 'input_text', text: fallback }] : []
}

/**
 * Chat Completions-shaped messages → Responses input.
 * Thinking blocks with a signature are treated as encrypted reasoning replay
 * (signature holds encrypted_content from the prior Responses turn).
 */
function convertMessagesToResponsesInput(messages: unknown[]): {
  input: ResponsesInputItem[]
  instructions?: string
} {
  const input: ResponsesInputItem[] = []
  const instructions: string[] = []

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const record = message as Record<string, unknown>
    const role = record.role

    if (role === 'system' || role === 'developer') {
      const text = textFromContent(record.content)
      if (text) instructions.push(text)
      continue
    }

    if (role === 'tool') {
      const callId = record.tool_call_id
      if (typeof callId === 'string') {
        input.push({
          type: 'function_call_output',
          call_id: callId,
          output: textFromContent(record.content),
        })
      }
      continue
    }

    if (role === 'assistant') {
      // encrypted_content is carried from thinking.signature via chat conversion.
      if (typeof record.encrypted_content === 'string') {
        input.push({
          type: 'reasoning',
          encrypted_content: record.encrypted_content,
          summary: [],
        })
      }

      const text = textFromContent(record.content)
      if (text) {
        input.push({
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        })
      }
      const toolCalls = record.tool_calls
      if (Array.isArray(toolCalls)) {
        for (const toolCall of toolCalls) {
          if (!toolCall || typeof toolCall !== 'object') continue
          const tc = toolCall as Record<string, unknown>
          const fn = tc.function as Record<string, unknown> | undefined
          const id = typeof tc.id === 'string' ? tc.id : undefined
          const name = typeof fn?.name === 'string' ? fn.name : undefined
          if (!id || !name) continue
          input.push({
            type: 'function_call',
            call_id: id,
            name,
            arguments: typeof fn?.arguments === 'string' ? fn.arguments : '{}',
          })
        }
      }
      continue
    }

    if (role === 'user') {
      const userContent = convertUserContent(record.content)
      if (userContent.length === 0) continue
      input.push({
        role: 'user',
        content: userContent,
      })
    }
  }

  // store:false only accepts reasoning items with encrypted_content.
  const filtered = input.filter(item => {
    if (item.type !== 'reasoning') return true
    return typeof item.encrypted_content === 'string'
  })

  return {
    input: filtered,
    instructions:
      instructions.length > 0 ? instructions.join('\n\n') : undefined,
  }
}

function convertToolsToResponses(tools: unknown[]): ResponsesTool[] {
  const result: ResponsesTool[] = []
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue
    const record = tool as Record<string, unknown>
    const fn = record.function as Record<string, unknown> | undefined
    const name = typeof fn?.name === 'string' ? fn.name : undefined
    if (!name) continue
    result.push({
      type: 'function',
      name,
      description: typeof fn?.description === 'string' ? fn.description : '',
      parameters:
        fn?.parameters && typeof fn.parameters === 'object'
          ? (fn.parameters as Record<string, unknown>)
          : { type: 'object', properties: {} },
      strict: false,
    })
  }
  return result
}

type ResponsesToolChoice = NonNullable<
  ResponseCreateParamsStreaming['tool_choice']
>

function convertToolChoiceToResponses(toolChoice: unknown): unknown {
  if (
    toolChoice === 'none' ||
    toolChoice === 'required' ||
    toolChoice === 'auto'
  ) {
    return toolChoice
  }
  if (!toolChoice || typeof toolChoice !== 'object') return toolChoice
  const record = toolChoice as Record<string, unknown>
  const fn = record.function as Record<string, unknown> | undefined
  if (record.type === 'function' && typeof fn?.name === 'string') {
    return { type: 'function', name: fn.name }
  }
  return toolChoice
}

function convertOfficialToolChoiceToResponses(
  toolChoice: unknown,
): ResponsesToolChoice {
  const converted = convertToolChoiceToResponses(toolChoice)
  if (
    converted === 'none' ||
    converted === 'required' ||
    converted === 'auto'
  ) {
    return converted
  }
  if (converted && typeof converted === 'object') {
    const record = converted as Record<string, unknown>
    if (record.type === 'function' && typeof record.name === 'string') {
      return { type: 'function', name: record.name }
    }
  }
  return 'auto'
}

function buildResponsesRequestFields(params: ResponsesRequestParams) {
  const { input, instructions } = convertMessagesToResponsesInput(
    params.messages,
  )
  const tools = convertToolsToResponses(params.tools)
  const includeEncrypted = params.includeEncryptedReasoning !== false
  return {
    model: params.model,
    stream: true as const,
    store: params.store ?? isAzureResponsesBaseURL(),
    input,
    ...(instructions ? { instructions } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(includeEncrypted
      ? { include: [ENCRYPTED_REASONING_INCLUDE] as ResponseIncludable[] }
      : {}),
    ...(params.outputFormat && {
      text: {
        format: {
          type: 'json_schema' as const,
          name: 'side_query_output',
          schema: params.outputFormat.schema,
          strict: true as const,
        },
      },
    }),
    parallel_tool_calls: true as const,
    ...(params.promptCacheKey && { prompt_cache_key: params.promptCacheKey }),
  }
}

export function buildChatGPTResponsesRequest(
  params: ResponsesRequestParams,
): ChatGPTResponsesRequest {
  const fields = buildResponsesRequestFields(params)
  return {
    ...fields,
    ...(params.toolChoice
      ? { tool_choice: convertToolChoiceToResponses(params.toolChoice) }
      : {}),
    ...(params.reasoningEffort && {
      reasoning:
        params.reasoningEffort === 'max'
          ? { effort: params.reasoningEffort }
          : { effort: params.reasoningEffort, summary: 'auto' as const },
    }),
    // Same OAuth session → same key so OpenAI can sticky-route to a cache node.
    // Must not hash the full message list (would change every turn).
    ...(params.sessionId && {
      client_metadata: {
        session_id: params.sessionId,
        thread_id: params.sessionId,
      },
    }),
  }
}

export function buildOfficialResponsesRequest(
  params: ResponsesRequestParams & { maxOutputTokens: number },
): ResponseCreateParamsStreaming {
  const fields = buildResponsesRequestFields(params)
  return {
    ...fields,
    // SDK input types do not fully model stateless encrypted reasoning replay.
    input: fields.input as unknown as ResponseInput,
    ...(params.toolChoice
      ? { tool_choice: convertOfficialToolChoiceToResponses(params.toolChoice) }
      : {}),
    max_output_tokens: params.maxOutputTokens,
    ...(params.reasoningEffort && {
      reasoning:
        params.reasoningEffort === 'max'
          ? { effort: 'xhigh' as const }
          : { effort: params.reasoningEffort, summary: 'auto' as const },
    }),
  }
}

function responsesIdentityHeaders(
  sessionId: string | undefined,
): Record<string, string> {
  return {
    Accept: 'text/event-stream',
    originator: 'claude-code-best',
    ...(sessionId && {
      'session-id': sessionId,
      'thread-id': sessionId,
      'x-client-request-id': sessionId,
    }),
  }
}

/**
 * Next SSE event-frame boundary. Official/proxy streams use either LF (`\n\n`)
 * or CRLF (`\r\n\r\n`); prefer the earlier match. `\n\n` cannot appear inside
 * `\r\n\r\n` (CR sits between the LFs), so the two searches do not alias.
 */
function nextSseFrameBoundary(
  buffer: string,
): { at: number; sepLen: number } | null {
  const crlf = buffer.indexOf('\r\n\r\n')
  const lf = buffer.indexOf('\n\n')
  if (crlf < 0 && lf < 0) return null
  if (crlf < 0) return { at: lf, sepLen: 2 }
  if (lf < 0) return { at: crlf, sepLen: 4 }
  return crlf < lf ? { at: crlf, sepLen: 4 } : { at: lf, sepLen: 2 }
}

function parseSseDataFrame(frame: string): Record<string, unknown> | undefined {
  const data = frame
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')
  if (!data || data === '[DONE]') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const preview = data.length > 160 ? `${data.slice(0, 160)}…` : data
    throw new ProviderStreamError(
      `Responses SSE JSON parse failed: ${detail}; data=${JSON.stringify(preview)}`,
      {
        kind: 'protocol',
        retryable: true,
        terminal: false,
        cause: error,
      },
    )
  }
  if (parsed && typeof parsed === 'object') {
    return parsed as Record<string, unknown>
  }
  throw new ProviderStreamError('Responses SSE data was not a JSON object', {
    kind: 'protocol',
    retryable: true,
    terminal: false,
  })
}

/** Exported for focused framing tests (LF / CRLF / trailing frame). */
export async function* parseSSE(
  response: Response,
): AsyncGenerator<Record<string, unknown>, void> {
  if (!response.body) {
    throw new ProviderStreamError('Responses stream did not include a body', {
      kind: 'protocol',
      retryable: true,
      terminal: false,
    })
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        // Flush any multibyte char held by the decoder.
        buffer += decoder.decode()
        break
      }
      buffer += decoder.decode(value, { stream: true })
      let boundary = nextSseFrameBoundary(buffer)
      while (boundary) {
        const frame = buffer.slice(0, boundary.at)
        buffer = buffer.slice(boundary.at + boundary.sepLen)
        const event = parseSseDataFrame(frame)
        if (event) yield event
        boundary = nextSseFrameBoundary(buffer)
      }
    }
    // Some proxies omit the final blank line before EOF; still accept a trailing frame.
    if (buffer.trim()) {
      const event = parseSseDataFrame(buffer)
      if (event) yield event
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // Already released or cancelled mid-read.
    }
  }
}

/**
 * Map OpenAI Responses usage → Anthropic-style mutually exclusive fields.
 *
 * OpenAI:  input_tokens is TOTAL input; cached_tokens ⊆ input_tokens;
 *          cache_write_tokens (GPT-5.6+) reports tokens written this turn.
 * Anthropic: input + cache_creation + cache_read are disjoint and sum to total.
 *
 * Without subtracting cached from input, cacheWarning hit-rate becomes
 * cached/(total+cached) with a hard ceiling of 50%.
 */
export function extractUsage(
  response: Record<string, unknown> | undefined,
): AnthropicUsage {
  const usage = response?.usage as Record<string, unknown> | undefined
  const inputDetails = usage?.input_tokens_details as
    | Record<string, unknown>
    | undefined
  const outputDetails = usage?.output_tokens_details as
    | Record<string, unknown>
    | undefined
  const totalInput =
    typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0
  const outputTokens =
    typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0
  const cachedRaw =
    typeof inputDetails?.cached_tokens === 'number'
      ? inputDetails.cached_tokens
      : 0
  const writeRaw =
    typeof inputDetails?.cache_write_tokens === 'number'
      ? inputDetails.cache_write_tokens
      : 0
  const cacheRead = Math.min(Math.max(0, cachedRaw), Math.max(0, totalInput))
  const remainingAfterRead = Math.max(0, totalInput - cacheRead)
  const cacheCreation = Math.min(Math.max(0, writeRaw), remainingAfterRead)

  return {
    input_tokens: Math.max(0, remainingAfterRead - cacheCreation),
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
    ...(typeof outputDetails?.reasoning_tokens === 'number'
      ? { reasoning_tokens: outputDetails.reasoning_tokens }
      : {}),
  }
}

function mapStopReason(
  response: Record<string, unknown> | undefined,
  hasFunctionCall: boolean,
): string {
  const incomplete = response?.incomplete_details as
    | { reason?: string }
    | undefined
  const status =
    typeof response?.status === 'string' ? response.status : undefined
  // Responses with tool calls report status=completed; tool presence wins.
  if (hasFunctionCall && status !== 'incomplete') return 'tool_use'
  const { finishReason } = normalizeResponsesFinishReason(
    status,
    incomplete?.reason,
  )
  return finishReasonToAnthropicStopReason(finishReason, hasFunctionCall)
}

type ResponsesErrorDetails = {
  message: string
  code: string | null
  type: string | null
  param: string | null
}

function responsesErrorDetails(
  event: Record<string, unknown>,
  fallback: string,
): ResponsesErrorDetails {
  const response = event.response as Record<string, unknown> | undefined
  const nested = response?.error as Record<string, unknown> | undefined
  const topError = event.error as Record<string, unknown> | undefined
  const message =
    (typeof event.message === 'string' && event.message) ||
    (typeof topError?.message === 'string' && topError.message) ||
    (typeof nested?.message === 'string' && nested.message) ||
    fallback
  const code =
    (typeof event.code === 'string' && event.code) ||
    (typeof topError?.code === 'string' && topError.code) ||
    (typeof nested?.code === 'string' && nested.code) ||
    null
  const type =
    (typeof topError?.type === 'string' && topError.type) ||
    (typeof nested?.type === 'string' && nested.type) ||
    (typeof event.type === 'string' && event.type) ||
    null
  const param =
    (typeof topError?.param === 'string' && topError.param) ||
    (typeof nested?.param === 'string' && nested.param) ||
    null
  return {
    message: code ? `${code}: ${message}` : message,
    code,
    type,
    param,
  }
}

function isNonRetryableResponsesError(details: ResponsesErrorDetails): boolean {
  const haystack =
    `${details.code ?? ''} ${details.type ?? ''} ${details.message}`.toLowerCase()
  return /invalid|authentication|unauthorized|forbidden|context|quota|billing|policy|safety|permission|request_too_large/.test(
    haystack,
  )
}

function createResponsesProviderError(
  event: Record<string, unknown>,
  fallback: string,
): ProviderStreamError {
  const details = responsesErrorDetails(event, fallback)
  const response = event.response as Record<string, unknown> | undefined
  const requestId =
    (typeof response?.id === 'string' && response.id) ||
    (typeof event.request_id === 'string' && event.request_id) ||
    null
  return new ProviderStreamError(details.message, {
    kind: 'provider',
    retryable: !isNonRetryableResponsesError(details),
    terminal: true,
    completionState:
      typeof response?.status === 'string' ? response.status : 'failed',
    requestId,
    code: details.code,
    type: details.type,
    param: details.param,
  })
}

type ToolBlockState = {
  contentIndex: number
  open: boolean
  name: string
  id: string
  arguments: string
}

export async function* adaptResponsesStreamToAnthropic(
  stream: AsyncIterable<Record<string, unknown>>,
  model: string,
): AsyncGenerator<BetaRawMessageStreamEvent, void> {
  const messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`
  // Official SSE keys arg deltas by item_id; Codex often uses output_index.
  const toolBlocksByOutputIndex = new Map<number, ToolBlockState>()
  const toolBlocksByItemId = new Map<string, ToolBlockState>()
  let started = false
  let currentContentIndex = -1
  let textBlockOpen = false
  let thinkingBlockOpen = false
  let thinkingHasContent = false
  let thinkingSeparatorPending = false
  let reasoningItemKey: string | undefined
  let reasoningSummaryIndex: number | undefined
  let pendingEncryptedContent: string | undefined
  const reasoningItemIdsByOutputIndex = new Map<number, string>()

  const resolveReasoningItemKey = (
    event: Record<string, unknown>,
    item?: Record<string, unknown>,
  ): string | undefined => {
    const outputIndex =
      typeof event.output_index === 'number' ? event.output_index : undefined
    const itemId =
      (typeof event.item_id === 'string' && event.item_id) ||
      (typeof item?.id === 'string' && item.id) ||
      undefined
    if (outputIndex !== undefined && itemId) {
      reasoningItemIdsByOutputIndex.set(outputIndex, itemId)
    }
    if (itemId) return `item:${itemId}`
    if (outputIndex !== undefined) {
      const mappedItemId = reasoningItemIdsByOutputIndex.get(outputIndex)
      return mappedItemId ? `item:${mappedItemId}` : `output:${outputIndex}`
    }
    return undefined
  }

  const resolveToolBlock = (
    event: Record<string, unknown>,
    item?: Record<string, unknown>,
  ): ToolBlockState | undefined => {
    if (typeof event.output_index === 'number') {
      const byIndex = toolBlocksByOutputIndex.get(event.output_index)
      if (byIndex) return byIndex
    }
    const itemId =
      (typeof event.item_id === 'string' && event.item_id) ||
      (typeof item?.id === 'string' && item.id) ||
      undefined
    if (itemId) return toolBlocksByItemId.get(itemId)
    return undefined
  }

  const ensureStarted = async function* () {
    if (started) return
    started = true
    yield {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    } as unknown as BetaRawMessageStreamEvent
  }

  for await (const event of stream) {
    const type = event.type
    if (event.error != null && typeof event.error === 'object') {
      throw createResponsesProviderError(event, 'OpenAI Responses stream error')
    }
    if (typeof type !== 'string' || type.length === 0) {
      throw new ProviderStreamError(
        'OpenAI Responses stream event did not include a valid type',
        {
          kind: 'protocol',
          retryable: false,
          terminal: false,
          completionState: 'invalid',
        },
      )
    }
    if (type === 'error' || type === 'response.error') {
      throw createResponsesProviderError(event, 'OpenAI Responses stream error')
    }
    for await (const startedEvent of ensureStarted()) yield startedEvent

    if (type === 'response.output_text.delta') {
      if (!textBlockOpen) {
        if (thinkingBlockOpen) {
          // Attach encrypted content as signature before closing, if any.
          if (pendingEncryptedContent) {
            yield {
              type: 'content_block_delta',
              index: currentContentIndex,
              delta: {
                type: 'signature_delta',
                signature: pendingEncryptedContent,
              },
            } as BetaRawMessageStreamEvent
            pendingEncryptedContent = undefined
          }
          yield {
            type: 'content_block_stop',
            index: currentContentIndex,
          } as BetaRawMessageStreamEvent
          thinkingBlockOpen = false
          thinkingHasContent = false
          thinkingSeparatorPending = false
          reasoningItemKey = undefined
          reasoningSummaryIndex = undefined
        }
        currentContentIndex++
        textBlockOpen = true
        yield {
          type: 'content_block_start',
          index: currentContentIndex,
          content_block: { type: 'text', text: '' },
        } as BetaRawMessageStreamEvent
      }
      yield {
        type: 'content_block_delta',
        index: currentContentIndex,
        delta: { type: 'text_delta', text: String(event.delta ?? '') },
      } as BetaRawMessageStreamEvent
      continue
    }

    if (
      type === 'response.reasoning_text.delta' ||
      type === 'response.reasoning_summary.delta' ||
      type === 'response.reasoning_summary_text.delta'
    ) {
      if (!thinkingBlockOpen) {
        if (textBlockOpen) {
          yield {
            type: 'content_block_stop',
            index: currentContentIndex,
          } as BetaRawMessageStreamEvent
          textBlockOpen = false
        }
        currentContentIndex++
        thinkingBlockOpen = true
        yield {
          type: 'content_block_start',
          index: currentContentIndex,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        } as BetaRawMessageStreamEvent
      }

      const nextItemKey = resolveReasoningItemKey(event)
      const nextSummaryIndex =
        typeof event.summary_index === 'number'
          ? event.summary_index
          : undefined
      if (
        thinkingHasContent &&
        ((nextItemKey !== undefined && nextItemKey !== reasoningItemKey) ||
          (nextSummaryIndex !== undefined &&
            nextSummaryIndex !== reasoningSummaryIndex))
      ) {
        thinkingSeparatorPending = true
      }
      if (nextItemKey !== undefined) reasoningItemKey = nextItemKey
      if (nextSummaryIndex !== undefined) {
        reasoningSummaryIndex = nextSummaryIndex
      }

      const fragment = String(event.delta ?? '')
      if (fragment) {
        if (thinkingSeparatorPending) {
          yield {
            type: 'content_block_delta',
            index: currentContentIndex,
            delta: { type: 'thinking_delta', thinking: '\n\n' },
          } as BetaRawMessageStreamEvent
          thinkingSeparatorPending = false
        }
        yield {
          type: 'content_block_delta',
          index: currentContentIndex,
          delta: { type: 'thinking_delta', thinking: fragment },
        } as BetaRawMessageStreamEvent
        thinkingHasContent = true
      }
      continue
    }

    if (type === 'response.output_item.added') {
      const item = event.item as Record<string, unknown> | undefined
      const outputIndex =
        typeof event.output_index === 'number' ? event.output_index : -1
      if (item?.type === 'reasoning') {
        const nextItemKey = resolveReasoningItemKey(event, item)
        if (
          thinkingHasContent &&
          nextItemKey !== undefined &&
          nextItemKey !== reasoningItemKey
        ) {
          thinkingSeparatorPending = true
        }
        if (nextItemKey !== undefined) reasoningItemKey = nextItemKey
        reasoningSummaryIndex = undefined
        if (typeof item.encrypted_content === 'string') {
          pendingEncryptedContent = item.encrypted_content
        }
        if (!thinkingBlockOpen) {
          if (textBlockOpen) {
            yield {
              type: 'content_block_stop',
              index: currentContentIndex,
            } as BetaRawMessageStreamEvent
            textBlockOpen = false
          }
          currentContentIndex++
          thinkingBlockOpen = true
          yield {
            type: 'content_block_start',
            index: currentContentIndex,
            content_block: {
              type: 'thinking',
              thinking: '',
              signature: '',
            },
          } as BetaRawMessageStreamEvent
        }
        continue
      }
      if (item?.type === 'function_call') {
        if (textBlockOpen) {
          yield {
            type: 'content_block_stop',
            index: currentContentIndex,
          } as BetaRawMessageStreamEvent
          textBlockOpen = false
        }
        if (thinkingBlockOpen) {
          if (pendingEncryptedContent) {
            yield {
              type: 'content_block_delta',
              index: currentContentIndex,
              delta: {
                type: 'signature_delta',
                signature: pendingEncryptedContent,
              },
            } as BetaRawMessageStreamEvent
            pendingEncryptedContent = undefined
          }
          yield {
            type: 'content_block_stop',
            index: currentContentIndex,
          } as BetaRawMessageStreamEvent
          thinkingBlockOpen = false
          thinkingHasContent = false
          thinkingSeparatorPending = false
          reasoningItemKey = undefined
          reasoningSummaryIndex = undefined
        }
        currentContentIndex++
        const itemId =
          typeof item.id === 'string' && item.id.length > 0
            ? item.id
            : undefined
        const id = String(
          item.call_id ??
            item.id ??
            `call_${outputIndex >= 0 ? outputIndex : currentContentIndex}`,
        )
        const name = String(item.name ?? '')
        const block: ToolBlockState = {
          contentIndex: currentContentIndex,
          open: true,
          name,
          id,
          arguments: typeof item.arguments === 'string' ? item.arguments : '',
        }
        if (outputIndex >= 0) toolBlocksByOutputIndex.set(outputIndex, block)
        if (itemId) toolBlocksByItemId.set(itemId, block)
        yield {
          type: 'content_block_start',
          index: currentContentIndex,
          content_block: { type: 'tool_use', id, name, input: {} },
        } as BetaRawMessageStreamEvent
        if (block.arguments) {
          yield {
            type: 'content_block_delta',
            index: currentContentIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: block.arguments,
            },
          } as BetaRawMessageStreamEvent
        }
      }
      continue
    }

    if (type === 'response.function_call_arguments.delta') {
      const block = resolveToolBlock(event)
      if (block) {
        const fragment = String(event.delta ?? '')
        block.arguments += fragment
        yield {
          type: 'content_block_delta',
          index: block.contentIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: fragment,
          },
        } as BetaRawMessageStreamEvent
      }
      continue
    }

    if (type === 'response.output_item.done') {
      const item = event.item as Record<string, unknown> | undefined
      if (
        item?.type === 'reasoning' &&
        typeof item.encrypted_content === 'string'
      ) {
        pendingEncryptedContent = item.encrypted_content
      }
      const block = resolveToolBlock(event, item)
      if (block?.open) {
        yield {
          type: 'content_block_stop',
          index: block.contentIndex,
        } as BetaRawMessageStreamEvent
        block.open = false
      }
      continue
    }

    if (type === 'error' || type === 'response.error') {
      throw createResponsesProviderError(event, 'OpenAI Responses stream error')
    }

    if (type === 'response.failed') {
      throw createResponsesProviderError(
        event,
        'OpenAI Responses response failed',
      )
    }

    if (type === 'response.incomplete') {
      const response = event.response as Record<string, unknown> | undefined
      if (response?.status !== 'incomplete') {
        throw new ProviderStreamError(
          'OpenAI Responses response.incomplete event had an invalid response status',
          {
            kind: 'protocol',
            retryable: false,
            terminal: false,
            completionState: 'invalid',
          },
        )
      }
      const incomplete = response.incomplete_details as
        | Record<string, unknown>
        | undefined
      const reason =
        typeof incomplete?.reason === 'string' ? incomplete.reason : null
      throw new ProviderStreamError(
        `OpenAI Responses response incomplete${reason ? `: ${reason}` : ''}`,
        {
          kind: 'incomplete',
          retryable: true,
          terminal: true,
          completionState: 'incomplete',
          requestId: typeof response?.id === 'string' ? response.id : undefined,
          incompleteReason: reason,
        },
      )
    }

    if (type === 'response.completed') {
      const response = event.response as Record<string, unknown> | undefined
      if (response?.status !== 'completed') {
        throw new ProviderStreamError(
          `OpenAI Responses ${type} event had an invalid response status`,
          {
            kind: 'protocol',
            retryable: false,
            terminal: false,
            completionState: 'invalid',
          },
        )
      }
      if (thinkingBlockOpen) {
        if (pendingEncryptedContent) {
          yield {
            type: 'content_block_delta',
            index: currentContentIndex,
            delta: {
              type: 'signature_delta',
              signature: pendingEncryptedContent,
            },
          } as BetaRawMessageStreamEvent
          pendingEncryptedContent = undefined
        }
        yield {
          type: 'content_block_stop',
          index: currentContentIndex,
        } as BetaRawMessageStreamEvent
      }
      if (textBlockOpen) {
        yield {
          type: 'content_block_stop',
          index: currentContentIndex,
        } as BetaRawMessageStreamEvent
      }
      const seenToolBlocks = new Set<ToolBlockState>([
        ...toolBlocksByOutputIndex.values(),
        ...toolBlocksByItemId.values(),
      ])
      for (const block of seenToolBlocks) {
        if (block.open) {
          yield {
            type: 'content_block_stop',
            index: block.contentIndex,
          } as BetaRawMessageStreamEvent
          block.open = false
        }
      }
      yield {
        type: 'message_delta',
        delta: {
          stop_reason: mapStopReason(response, seenToolBlocks.size > 0),
          stop_sequence: null,
        },
        usage: extractUsage(response),
      } as unknown as BetaRawMessageStreamEvent
      yield { type: 'message_stop' } as BetaRawMessageStreamEvent
      return
    }
  }

  throw new ProviderStreamError('stream closed before response.completed', {
    kind: 'premature_eof',
    retryable: true,
    terminal: false,
    completionState: 'open',
  })
}

export async function createChatGPTResponsesStream(params: {
  request: ChatGPTResponsesRequest
  signal: AbortSignal
  sessionId?: string
  fetchOverride?: typeof fetch
}): Promise<OpenAIStreamAttempt> {
  const auth = await getValidChatGPTAuth()
  const fetchFn = params.fetchOverride ?? (globalThis.fetch as typeof fetch)
  const headers: Record<string, string> = {
    ...responsesIdentityHeaders(params.sessionId),
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'responses=experimental',
    Origin: 'https://chatgpt.com',
    Referer: 'https://chatgpt.com/',
  }
  if (auth.accountId) {
    headers['ChatGPT-Account-Id'] = auth.accountId
  }
  const response = await fetchFn(
    'https://chatgpt.com/backend-api/codex/responses',
    {
      method: 'POST',
      headers,
      body: JSON.stringify(params.request),
      signal: params.signal,
    },
  )
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throwHttpStatusError(
      'ChatGPT Responses API request',
      response.status,
      text,
      response.headers,
    )
  }
  return {
    stream: parseSSE(response),
    status: response.status,
    requestId: responseRequestId(response),
    retryAfterMs: responseRetryAfterMs(response),
    cleanup: () => {
      void response.body?.cancel().catch(() => {})
    },
  }
}

/**
 * Official OpenAI `/v1/responses` stream.
 *
 * Prefer the shared OpenAI SDK client so timeout / proxy / usage-header
 * handling matches Chat Completions (Codex reuses one HTTP session for the
 * same reason). Fall back to raw fetch only when callers force apiKey/baseURL
 * outside the cached client env.
 */
export async function createOfficialResponsesStream(params: {
  request: ResponseCreateParamsStreaming
  signal: AbortSignal
  fetchOverride?: typeof fetch
  apiKey?: string
  baseURL?: string
  sessionId?: string
  source?: string
}): Promise<OpenAIStreamAttempt> {
  const useSdkClient = !params.apiKey && !params.baseURL
  if (useSdkClient) {
    const client = getOpenAIClient({
      maxRetries: 0,
      fetchOverride: params.fetchOverride,
      source: params.source,
    })
    const promise = client.responses.create(params.request, {
      signal: params.signal,
      headers: responsesIdentityHeaders(params.sessionId),
    })
    const { data, response, request_id } = await promise.withResponse()
    return {
      stream: data as unknown as AsyncIterable<Record<string, unknown>>,
      status: response.status,
      requestId: responseRequestId(response, request_id),
      retryAfterMs: responseRetryAfterMs(response),
      cleanup: () => {
        void response.body?.cancel().catch(() => {})
      },
    }
  }

  // Explicit base/key path (tests / rare overrides): still apply proxy + timeout.
  const fetchFn = params.fetchOverride ?? (globalThis.fetch as typeof fetch)
  const apiKey = params.apiKey ?? process.env.OPENAI_API_KEY ?? ''
  const base = (
    params.baseURL ??
    process.env.OPENAI_BASE_URL ??
    'https://api.openai.com/v1'
  ).replace(/\/$/, '')
  const timeoutMs = parseInt(
    process.env.API_TIMEOUT_MS || String(600 * 1000),
    10,
  )
  const { signal, cleanup } = createCombinedAbortSignal(params.signal, {
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 600_000,
  })
  try {
    const response = await fetchFn(`${base}/responses`, {
      method: 'POST',
      headers: {
        ...responsesIdentityHeaders(params.sessionId),
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params.request),
      signal,
      // Bun/Node fetchOptions: proxy + keepalive (same as OpenAI client).
      ...getProxyFetchOptions({ forAnthropicAPI: false }),
    } as RequestInit)
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throwHttpStatusError(
        'OpenAI Responses API request',
        response.status,
        text,
        response.headers,
      )
    }
    return {
      stream: parseSSEWithCleanup(response, cleanup),
      status: response.status,
      requestId: responseRequestId(response),
      retryAfterMs: responseRetryAfterMs(response),
      cleanup: () => {
        cleanup()
        void response.body?.cancel().catch(() => {})
      },
    }
  } catch (err) {
    cleanup()
    throw err
  }
}

async function* parseSSEWithCleanup(
  response: Response,
  cleanup: () => void,
): AsyncGenerator<Record<string, unknown>, void> {
  try {
    yield* parseSSE(response)
  } finally {
    cleanup()
  }
}
