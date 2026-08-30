import { randomUUID } from 'crypto'
import type OpenAI from 'openai'
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
  ResponseInputItem,
} from 'openai/resources/responses/responses.mjs'
import {
  forceRefreshChatGPTAuth,
  getValidChatGPTAuth,
  type ChatGPTAuth,
} from './chatgptAuth.js'
import { getOpenAIClient } from './client.js'
import { throwHttpStatusError } from './openaiShared.js'
import {
  isAzureResponsesBaseURL,
  type OpenAIJSONOutputFormat,
} from './requestBody.js'
import { MAX_RETAINED_SSE_BUFFER_BYTES } from '../../../constants/apiLimits.js'
import { abortable } from '../../../utils/abort.js'
import { createCombinedAbortSignal } from '../../../utils/combinedAbortSignal.js'
import { getProxyFetchOptions } from '../../../utils/proxy.js'
import type { OpenAIStreamAttempt } from './streamExecutor.js'

/** Codex `X_CODEX_INSTALLATION_ID_HEADER` — body key in client_metadata. */
const X_CODEX_INSTALLATION_ID = 'x-codex-installation-id'
/** Codex `X_CODEX_WINDOW_ID_HEADER` — body + HTTP compatibility projection. */
const X_CODEX_WINDOW_ID = 'x-codex-window-id'
const UTF8_ENCODER = new TextEncoder()

export type ResponsesInputItem = ResponseInputItem | Record<string, unknown>

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
  messages?: unknown[]
  input?: ResponsesInputItem[]
  instructions?: string
  tools: unknown[]
  toolChoice: unknown
  reasoningEffort?: ResponsesReasoningEffort
  /** Override for tests; production uses the current CCB session id. */
  promptCacheKey?: string
  sessionId?: string
  /**
   * Codex installation_id. ChatGPT path only.
   * Caller-injected (streamAttempt uses getOrCreateUserID); builder stays pure.
   */
  installationId?: string
  /** Default true: request encrypted reasoning for store:false multi-turn. */
  includeEncryptedReasoning?: boolean
  outputFormat?: OpenAIJSONOutputFormat
  /** Defaults from OPENAI_BASE_URL azure markers when omitted. */
  store?: boolean
}

/**
 * Codex `CodexResponsesMetadata::client_metadata()` baseline keys.
 * Always: x-codex-installation-id, session_id, thread_id, x-codex-window-id.
 * Optional turn/subagent/parent fields omitted until CCB has real sources.
 * Root agents: session_id === thread_id (Codex Session::new).
 *
 * Intentional CCB delta: window stays `${threadId}:0` until CCB has a real
 * compact/window source. prompt_cache_key is set by streamAttempt to raw
 * session_id (Codex ModelClient::prompt_cache_key), not a ccb: prefix.
 */
export function buildCodexClientMetadata(params: {
  sessionId: string
  installationId: string
  threadId?: string
  windowNumber?: number
}): Record<string, string> {
  const threadId = params.threadId ?? params.sessionId
  const windowNumber = params.windowNumber ?? 0
  return {
    [X_CODEX_INSTALLATION_ID]: params.installationId,
    session_id: params.sessionId,
    thread_id: threadId,
    [X_CODEX_WINDOW_ID]: `${threadId}:${windowNumber}`,
  }
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
  const converted = params.input
    ? { input: params.input, instructions: params.instructions }
    : convertMessagesToResponsesInput(params.messages ?? [])
  const tools = convertToolsToResponses(params.tools)
  const includeEncrypted = params.includeEncryptedReasoning !== false
  return {
    model: params.model,
    stream: true as const,
    store: params.store ?? isAzureResponsesBaseURL(),
    input: converted.input,
    ...(converted.instructions ? { instructions: converted.instructions } : {}),
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
  // Codex ResponsesApiRequest always sets tool_choice: "auto". Forced function
  // choice remains available for side-query classifiers that pass toolChoice.
  const tools = Array.isArray(params.tools) ? params.tools : []
  const toolChoice = params.toolChoice
    ? convertToolChoiceToResponses(params.toolChoice)
    : tools.length > 0
      ? 'auto'
      : undefined
  return {
    ...fields,
    store: false,
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(params.reasoningEffort && {
      reasoning:
        params.reasoningEffort === 'max'
          ? { effort: params.reasoningEffort }
          : { effort: params.reasoningEffort, summary: 'auto' as const },
    }),
    // Codex private Responses: client_metadata is the canonical identity blob.
    // Headers below project a subset (session/thread/window); do not invent extras.
    // installationId is required for metadata — omit blob when caller skipped it.
    ...(params.sessionId &&
      params.installationId && {
        client_metadata: buildCodexClientMetadata({
          sessionId: params.sessionId,
          installationId: params.installationId,
        }),
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

/**
 * Codex HTTP projections for Responses:
 * - session-id / thread-id (build_session_headers)
 * - x-client-request-id = thread_id (ResponsesClient::stream_request)
 * - x-codex-window-id from compatibility_headers (ChatGPT/Codex only)
 * installation_id stays in client_metadata body on normal stream (not header).
 */
export function responsesIdentityHeaders(
  sessionId: string | undefined,
  options?: { codexWindowId?: string; originator?: string },
): Record<string, string> {
  return {
    Accept: 'text/event-stream',
    originator: options?.originator ?? 'claude-code-best',
    ...(sessionId && {
      'session-id': sessionId,
      'thread-id': sessionId,
      'x-client-request-id': sessionId,
    }),
    ...(options?.codexWindowId && {
      [X_CODEX_WINDOW_ID]: options.codexWindowId,
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

function assertRetainedSSEBufferWithinLimit(byteLength: number): void {
  if (byteLength <= MAX_RETAINED_SSE_BUFFER_BYTES) {
    return
  }

  throw new ProviderStreamError(
    `Responses SSE retained buffer exceeded ${MAX_RETAINED_SSE_BUFFER_BYTES} bytes`,
    {
      kind: 'protocol',
      retryable: false,
      terminal: false,
    },
  )
}

/**
 * Exported for focused framing tests (LF / CRLF / trailing frame).
 *
 * SHAPE: every throw below surfaces at the consumer's first `.next()`, never at
 * the three construction sites, because a generator body does not run until
 * iterated. The sites are createChatGPTResponsesStream, and both paths of
 * createOfficialResponsesStream (SDK-client via parseSSE, explicit base/key via
 * parseSSEWithCleanup). Two consequences worth knowing before editing:
 *
 * - The guard is not the nearest `try`. createOfficialResponsesStream's own
 *   `catch (err)` has already exited by the time iteration starts, so it never
 *   sees the no-body throw — the `finally` in parseSSEWithCleanup is what
 *   releases the response on that path.
 * - The real handler is three wrappers away: the stream is threaded through
 *   withOpenAIStreamIdleTimeout → logOpenAIRawStream → adaptPreparedOpenAIStream
 *   and consumed by the `for await` in openai/index.ts, inside a try whose catch
 *   records streamError and lets `retryable` drive the transient-retry loop.
 *   Hence `retryable: true` here: a body-less response is worth one more attempt.
 */
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
  let retainedByteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        // Flush any multibyte char held by the decoder.
        const decoded = decoder.decode()
        buffer += decoded
        retainedByteLength += UTF8_ENCODER.encode(decoded).byteLength
        break
      }
      const decoded = decoder.decode(value, { stream: true })
      buffer += decoded
      retainedByteLength += UTF8_ENCODER.encode(decoded).byteLength
      let boundary = nextSseFrameBoundary(buffer)
      while (boundary) {
        const consumedLength = boundary.at + boundary.sepLen
        const frame = buffer.slice(0, boundary.at)
        retainedByteLength -= UTF8_ENCODER.encode(
          buffer.slice(0, consumedLength),
        ).byteLength
        buffer = buffer.slice(consumedLength)
        const event = parseSseDataFrame(frame)
        if (event) yield event
        boundary = nextSseFrameBoundary(buffer)
      }
      assertRetainedSSEBufferWithinLimit(retainedByteLength)
    }

    let boundary = nextSseFrameBoundary(buffer)
    while (boundary) {
      const consumedLength = boundary.at + boundary.sepLen
      const frame = buffer.slice(0, boundary.at)
      retainedByteLength -= UTF8_ENCODER.encode(
        buffer.slice(0, consumedLength),
      ).byteLength
      buffer = buffer.slice(consumedLength)
      const event = parseSseDataFrame(frame)
      if (event) yield event
      boundary = nextSseFrameBoundary(buffer)
    }
    assertRetainedSSEBufferWithinLimit(retainedByteLength)

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
  started: boolean
  finalized: boolean
  name: string
  id: string
  arguments: string
}

type ReasoningPartState = {
  buffered: string
  emitted: string
  finalized: boolean
  finalText: string | undefined
}

type ReasoningBlockState = {
  contentIndex: number
  open: boolean
  parts: Map<string, ReasoningPartState>
  lastEmittedPart: string | undefined
  encryptedContent: string | undefined
}

function responsesProtocolError(message: string): ProviderStreamError {
  return new ProviderStreamError(message, {
    kind: 'protocol',
    retryable: false,
    terminal: false,
    completionState: 'invalid',
  })
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
  let activeReasoningKey: string | undefined
  const outputItemIdsByOutputIndex = new Map<number, string>()
  const reasoningBlocks = new Map<string, ReasoningBlockState>()
  const textParts = new Map<string, { text: string; finalized: boolean }>()

  const resolveOutputItemKey = (
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
      outputItemIdsByOutputIndex.set(outputIndex, itemId)
      const provisionalKey = `output:${outputIndex}`
      const finalKey = `item:${itemId}`
      const provisionalReasoning = reasoningBlocks.get(provisionalKey)
      if (provisionalReasoning && !reasoningBlocks.has(finalKey)) {
        reasoningBlocks.set(finalKey, provisionalReasoning)
        reasoningBlocks.delete(provisionalKey)
        if (activeReasoningKey === provisionalKey) activeReasoningKey = finalKey
      }
      for (const [key, part] of textParts) {
        if (!key.startsWith(`${provisionalKey}:content:`)) continue
        textParts.set(`${finalKey}${key.slice(provisionalKey.length)}`, part)
        textParts.delete(key)
      }
    }
    if (itemId) return `item:${itemId}`
    if (outputIndex !== undefined) {
      const mappedItemId = outputItemIdsByOutputIndex.get(outputIndex)
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

  const closeTextBlock = async function* () {
    if (!textBlockOpen) return
    yield {
      type: 'content_block_stop',
      index: currentContentIndex,
    } as BetaRawMessageStreamEvent
    textBlockOpen = false
  }

  const closeReasoningBlock = async function* (key: string) {
    const block = reasoningBlocks.get(key)
    if (!block?.open) return
    for (const [partKey, part] of block.parts) {
      if (part.finalized) continue
      for await (const output of reconcileReasoningPart(
        block,
        partKey,
        part.emitted + part.buffered,
      )) {
        yield output
      }
    }
    if (block.encryptedContent) {
      yield {
        type: 'content_block_delta',
        index: block.contentIndex,
        delta: {
          type: 'signature_delta',
          signature: block.encryptedContent,
        },
      } as BetaRawMessageStreamEvent
    }
    yield {
      type: 'content_block_stop',
      index: block.contentIndex,
    } as BetaRawMessageStreamEvent
    block.open = false
    if (activeReasoningKey === key) activeReasoningKey = undefined
  }

  const closeReasoningBlocks = async function* () {
    for (const key of reasoningBlocks.keys()) {
      for await (const event of closeReasoningBlock(key)) yield event
    }
  }

  const ensureTextBlock = async function* () {
    if (textBlockOpen) return
    for await (const event of closeReasoningBlocks()) yield event
    currentContentIndex++
    textBlockOpen = true
    yield {
      type: 'content_block_start',
      index: currentContentIndex,
      content_block: { type: 'text', text: '' },
    } as BetaRawMessageStreamEvent
  }

  const textPartKey = (
    event: Record<string, unknown>,
    item?: Record<string, unknown>,
    contentIndex?: number,
  ): string => {
    const itemKey = resolveOutputItemKey(event, item) ?? 'output:default'
    const partIndex =
      contentIndex ??
      (typeof event.content_index === 'number' ? event.content_index : 0)
    return `${itemKey}:content:${partIndex}`
  }

  const emitText = async function* (key: string, text: string, final: boolean) {
    const part = textParts.get(key) ?? { text: '', finalized: false }
    if (part.finalized) {
      if (final && part.text === text) return
      throw responsesProtocolError(
        `OpenAI Responses text changed after finalization for ${key}`,
      )
    }

    let fragment = text
    if (final) {
      if (!text.startsWith(part.text)) {
        throw responsesProtocolError(
          `OpenAI Responses final text did not extend streamed prefix for ${key}`,
        )
      }
      fragment = text.slice(part.text.length)
      part.text = text
      part.finalized = true
    } else {
      part.text += text
    }
    textParts.set(key, part)
    if (!fragment) return

    for await (const event of ensureTextBlock()) yield event
    yield {
      type: 'content_block_delta',
      index: currentContentIndex,
      delta: { type: 'text_delta', text: fragment },
    } as BetaRawMessageStreamEvent
  }

  const ensureReasoningBlock = async function* (key: string) {
    const existing = reasoningBlocks.get(key)
    if (existing) {
      if (!existing.open) {
        throw responsesProtocolError(
          `OpenAI Responses reasoning item emitted content after done for ${key}`,
        )
      }
      activeReasoningKey = key
      return
    }

    for await (const event of closeTextBlock()) yield event
    if (activeReasoningKey && activeReasoningKey !== key) {
      for await (const event of closeReasoningBlock(activeReasoningKey)) {
        yield event
      }
    }
    currentContentIndex++
    reasoningBlocks.set(key, {
      contentIndex: currentContentIndex,
      open: true,
      parts: new Map(),
      lastEmittedPart: undefined,
      encryptedContent: undefined,
    })
    activeReasoningKey = key
    yield {
      type: 'content_block_start',
      index: currentContentIndex,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    } as BetaRawMessageStreamEvent
  }

  const emitReasoningFragment = async function* (
    block: ReasoningBlockState,
    partKey: string,
    fragment: string,
  ) {
    if (!fragment) return
    if (block.lastEmittedPart && block.lastEmittedPart !== partKey) {
      yield {
        type: 'content_block_delta',
        index: block.contentIndex,
        delta: { type: 'thinking_delta', thinking: '\n\n' },
      } as BetaRawMessageStreamEvent
    }
    yield {
      type: 'content_block_delta',
      index: block.contentIndex,
      delta: { type: 'thinking_delta', thinking: fragment },
    } as BetaRawMessageStreamEvent
    block.lastEmittedPart = partKey
  }

  const reconcileReasoningPart = async function* (
    block: ReasoningBlockState,
    partKey: string,
    finalText: string,
  ) {
    const part = block.parts.get(partKey) ?? {
      buffered: '',
      emitted: '',
      finalized: false,
      finalText: undefined,
    }
    if (part.finalized) {
      if (part.finalText === finalText) return
      throw responsesProtocolError(
        `OpenAI Responses reasoning part changed after finalization for ${partKey}`,
      )
    }
    if (part.emitted && !finalText.startsWith(part.emitted)) {
      throw responsesProtocolError(
        `OpenAI Responses final reasoning text did not extend streamed prefix for ${partKey}`,
      )
    }
    const fragment = finalText.startsWith(part.emitted)
      ? finalText.slice(part.emitted.length)
      : finalText
    for await (const output of emitReasoningFragment(
      block,
      partKey,
      fragment,
    )) {
      yield output
    }
    part.emitted += fragment
    part.buffered = ''
    part.finalized = true
    part.finalText = finalText
    block.parts.set(partKey, part)
  }

  const startToolBlock = async function* (block: ToolBlockState) {
    if (block.started) return
    if (!block.id || !block.name) {
      throw responsesProtocolError(
        'OpenAI Responses function call finished without call_id and name',
      )
    }
    for await (const event of closeTextBlock()) yield event
    for await (const event of closeReasoningBlocks()) yield event
    currentContentIndex++
    block.contentIndex = currentContentIndex
    block.started = true
    yield {
      type: 'content_block_start',
      index: block.contentIndex,
      content_block: {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: {},
      },
    } as BetaRawMessageStreamEvent
    if (block.arguments) {
      yield {
        type: 'content_block_delta',
        index: block.contentIndex,
        delta: {
          type: 'input_json_delta',
          partial_json: block.arguments,
        },
      } as BetaRawMessageStreamEvent
    }
  }

  const reconcileToolArguments = async function* (
    block: ToolBlockState,
    finalArguments: string,
  ) {
    if (!finalArguments.startsWith(block.arguments)) {
      throw responsesProtocolError(
        `OpenAI Responses final function arguments did not extend streamed prefix for ${block.id || 'unknown call'}`,
      )
    }
    const fragment = finalArguments.slice(block.arguments.length)
    block.arguments = finalArguments
    if (!block.started) {
      for await (const event of startToolBlock(block)) yield event
    } else if (fragment) {
      yield {
        type: 'content_block_delta',
        index: block.contentIndex,
        delta: {
          type: 'input_json_delta',
          partial_json: fragment,
        },
      } as BetaRawMessageStreamEvent
    }
  }

  const finishMessage = async function* (response: Record<string, unknown>) {
    for await (const event of closeTextBlock()) yield event
    for await (const event of closeReasoningBlocks()) yield event
    const seenToolBlocks = new Set<ToolBlockState>([
      ...toolBlocksByOutputIndex.values(),
      ...toolBlocksByItemId.values(),
    ])
    for (const block of seenToolBlocks) {
      if (!block.started) {
        for await (const event of startToolBlock(block)) yield event
      }
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

    if (
      type === 'response.output_text.delta' ||
      type === 'response.refusal.delta'
    ) {
      for await (const output of emitText(
        textPartKey(event),
        String(event.delta ?? ''),
        false,
      )) {
        yield output
      }
      continue
    }

    if (
      type === 'response.output_text.done' ||
      type === 'response.refusal.done'
    ) {
      const finalText = String(
        type === 'response.refusal.done'
          ? (event.refusal ?? event.text ?? '')
          : (event.text ?? ''),
      )
      for await (const output of emitText(
        textPartKey(event),
        finalText,
        true,
      )) {
        yield output
      }
      continue
    }

    if (
      type === 'response.reasoning_text.delta' ||
      type === 'response.reasoning_summary.delta' ||
      type === 'response.reasoning_summary_text.delta'
    ) {
      const scopedKey = resolveOutputItemKey(event)
      const key = scopedKey ?? activeReasoningKey
      if (!key) {
        throw responsesProtocolError(
          'OpenAI Responses reasoning delta did not identify an output item',
        )
      }
      for await (const output of ensureReasoningBlock(key)) yield output
      const block = reasoningBlocks.get(key)
      if (!block) throw responsesProtocolError('Missing reasoning block state')
      const kind =
        type === 'response.reasoning_text.delta' ? 'content' : 'summary'
      const partIndex =
        kind === 'content'
          ? typeof event.content_index === 'number'
            ? event.content_index
            : 0
          : typeof event.summary_index === 'number'
            ? event.summary_index
            : 0
      const partKey = `${kind}:${partIndex}`
      const part = block.parts.get(partKey) ?? {
        buffered: '',
        emitted: '',
        finalized: false,
        finalText: undefined,
      }
      const fragment = String(event.delta ?? '')
      if (scopedKey) {
        for await (const output of emitReasoningFragment(
          block,
          partKey,
          fragment,
        )) {
          yield output
        }
        part.emitted += fragment
      } else {
        part.buffered += fragment
      }
      block.parts.set(partKey, part)
      continue
    }

    if (
      type === 'response.reasoning_text.done' ||
      type === 'response.reasoning_summary_text.done'
    ) {
      const key = resolveOutputItemKey(event) ?? activeReasoningKey
      if (!key) {
        throw responsesProtocolError(
          'OpenAI Responses reasoning done event did not identify an output item',
        )
      }
      const existing = reasoningBlocks.get(key)
      if (existing && !existing.open) continue
      for await (const output of ensureReasoningBlock(key)) yield output
      const block = reasoningBlocks.get(key)
      if (!block) throw responsesProtocolError('Missing reasoning block state')
      const kind =
        type === 'response.reasoning_text.done' ? 'content' : 'summary'
      const partIndex =
        kind === 'content'
          ? typeof event.content_index === 'number'
            ? event.content_index
            : 0
          : typeof event.summary_index === 'number'
            ? event.summary_index
            : 0
      for await (const output of reconcileReasoningPart(
        block,
        `${kind}:${partIndex}`,
        String(event.text ?? ''),
      )) {
        yield output
      }
      continue
    }

    if (type === 'response.output_item.added') {
      const item = event.item as Record<string, unknown> | undefined
      const outputIndex =
        typeof event.output_index === 'number' ? event.output_index : undefined
      if (item?.type === 'reasoning') {
        const key = resolveOutputItemKey(event, item)
        if (!key) {
          throw responsesProtocolError(
            'OpenAI Responses reasoning item did not include id or output_index',
          )
        }
        for await (const output of ensureReasoningBlock(key)) yield output
        const block = reasoningBlocks.get(key)
        if (block && typeof item.encrypted_content === 'string') {
          block.encryptedContent = item.encrypted_content
        }
        continue
      }
      if (item?.type === 'function_call') {
        const itemId =
          typeof item.id === 'string' && item.id.length > 0
            ? item.id
            : undefined
        const block: ToolBlockState = {
          contentIndex: -1,
          open: true,
          started: false,
          finalized: false,
          name: typeof item.name === 'string' ? item.name : '',
          id: typeof item.call_id === 'string' ? item.call_id : '',
          arguments: typeof item.arguments === 'string' ? item.arguments : '',
        }
        if (outputIndex !== undefined) {
          toolBlocksByOutputIndex.set(outputIndex, block)
        }
        if (itemId) toolBlocksByItemId.set(itemId, block)
        resolveOutputItemKey(event, item)
        if (block.name && block.id) {
          for await (const output of startToolBlock(block)) yield output
        }
      }
      continue
    }

    if (type === 'response.function_call_arguments.delta') {
      const block = resolveToolBlock(event)
      if (!block) {
        throw responsesProtocolError(
          'OpenAI Responses function arguments delta did not match a function call',
        )
      }
      if (block.finalized) {
        throw responsesProtocolError(
          `OpenAI Responses function arguments changed after finalization for ${block.id || 'unknown call'}`,
        )
      }
      const fragment = String(event.delta ?? '')
      block.arguments += fragment
      if (!block.started) {
        if (block.name && block.id) {
          for await (const output of startToolBlock(block)) yield output
        }
      } else if (fragment) {
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

    if (type === 'response.function_call_arguments.done') {
      const block = resolveToolBlock(event)
      if (!block) {
        throw responsesProtocolError(
          'OpenAI Responses final function arguments did not match a function call',
        )
      }
      const finalArguments = String(event.arguments ?? '')
      for await (const output of reconcileToolArguments(
        block,
        finalArguments,
      )) {
        yield output
      }
      block.finalized = true
      continue
    }

    if (type === 'response.output_item.done') {
      const item = event.item as Record<string, unknown> | undefined
      if (!item || typeof item.type !== 'string') {
        throw responsesProtocolError(
          'OpenAI Responses output_item.done did not include an item',
        )
      }
      const key = resolveOutputItemKey(event, item)
      if (item.type === 'reasoning') {
        if (!key) {
          throw responsesProtocolError(
            'OpenAI Responses final reasoning item did not include id or output_index',
          )
        }
        for await (const output of ensureReasoningBlock(key)) yield output
        const block = reasoningBlocks.get(key)
        if (!block)
          throw responsesProtocolError('Missing reasoning block state')
        const finalParts = (
          [
            ['summary', item.summary],
            ['content', item.content],
          ] as const
        ).flatMap(([kind, values]) =>
          Array.isArray(values)
            ? values.flatMap((part, index) =>
                part &&
                typeof part === 'object' &&
                typeof (part as Record<string, unknown>).text === 'string'
                  ? [
                      {
                        key: `${kind}:${index}`,
                        text: (part as { text: string }).text,
                      },
                    ]
                  : [],
              )
            : [],
        )
        if (finalParts.length > 0) {
          for (const part of finalParts) {
            for await (const output of reconcileReasoningPart(
              block,
              part.key,
              part.text,
            )) {
              yield output
            }
          }
        } else {
          for (const [partKey, part] of block.parts) {
            for await (const output of reconcileReasoningPart(
              block,
              partKey,
              part.emitted + part.buffered,
            )) {
              yield output
            }
          }
        }
        if (typeof item.encrypted_content === 'string') {
          block.encryptedContent = item.encrypted_content
        }
        for await (const output of closeReasoningBlock(key)) yield output
        continue
      }
      if (item.type === 'function_call') {
        const outputIndex =
          typeof event.output_index === 'number'
            ? event.output_index
            : undefined
        const itemId =
          typeof item.id === 'string' && item.id.length > 0
            ? item.id
            : undefined
        let block = resolveToolBlock(event, item)
        if (!block) {
          block = {
            contentIndex: -1,
            open: true,
            started: false,
            finalized: false,
            name: '',
            id: '',
            arguments: '',
          }
          if (outputIndex !== undefined) {
            toolBlocksByOutputIndex.set(outputIndex, block)
          }
          if (itemId) toolBlocksByItemId.set(itemId, block)
        }
        const finalName = typeof item.name === 'string' ? item.name : ''
        const finalId = typeof item.call_id === 'string' ? item.call_id : ''
        if (block.name && finalName && block.name !== finalName) {
          throw responsesProtocolError(
            `OpenAI Responses final function name conflicted for ${block.id || finalId || 'unknown call'}`,
          )
        }
        if (block.id && finalId && block.id !== finalId) {
          throw responsesProtocolError(
            `OpenAI Responses final call_id conflicted for ${block.id}`,
          )
        }
        block.name = finalName || block.name
        block.id = finalId || block.id
        const finalArguments =
          typeof item.arguments === 'string' ? item.arguments : block.arguments
        if (block.finalized && finalArguments !== block.arguments) {
          throw responsesProtocolError(
            `OpenAI Responses final function arguments conflicted for ${block.id || 'unknown call'}`,
          )
        }
        for await (const output of reconcileToolArguments(
          block,
          finalArguments,
        )) {
          yield output
        }
        block.finalized = true
        if (block.open) {
          yield {
            type: 'content_block_stop',
            index: block.contentIndex,
          } as BetaRawMessageStreamEvent
          block.open = false
        }
        continue
      }
      if (item.type === 'message') {
        const content = Array.isArray(item.content) ? item.content : []
        for (const [contentIndex, partValue] of content.entries()) {
          if (!partValue || typeof partValue !== 'object') continue
          const part = partValue as Record<string, unknown>
          if (part.type === 'output_text' && typeof part.text === 'string') {
            for await (const output of emitText(
              textPartKey(event, item, contentIndex),
              part.text,
              true,
            )) {
              yield output
            }
          } else if (
            part.type === 'refusal' &&
            typeof part.refusal === 'string'
          ) {
            for await (const output of emitText(
              textPartKey(event, item, contentIndex),
              part.refusal,
              true,
            )) {
              yield output
            }
          }
        }
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
      if (reason === 'max_output_tokens') {
        for await (const output of finishMessage(response)) yield output
        return
      }
      const retryable =
        reason === 'server_error' ||
        reason === 'timeout' ||
        reason === 'overloaded' ||
        reason === 'rate_limit_exceeded'
      throw new ProviderStreamError(
        `OpenAI Responses response incomplete${reason ? `: ${reason}` : ''}`,
        {
          kind: 'incomplete',
          retryable,
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
      for await (const output of finishMessage(response)) yield output
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

export type UnauthorizedReplayState = {
  used: boolean
  accountId?: string
  accessToken?: string
}

export async function createChatGPTResponsesStream(params: {
  request: ChatGPTResponsesRequest
  signal: AbortSignal
  sessionId?: string
  fetchOverride?: typeof fetch
  originator: string
  unauthorizedReplay: UnauthorizedReplayState
}): Promise<OpenAIStreamAttempt> {
  const fetchFn = params.fetchOverride ?? (globalThis.fetch as typeof fetch)
  const codexWindowId =
    params.request.client_metadata?.[X_CODEX_WINDOW_ID] ??
    (params.sessionId ? `${params.sessionId}:0` : undefined)
  const body = JSON.stringify(params.request)
  let auth = await getValidChatGPTAuth(params.signal)
  const replay = params.unauthorizedReplay
  replay.accountId ??= auth.accountId
  if (replay.accountId !== auth.accountId) {
    throw new Error('ChatGPT account changed before request retry')
  }
  replay.accessToken = auth.accessToken

  for (;;) {
    const headers: Record<string, string> = {
      ...responsesIdentityHeaders(params.sessionId, {
        codexWindowId,
        originator: params.originator,
      }),
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json',
    }
    if (auth.accountId) {
      headers['ChatGPT-Account-Id'] = auth.accountId
    }

    const response = await fetchFn(
      'https://chatgpt.com/backend-api/codex/responses',
      {
        method: 'POST',
        headers,
        body,
        signal: params.signal,
      },
    )
    if (response.ok) {
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

    const text = await response.text().catch(() => '')
    if (response.status === 401 && !replay.used && replay.accountId) {
      replay.used = true
      try {
        const next: ChatGPTAuth = await abortable(
          forceRefreshChatGPTAuth(replay.accountId, replay.accessToken),
          params.signal,
        )
        if (
          next.accountId === replay.accountId &&
          next.accessToken !== replay.accessToken
        ) {
          replay.accessToken = next.accessToken
          auth = next
          continue
        }
      } catch (error) {
        if (params.signal.aborted) throw error
        // Preserve the provider's original 401 below. A refresh failure must not
        // hide the request error behind a local credential-storage message.
      }
    }

    throwHttpStatusError(
      'ChatGPT Responses API request',
      response.status,
      text,
      response.headers,
    )
  }
}

export async function createResponsesStreamWithClient(params: {
  client: OpenAI
  request: ResponseCreateParamsStreaming
  signal: AbortSignal
  headers?: Record<string, string>
}): Promise<OpenAIStreamAttempt> {
  const promise = params.client.responses.create(params.request, {
    signal: params.signal,
    headers: params.headers,
  })
  const response = await promise.asResponse()
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
      headers: params.sessionId
        ? responsesIdentityHeaders(params.sessionId)
        : undefined,
    })
    const response = await promise.asResponse()
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
        ...(params.sessionId ? responsesIdentityHeaders(params.sessionId) : {}),
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
