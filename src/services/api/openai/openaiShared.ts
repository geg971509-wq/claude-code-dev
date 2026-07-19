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
  getProviderRetryAfterMs,
  parseRetryAfterMs,
  type ProviderAPIError,
} from '@ant/model-provider'
import { APIConnectionError as OpenAIAPIConnectionError } from 'openai'
import { shortErrorStack } from '../../../utils/errors.js'
import { sleep } from '../../../utils/sleep.js'

export { assertValidToolArgumentsJson } from '@ant/model-provider'

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

/**
 * Format a non-OK HTTP response for Responses/ChatGPT fetch paths.
 * Keeps the same empty-body wording as the OpenAI SDK for greppability.
 */
export function formatHttpStatusError(
  label: string,
  status: number,
  bodyText?: string,
): string {
  const body = bodyText?.trim()
  if (!body) {
    return `${label} failed: ${status} status code (no body)`
  }
  const clipped = body.length > 500 ? `${body.slice(0, 500)}…` : body
  return `${label} failed: ${status}: ${clipped}`
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
  const message = formatHttpStatusError(label, status, bodyText)
  throw classifyProviderHttpError(status, message, { headers })
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

/** User-visible error body: message + short stack (for REPL / transcripts). */
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
    error?: { message?: unknown }
  }
  const statusCandidate = err.status ?? err.statusCode
  const status =
    typeof statusCandidate === 'number'
      ? statusCandidate
      : typeof statusCandidate === 'string' && /^\d+$/.test(statusCandidate)
        ? Number(statusCandidate)
        : undefined
  if (status === undefined) return null
  const message = formatOpenAIErrorMessage(error)
  return classifyProviderHttpError(status, message, {
    headers: err.headers,
  })
}

const TRANSIENT_RETRY_BASE_DELAY_MS = 500
const TRANSIENT_RETRY_MAX_DELAY_MS = 30_000
const DEFAULT_TRANSIENT_MAX_RETRIES = 5

/**
 * Transient request-establishment failure: HTTP 408/409/5xx (e.g.
 * `503 Service temporarily unavailable`) or an SDK connection error
 * (reset / timeout, no HTTP status). These are safe to retry before any
 * stream events have been emitted.
 *
 * 429 is deliberately excluded — it flows through the layered
 * APIProviderRateLimitError handling in the caller's catch block.
 */
export function isTransientOpenAIError(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false
  if (isOpenAIUserAbortError(error)) return false
  const err = error as { status?: unknown; statusCode?: unknown }
  const statusCandidate = err.status ?? err.statusCode
  const status =
    typeof statusCandidate === 'number'
      ? statusCandidate
      : typeof statusCandidate === 'string' && /^\d+$/.test(statusCandidate)
        ? Number(statusCandidate)
        : undefined
  if (status !== undefined) {
    return status === 408 || status === 409 || status >= 500
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

function transientRetryDelayMs(error: unknown, attempt: number): number {
  // Server-directed delay first: layered ProviderAPIError.retryAfterMs,
  // then a raw Retry-After header on SDK errors.
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
  return Math.min(
    TRANSIENT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
    TRANSIENT_RETRY_MAX_DELAY_MS,
  )
}

export type TransientRetryInfo = {
  attempt: number
  maxRetries: number
  delayMs: number
  error: unknown
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
      const delayMs = transientRetryDelayMs(error, attempt)
      opts.onRetry?.({ attempt, maxRetries, delayMs, error })
      await sleep(delayMs, opts.signal, { throwOnAbort: true })
    }
  }
}
