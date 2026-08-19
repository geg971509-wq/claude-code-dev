/**
 * Shared utilities for OpenAI-compatible API paths.
 *
 * Both the OpenAI path (queryModelOpenAI) and Grok path (queryModelGrok) use
 * the same adapters (openaiStreamAdapter, openaiConvertMessages), so the event
 * processing logic should be shared rather than duplicated.
 *
 * Keep this module free of bootstrap/state imports so pure request-body unit
 * tests and isolated mocks do not need a full session runtime.
 */

/**
 * Whether a configured base URL resolves directly to OpenAI's official API.
 *
 * An absent URL means the OpenAI SDK default (`api.openai.com`). Regional
 * endpoints are subdomains of `api.openai.com`. Keep this strict so generic
 * OpenAI-compatible providers never receive OpenAI-specific cache parameters.
 */
export function isOfficialOpenAIBaseURL(baseURL: string | undefined): boolean {
  if (!baseURL?.trim()) return true

  try {
    const url = new URL(baseURL)
    const isOfficialHost =
      url.hostname === 'api.openai.com' ||
      url.hostname.endsWith('.api.openai.com')
    return (
      url.protocol === 'https:' &&
      isOfficialHost &&
      (url.port === '' || url.port === '443')
    )
  } catch {
    return false
  }
}

/**
 * Build a stable OpenAI `prompt_cache_key` for a session.
 *
 * OpenAI automatic prefix caching benefits from routing sticky keys so multi-turn
 * requests land on the same cache-bearing compute node. The key must be stable
 * for the whole conversation — never derived from full message bodies (that
 * changes every turn and defeats routing).
 *
 * Format: `ccb:<sessionId>`
 */
export function formatOpenAIPromptCacheKey(sessionId: string): string {
  return `ccb:${sessionId}`
}

/**
 * Return a session-sticky cache key only for OpenAI's official API endpoint.
 * Compatible providers must not receive OpenAI-specific request parameters.
 */
export function getOfficialOpenAIPromptCacheKey(
  baseURL: string | undefined,
  sessionId: string,
): string | undefined {
  return isOfficialOpenAIBaseURL(baseURL)
    ? formatOpenAIPromptCacheKey(sessionId)
    : undefined
}

import {
  classifyProviderHttpError,
  getProviderErrorStatus,
  getProviderRetryAfterMs,
  parseRetryAfterMs,
  ProviderStreamError,
  type ProviderAPIError,
} from '@ant/model-provider'
import { APIConnectionError as OpenAIAPIConnectionError } from 'openai'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { shortErrorStack } from '../../../utils/errors.js'
import { sleep } from '../../../utils/sleep.js'

/**
 * Whether an event carries content the user would actually see. Providers open
 * a stream with role-only/empty scaffolding events; treating those as output
 * would strand the stream-retry loop, since a stream that goes idle after
 * `message_start` is exactly the case retrying exists for.
 */
export function isSemanticOpenAIEvent(
  event: BetaRawMessageStreamEvent,
): boolean {
  if (event.type === 'content_block_delta') {
    const delta = event.delta
    if (delta.type === 'text_delta') return delta.text.length > 0
    // Thinking-only is not user-visible output. Grok can emit thinking then
    // sit silent past the 300s idle watchdog; treating that as committed made
    // the timeout fatal. Official Codex retries the whole sampling request on
    // Timeout regardless of reasoning tokens already received.
    if (delta.type === 'thinking_delta') return false
    if (delta.type === 'signature_delta') return false
    if (delta.type === 'input_json_delta') return delta.partial_json.length > 0
    return true
  }
  if (event.type !== 'content_block_start') return false
  const block = event.content_block
  if (block.type === 'tool_use') {
    return block.id.length > 0 || block.name.length > 0
  }
  if (block.type === 'text') return block.text.length > 0
  if (block.type === 'thinking') return false
  return true
}

export const THINKING_LOOP_MIN_CHARS = 20
export const THINKING_LOOP_REPEAT = 6

/**
 * Detect a thinking channel stuck restating the same sentence. Tokens are
 * still arriving, so the idle watchdog never fires. Official Codex has no
 * equivalent; we cut the stream instead of waiting for the user to abort.
 */
export function createThinkingLoopDetector(options?: {
  minChars?: number
  repeat?: number
}): { push: (chunk: string) => boolean } {
  const minChars = options?.minChars ?? THINKING_LOOP_MIN_CHARS
  const repeat = options?.repeat ?? THINKING_LOOP_REPEAT
  let leftover = ''
  let lastChunk = ''
  let chunkStreak = 0
  const counts = new Map<string, number>()

  function note(sentence: string): boolean {
    const norm = sentence.replace(/\s+/g, ' ').trim().toLowerCase()
    if (norm.length < minChars) return false
    const next = (counts.get(norm) ?? 0) + 1
    counts.set(norm, next)
    return next >= repeat
  }

  return {
    push(chunk: string): boolean {
      if (!chunk) return false

      const chunkNorm = chunk.replace(/\s+/g, ' ').trim().toLowerCase()
      if (chunkNorm.length >= minChars) {
        if (chunkNorm === lastChunk) {
          chunkStreak += 1
          if (chunkStreak >= repeat) return true
        } else {
          lastChunk = chunkNorm
          chunkStreak = 1
        }
      }

      leftover += chunk
      const boundary = /[.!?](?:\s+|\n+|$)/g
      let lastIndex = 0
      let match = boundary.exec(leftover)
      while (match) {
        const end = match.index + match[0].length
        const sentence = leftover.slice(lastIndex, end)
        lastIndex = end
        if (note(sentence)) {
          leftover = leftover.slice(lastIndex)
          return true
        }
        match = boundary.exec(leftover)
      }
      leftover = leftover.slice(lastIndex)
      return false
    },
  }
}

export type OpenAIUsageCounters = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  /** OpenAI reasoning/completion_tokens_details subset; not in BetaUsage. */
  reasoning_tokens?: number
}

/**
 * Merge a delta usage into the accumulated usage, preserving cache-related
 * fields from previous values when the delta carries explicit zeroes or
 * undefined values.
 *
 * Mirrors updateUsage() in claude.ts: a future adapter change that omits
 * cache fields from certain streaming events should not silently zero the
 * accumulated counters.
 */
export function updateOpenAIUsage(
  current: OpenAIUsageCounters,
  delta: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    reasoning_tokens?: number
  },
): OpenAIUsageCounters {
  return {
    input_tokens: delta.input_tokens ?? current.input_tokens,
    output_tokens: delta.output_tokens ?? current.output_tokens,
    cache_creation_input_tokens:
      delta.cache_creation_input_tokens !== undefined &&
      delta.cache_creation_input_tokens > 0
        ? delta.cache_creation_input_tokens
        : current.cache_creation_input_tokens,
    cache_read_input_tokens:
      delta.cache_read_input_tokens !== undefined &&
      delta.cache_read_input_tokens > 0
        ? delta.cache_read_input_tokens
        : current.cache_read_input_tokens,
    reasoning_tokens:
      delta.reasoning_tokens !== undefined && delta.reasoning_tokens > 0
        ? delta.reasoning_tokens
        : current.reasoning_tokens,
  }
}

/**
 * True for user/client cancellation (ESC, AbortSignal, OpenAI/Anthropic abort classes).
 * Callers must not surface these as `API Error:` — match Anthropic path behavior.
 */
export function isOpenAIUserAbortError(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false
  const e = error as { name?: unknown; message?: unknown; code?: unknown }
  if (e.name === 'AbortError' || e.name === 'APIUserAbortError') return true
  // OpenAI SDK / undici sometimes put abort only in message.
  if (typeof e.message === 'string') {
    const m = e.message.toLowerCase()
    if (
      m === 'aborted' ||
      m === 'request was aborted' ||
      m === 'the user aborted a request' ||
      m.includes('operation was aborted')
    ) {
      return true
    }
  }
  // Node undici: code ERR_ABORT / AbortError
  if (e.code === 'ABORT_ERR') return true
  return false
}

/**
 * Format OpenAI SDK / transport errors for the user-facing `API Error:` surface.
 *
 * SDK `APIError.message` already embeds HTTP status for empty bodies
 * (`403 status code (no body)`). We still promote structured `status` / `code`
 * when they are present on the error object but missing from the message, so
 * classification is not lost for non-SDK throws or thin wrappers.
 */
export function formatOpenAIErrorMessage(error: unknown): string {
  if (error == null) return 'Unknown error'
  if (typeof error === 'string') return error

  const err = error as {
    message?: unknown
    status?: unknown
    statusCode?: unknown
    code?: unknown
    error?: { message?: unknown; code?: unknown }
  }

  const nestedMessage =
    typeof err.error?.message === 'string' ? err.error.message : undefined
  // Prefer real strings only — bare `{ status: 403 }` must not become "[object Object]".
  const rawMessage =
    (typeof err.message === 'string' && err.message) ||
    nestedMessage ||
    (error instanceof Error ? error.message : '')
  const message = rawMessage.trim()

  const statusCandidate = err.status ?? err.statusCode
  const status =
    typeof statusCandidate === 'number'
      ? statusCandidate
      : typeof statusCandidate === 'string' && statusCandidate.trim()
        ? statusCandidate.trim()
        : undefined
  const codeRaw = err.code ?? err.error?.code
  const code =
    typeof codeRaw === 'string' || typeof codeRaw === 'number'
      ? String(codeRaw)
      : undefined

  // Match OpenAI SDK empty-body wording when we only have a status.
  let out =
    message ||
    (status != null ? `${status} status code (no body)` : 'Unknown error')
  if (status != null && !out.includes(String(status))) {
    out = `${status} ${out}`
  }
  if (code && !out.includes(code)) {
    out = `${out} (code=${code})`
  }
  return out
}

type OpenAIHttpErrorDetails = {
  message: string | null
  code: string | null
  type: string | null
  param: string | null
  bodyPreview: string | null
}

function boundedHttpDiagnostic(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value).trim()
  if (!text) return null
  return text.length > 500 ? `${text.slice(0, 499)}…` : text
}

function parseOpenAIHttpErrorBody(
  bodyText: string | undefined,
): OpenAIHttpErrorDetails {
  const body = bodyText?.trim()
  const details: OpenAIHttpErrorDetails = {
    message: null,
    code: null,
    type: null,
    param: null,
    bodyPreview: boundedHttpDiagnostic(body),
  }
  if (!body) return details

  try {
    const parsed = JSON.parse(body) as unknown
    if (parsed == null || typeof parsed !== 'object') return details
    const root = parsed as Record<string, unknown>
    const nested =
      root.error != null && typeof root.error === 'object'
        ? (root.error as Record<string, unknown>)
        : undefined
    details.message = boundedHttpDiagnostic(
      nested?.message ?? root.message ?? root.error,
    )
    details.code = boundedHttpDiagnostic(nested?.code ?? root.code)
    details.type = boundedHttpDiagnostic(nested?.type ?? root.type)
    details.param = boundedHttpDiagnostic(nested?.param ?? root.param)
  } catch {
    // Non-JSON provider bodies remain available through the bounded preview.
  }
  return details
}

function formatBoundedHttpDetail(value: string): string {
  return value.length > 500 ? `${value.slice(0, 499)}…` : value
}

/**
 * Format a non-OK HTTP response for Responses/ChatGPT fetch paths.
 * Keeps the same empty-body wording as the OpenAI SDK for greppability.
 */
export function formatHttpStatusError(
  label: string,
  status: number,
  bodyText?: string,
): string {
  const details = parseOpenAIHttpErrorBody(bodyText)
  const detail = details.message ?? details.bodyPreview
  if (!detail) {
    return `${label} failed: ${status} status code (no body)`
  }
  return `${label} failed: ${status}: ${formatBoundedHttpDetail(detail)}`
}

/**
 * Throw a layered provider error for non-OK HTTP responses.
 * Classifies overflow / body-too-large / rate-limit; otherwise ProviderAPIError.
 */
export function throwHttpStatusError(
  label: string,
  status: number,
  bodyText?: string,
  headers?: unknown,
): never {
  const details = parseOpenAIHttpErrorBody(bodyText)
  const message = formatHttpStatusError(label, status, bodyText)
  throw classifyProviderHttpError(status, message, { headers, ...details })
}

/**
 * Stack / cause chain for OpenAI-compatible failures.
 * - Debug logs: more frames + causes (future root-cause hunting).
 * - User `API Error:`: short stack only (readable, not a wall of frames).
 */
export function formatOpenAIErrorStack(error: unknown, maxFrames = 12): string {
  const chunks: string[] = []
  let current: unknown = error
  let depth = 0
  while (current != null && depth < 4) {
    if (current instanceof Error) {
      chunks.push(shortErrorStack(current, maxFrames))
      current = (current as Error & { cause?: unknown }).cause
    } else if (typeof current === 'object') {
      // Non-Error throw (SDK sometimes uses plain objects): synthesize catch-site stack.
      const synthetic = new Error(formatOpenAIErrorMessage(current))
      chunks.push(shortErrorStack(synthetic, maxFrames))
      break
    } else {
      chunks.push(String(current))
      break
    }
    depth++
  }
  if (chunks.length === 0) {
    chunks.push(
      shortErrorStack(new Error(formatOpenAIErrorMessage(error)), maxFrames),
    )
  }
  return chunks.join('\nCaused by:\n')
}

/** Error body with a bounded stack for explicit verbose/debug surfaces. */
export function formatOpenAIErrorWithStack(
  error: unknown,
  maxFrames = 8,
): string {
  const message = formatOpenAIErrorMessage(error)
  const stack = formatOpenAIErrorStack(error, maxFrames)
  // Avoid duplicating the message line when stack already starts with it.
  if (stack.startsWith(message) || stack.includes(`: ${message}`)) {
    return stack
  }
  return `${message}\n${stack}`
}

/**
 * Allowlisted diagnostics for OpenAI-compatible failures (kimi-style).
 * Only stable, non-secret fields — no bodies, cookies, or auth headers.
 */
export type OpenAIErrorDiagnostics = {
  status: number | null
  requestId: string | null
  retryAfterMs: number | null
  /** Cloudflare ray or provider x-trace-id when present. */
  traceId: string | null
  code: string | null
}

function readOpenAIErrorHeader(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const v = (headers as { get(n: string): string | null }).get(name)
    return boundedHttpDiagnostic(v)
  }
  const record = headers as Record<string, unknown>
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(record)) {
    if (k.toLowerCase() === lower) return boundedHttpDiagnostic(v)
  }
  return null
}

function statusFromOpenAIErrorMessage(message: string): number | null {
  const match = message.match(/\b([45]\d\d)\s+status code\b/i)
  if (!match) return null
  const n = Number(match[1])
  return Number.isFinite(n) ? n : null
}

/**
 * Collect kimi-style status / request / backoff / trace diagnostics from an
 * OpenAI SDK error, layered ProviderAPIError, or thin fetch wrapper.
 */
export function collectOpenAIErrorDiagnostics(
  error: unknown,
): OpenAIErrorDiagnostics {
  const message = formatOpenAIErrorMessage(error)
  const status =
    getProviderErrorStatus(error) ?? statusFromOpenAIErrorMessage(message)

  if (error == null || typeof error !== 'object') {
    return {
      status: status ?? null,
      requestId: null,
      retryAfterMs: null,
      traceId: null,
      code: null,
    }
  }

  const err = error as {
    headers?: unknown
    requestID?: unknown
    requestId?: unknown
    retryAfterMs?: unknown
    code?: unknown
    error?: { code?: unknown }
  }

  const requestId =
    boundedHttpDiagnostic(err.requestID ?? err.requestId) ??
    readOpenAIErrorHeader(err.headers, 'x-request-id') ??
    readOpenAIErrorHeader(err.headers, 'request-id')

  const retryAfterMs =
    getProviderRetryAfterMs(error) ??
    parseRetryAfterMs(readOpenAIErrorHeader(err.headers, 'retry-after'))

  const traceId =
    readOpenAIErrorHeader(err.headers, 'cf-ray') ??
    readOpenAIErrorHeader(err.headers, 'x-trace-id')

  const code = boundedHttpDiagnostic(err.code ?? err.error?.code)

  return {
    status: status ?? null,
    requestId,
    retryAfterMs,
    traceId,
    code,
  }
}

/** Compact allowlisted diagnostic string for errorDetails / debug. */
export function formatOpenAIErrorDetails(
  diagnostics: OpenAIErrorDiagnostics,
): string | undefined {
  const parts: string[] = []
  if (diagnostics.status != null) parts.push(`status=${diagnostics.status}`)
  if (diagnostics.requestId) parts.push(`request_id=${diagnostics.requestId}`)
  if (diagnostics.retryAfterMs != null) {
    parts.push(`retry_after_ms=${diagnostics.retryAfterMs}`)
  }
  if (diagnostics.traceId) parts.push(`trace_id=${diagnostics.traceId}`)
  if (diagnostics.code) parts.push(`code=${diagnostics.code}`)
  return parts.length > 0 ? parts.join('; ') : undefined
}

export type OpenAIAssistantAPIErrorFields = {
  /** Full `API Error: …` user content. */
  content: string
  apiError: 'api_error'
  /** SDK classification — 5xx → server_error (kimi normalizeAPIStatusError). */
  error: 'server_error' | 'unknown'
  errorDetails?: string
}

/**
 * Build the assistant API-error message fields for OpenAI/Grok catch paths.
 *
 * Mirrors kimi's convertOpenAIError + normalizeAPIStatusError intent:
 * typed status classification + allowlisted diagnostics. The default user
 * surface is concise; callers may explicitly include a bounded stack in
 * verbose/debug mode. Full stack/cause still goes to debug logs at the catch site.
 */
export function formatOpenAIAssistantAPIError(
  error: unknown,
  includeStack = false,
  maxStackFrames = 8,
): OpenAIAssistantAPIErrorFields {
  const message = formatOpenAIErrorMessage(error)
  const diagnostics = collectOpenAIErrorDiagnostics(error)
  const errorDetails = formatOpenAIErrorDetails(diagnostics)
  const status = diagnostics.status
  const isServerError = status != null && status >= 500

  return {
    content: `API Error: ${includeStack ? formatOpenAIErrorWithStack(error, maxStackFrames) : message}`,
    apiError: 'api_error',
    error: isServerError ? 'server_error' : 'unknown',
    ...(isServerError
      ? { errorDetails: errorDetails ?? message }
      : errorDetails
        ? { errorDetails }
        : {}),
  }
}

/**
 * Lift an OpenAI SDK / fetch error into a layered provider error when the
 * status is known (overflow / too-large / rate-limit). Returns null when the
 * error has no usable HTTP status.
 */
export function toProviderHttpError(error: unknown): ProviderAPIError | null {
  if (error == null || typeof error !== 'object') return null
  const err = error as {
    status?: unknown
    statusCode?: unknown
    message?: unknown
    headers?: unknown
    requestID?: unknown
    requestId?: unknown
    code?: unknown
    type?: unknown
    param?: unknown
    error?: unknown
  }
  const statusCandidate = err.status ?? err.statusCode
  const status =
    typeof statusCandidate === 'number'
      ? statusCandidate
      : typeof statusCandidate === 'string' && /^\d+$/.test(statusCandidate)
        ? Number(statusCandidate)
        : undefined
  if (status === undefined) return null
  const nested =
    err.error != null && typeof err.error === 'object'
      ? (err.error as Record<string, unknown>)
      : undefined
  let bodyPreview: string | null = null
  if (nested) {
    try {
      bodyPreview = boundedHttpDiagnostic(JSON.stringify(nested))
    } catch {
      // An unusual cyclic SDK error still retains scalar diagnostics below.
    }
  }
  const message = formatOpenAIErrorMessage(error)
  return classifyProviderHttpError(status, message, {
    headers: err.headers,
    requestId: boundedHttpDiagnostic(err.requestID ?? err.requestId),
    code: boundedHttpDiagnostic(err.code ?? nested?.code),
    type: boundedHttpDiagnostic(err.type ?? nested?.type),
    param: boundedHttpDiagnostic(err.param ?? nested?.param),
    bodyPreview,
  })
}

const TRANSIENT_RETRY_BASE_DELAY_MS = 500
const TRANSIENT_RETRY_MAX_DELAY_MS = 30_000
/** Empty-body gateway 5xx fallback backoff stays short without server guidance. */
const EMPTY_BODY_5XX_MAX_DELAY_MS = 2_000
/** Non-empty 5xx fallback backoff stays below the global explicit-delay ceiling. */
const SERVER_ERROR_MAX_DELAY_MS = 8_000
const DEFAULT_TRANSIENT_MAX_RETRIES = 5
const DEFAULT_OPENAI_REQUEST_MAX_RETRIES = 4
const DEFAULT_OPENAI_STREAM_MAX_RETRIES = 5
const DEFAULT_OPENAI_STREAM_IDLE_TIMEOUT_MS = 300_000
const DEFAULT_OPENAI_STREAM_STALL_TIMEOUT_MS = 120_000

function parseBoundedRetryCount(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(100, Math.max(0, parsed))
}

export function getOpenAIRequestMaxRetries(): number {
  const configured = process.env.OPENAI_REQUEST_MAX_RETRIES
  if (configured !== undefined && configured.trim() !== '') {
    return parseBoundedRetryCount(
      configured,
      DEFAULT_OPENAI_REQUEST_MAX_RETRIES,
    )
  }
  return parseBoundedRetryCount(
    process.env.CLAUDE_CODE_MAX_RETRIES,
    DEFAULT_OPENAI_REQUEST_MAX_RETRIES,
  )
}

export function getOpenAIStreamMaxRetries(): number {
  const configured = process.env.OPENAI_STREAM_MAX_RETRIES
  if (configured !== undefined && configured.trim() !== '') {
    return parseBoundedRetryCount(configured, DEFAULT_OPENAI_STREAM_MAX_RETRIES)
  }
  return parseBoundedRetryCount(
    process.env.CLAUDE_CODE_MAX_RETRIES,
    DEFAULT_OPENAI_STREAM_MAX_RETRIES,
  )
}

export function getOpenAIStreamIdleTimeoutMs(): number {
  const parsed = Number.parseInt(
    process.env.OPENAI_STREAM_IDLE_TIMEOUT_MS || '',
    10,
  )
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_OPENAI_STREAM_IDLE_TIMEOUT_MS
}

/**
 * Gap allowed *between* chunks once the stream has started producing them. The
 * idle budget above is sized for time-to-first-chunk (queueing plus a long
 * reasoning phase before any output); after the first chunk a provider that
 * goes quiet has already dropped the stream. Measured over 913 completed
 * streams in the raw logs, the largest inter-chunk gap ever observed was 56s,
 * so 120s is a wide margin — tune with OPENAI_STREAM_STALL_TIMEOUT_MS if a
 * provider legitimately pauses longer mid-stream.
 */
export function getOpenAIStreamStallTimeoutMs(): number {
  const parsed = Number.parseInt(
    process.env.OPENAI_STREAM_STALL_TIMEOUT_MS || '',
    10,
  )
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_OPENAI_STREAM_STALL_TIMEOUT_MS
}

/**
 * A failure that can safely be retried before semantic output escapes. This
 * deliberately includes 429: provider-directed Retry-After is honored below.
 */
export function isTransientOpenAIError(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false
  if (isOpenAIUserAbortError(error)) return false
  if (error instanceof ProviderStreamError) return error.retryable

  const status = getProviderErrorStatus(error)
  if (status !== undefined) {
    return status === 408 || status === 409 || status === 429 || status >= 500
  }
  // OpenAI SDK connection failures (incl. timeouts) carry no HTTP status.
  return error instanceof OpenAIAPIConnectionError
}

/** Retry count for transient errors; honors CLAUDE_CODE_MAX_RETRIES. */
export function getTransientOpenAIMaxRetries(): number {
  const fromEnv = parseInt(process.env.CLAUDE_CODE_MAX_RETRIES || '', 10)
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv
  return DEFAULT_TRANSIENT_MAX_RETRIES
}

function isEmptyBodyHttpStatusError(error: unknown): boolean {
  return /\b[45]\d\d\s+status code\s*\(no body\)/i.test(
    formatOpenAIErrorMessage(error),
  )
}

/**
 * Cap for exponential fallback when the provider supplied no retry delay.
 * Explicit provider/header delays use the shared 30-second ceiling instead.
 */
function getOpenAIFallbackRetryMaxDelayMs(error: unknown): number {
  const message = formatOpenAIErrorMessage(error)
  const status =
    getProviderErrorStatus(error) ?? statusFromOpenAIErrorMessage(message)
  if (status != null && status >= 500) {
    return isEmptyBodyHttpStatusError(error)
      ? EMPTY_BODY_5XX_MAX_DELAY_MS
      : SERVER_ERROR_MAX_DELAY_MS
  }
  return TRANSIENT_RETRY_MAX_DELAY_MS
}

export function getOpenAIRetryDelayMs(
  error: unknown,
  attempt: number,
  responseRetryAfterMs?: number | null,
): number {
  const fromProvider = getProviderRetryAfterMs(error)
  if (fromProvider !== null) {
    return Math.min(fromProvider, TRANSIENT_RETRY_MAX_DELAY_MS)
  }
  const headers = (
    error as { headers?: { get?: (n: string) => string | null } }
  )?.headers
  const fromHeader = parseRetryAfterMs(
    typeof headers?.get === 'function' ? headers.get('retry-after') : null,
  )
  if (fromHeader !== null) {
    return Math.min(fromHeader, TRANSIENT_RETRY_MAX_DELAY_MS)
  }
  if (responseRetryAfterMs != null && responseRetryAfterMs >= 0) {
    return Math.min(responseRetryAfterMs, TRANSIENT_RETRY_MAX_DELAY_MS)
  }
  const fallbackMaxDelay = getOpenAIFallbackRetryMaxDelayMs(error)
  return Math.min(
    TRANSIENT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
    fallbackMaxDelay,
  )
}

/**
 * Error payload for mid-retry SystemAPIErrorMessage UI. The default message is
 * concise; verbose/debug callers may include a bounded stack. The original
 * error remains as `cause` for debug logs. Status/headers are copied so a future
 * misuse of the wrapped error still classifies as transient.
 */
export function asOpenAIRetryError(
  error: unknown,
  includeStack = false,
  maxStackFrames = 8,
): Error {
  const message = includeStack
    ? formatOpenAIErrorWithStack(error, maxStackFrames)
    : formatOpenAIErrorMessage(error)
  const wrapped =
    error instanceof Error
      ? Object.assign(new Error(message, { cause: error }), {
          name: error.name,
        })
      : new Error(message)
  if (error != null && typeof error === 'object') {
    const src = error as {
      status?: unknown
      statusCode?: unknown
      headers?: unknown
      requestID?: unknown
      requestId?: unknown
    }
    const dest = wrapped as Error & {
      status?: unknown
      statusCode?: unknown
      headers?: unknown
      requestID?: unknown
      requestId?: unknown
    }
    if (src.status !== undefined) dest.status = src.status
    if (src.statusCode !== undefined) dest.statusCode = src.statusCode
    if (src.headers !== undefined) dest.headers = src.headers
    if (src.requestID !== undefined) dest.requestID = src.requestID
    if (src.requestId !== undefined) dest.requestId = src.requestId
  }
  return wrapped
}

export type TransientRetryInfo = {
  attempt: number
  maxRetries: number
  delayMs: number
  error: unknown
}

export async function* withOpenAIStreamIdleTimeout<T>(
  stream: AsyncIterable<T>,
  opts: {
    timeoutMs?: number
    stallTimeoutMs?: number
    abortAttempt: () => void
    userSignal: AbortSignal
    requestId?: string | null
  },
): AsyncGenerator<T, void> {
  const iterator = stream[Symbol.asyncIterator]()
  const timeoutMs = opts.timeoutMs ?? getOpenAIStreamIdleTimeoutMs()
  // Never wait longer between chunks than for the first one.
  const stallTimeoutMs = Math.min(
    opts.stallTimeoutMs ?? getOpenAIStreamStallTimeoutMs(),
    timeoutMs,
  )
  let failed = false
  let chunks = 0

  try {
    for (;;) {
      const waitMs = chunks === 0 ? timeoutMs : stallTimeoutMs
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const timeout = new Promise<IteratorResult<T>>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new ProviderStreamError(
                `OpenAI stream idle timeout after ${waitMs}ms`,
                {
                  kind: 'idle_timeout',
                  retryable: true,
                  terminal: false,
                  requestId: opts.requestId,
                },
              ),
            )
            opts.abortAttempt()
          }, waitMs)
          timer.unref?.()
        })
        const result = await Promise.race([iterator.next(), timeout])
        if (result.done) return
        chunks++
        yield result.value
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
  } catch (error) {
    failed = true
    if (
      opts.userSignal.aborted ||
      isOpenAIUserAbortError(error) ||
      error instanceof ProviderStreamError
    ) {
      throw error
    }
    throw new ProviderStreamError(formatOpenAIErrorMessage(error), {
      kind: 'provider',
      retryable: true,
      terminal: false,
      requestId: opts.requestId,
      cause: error,
    })
  } finally {
    const returned = iterator.return?.()
    if (failed) void returned?.catch(() => {})
    else await returned?.catch(() => {})
  }
}

/**
 * Retry transient request-establishment failures with exponential backoff
 * (or the server's Retry-After when present).
 *
 * Only wrap stream *creation* with this — never stream consumption — so a
 * retry can never duplicate already-yielded events. Non-transient errors,
 * user aborts, and exhausted retries rethrow to the caller's normal error
 * surface (`API Error: …`).
 *
 * The OpenAI-compatible paths bypass withRetry.ts (its shouldRetry() only
 * understands Anthropic SDK APIError instances), so without this a single
 * 503 from the provider fails the whole turn.
 */
export async function withTransientOpenAIRetry<T>(
  make: () => Promise<T>,
  opts: {
    signal: AbortSignal
    maxRetries?: number
    onRetry?: (info: TransientRetryInfo) => void
  },
): Promise<T> {
  const maxRetries = opts.maxRetries ?? getTransientOpenAIMaxRetries()
  let attempt = 0
  for (;;) {
    try {
      return await make()
    } catch (error) {
      if (
        opts.signal.aborted ||
        isOpenAIUserAbortError(error) ||
        !isTransientOpenAIError(error) ||
        attempt >= maxRetries
      ) {
        throw error
      }
      attempt++
      const delayMs = getOpenAIRetryDelayMs(error, attempt)
      opts.onRetry?.({ attempt, maxRetries, delayMs, error })
      await sleep(delayMs, opts.signal, { throwOnAbort: true })
    }
  }
}
