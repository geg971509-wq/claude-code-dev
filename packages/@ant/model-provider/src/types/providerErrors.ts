/**
 * Layered provider HTTP errors.
 *
 * Distinguishes token-context overflow (recoverable via compaction) from
 * request-body size rejections (need media shrink/drop), and surfaces
 * provider rate limits with optional `retryAfterMs`.
 */

export class ProviderAPIError extends Error {
  readonly statusCode: number
  readonly requestId: string | null
  /** Server `Retry-After` directive in milliseconds, when present. */
  readonly retryAfterMs: number | null

  constructor(
    statusCode: number,
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
  ) {
    super(message)
    this.name = 'ProviderAPIError'
    this.statusCode = statusCode
    this.requestId = requestId ?? null
    this.retryAfterMs = retryAfterMs ?? null
  }
}

/** Request exceeded the model context window (token overflow). */
export class APIContextOverflowError extends ProviderAPIError {
  constructor(
    statusCode: number,
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
  ) {
    super(statusCode, message, requestId, retryAfterMs)
    this.name = 'APIContextOverflowError'
  }
}

/**
 * Serialized request body exceeded the provider byte ceiling (e.g. 413 with
 * entity-too-large wording). Distinct from token overflow.
 */
export class APIRequestTooLargeError extends ProviderAPIError {
  constructor(
    statusCode: number,
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
  ) {
    super(statusCode, message, requestId, retryAfterMs)
    this.name = 'APIRequestTooLargeError'
  }
}

/** Provider rate-limited the request (HTTP 429). */
export class APIProviderRateLimitError extends ProviderAPIError {
  constructor(
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
  ) {
    super(429, message, requestId, retryAfterMs)
    this.name = 'APIProviderRateLimitError'
  }
}

const CONTEXT_OVERFLOW_MESSAGE_PATTERNS = [
  /context[ _-]?length/,
  /(?:context[ _-]?window.*exceed|exceed.*context[ _-]?window)/,
  /maximum context/,
  /exceed(?:ed|s|ing)?\s+(?:the\s+)?max(?:imum)?\s+tokens?/,
  /(?:too many tokens.*(?:prompt|input|context)|(?:prompt|input|context).*too many tokens)/,
  /prompt is too long/,
  /input token count.*exceeds?.*maximum number of tokens/,
  /request.*exceed(?:ed|s|ing)?.*model token limit/,
] as const

const REQUEST_TOO_LARGE_MESSAGE_PATTERNS = [
  /request exceeds the maximum size/,
  /request entity too large/,
  /request_too_large/,
  /exceeds? the maximum allowed number of bytes/,
  /payload too large/,
  /content too large/,
  /request (?:body )?too large/,
] as const

export function isContextOverflowMessage(message: string): boolean {
  const lower = message.toLowerCase()
  return CONTEXT_OVERFLOW_MESSAGE_PATTERNS.some(p => p.test(lower))
}

export function isRequestTooLargeMessage(message: string): boolean {
  const lower = message.toLowerCase()
  return REQUEST_TOO_LARGE_MESSAGE_PATTERNS.some(p => p.test(lower))
}

export function isContextOverflowStatusError(
  statusCode: number,
  message: string,
): boolean {
  // Token overflow can arrive as 400 (Anthropic/OpenAI) or 413 (Vertex).
  if (statusCode !== 400 && statusCode !== 413) return false
  return isContextOverflowMessage(message)
}

export function isRequestTooLargeStatusError(
  statusCode: number,
  message: string,
): boolean {
  if (statusCode !== 413) return false
  // Prefer overflow when the 413 message is prompt-too-long (Vertex).
  if (isContextOverflowMessage(message)) return false
  return isRequestTooLargeMessage(message) || message.trim().length === 0
}

/**
 * Parse `Retry-After` header (seconds or HTTP-date) into milliseconds.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
): number | null {
  if (!value) return null
  const seconds = Number.parseInt(value, 10)
  if (!Number.isNaN(seconds) && String(seconds) === value.trim()) {
    return seconds * 1000
  }
  const dateMs = Date.parse(value)
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now()
    return delta > 0 ? delta : null
  }
  return null
}

function readHeader(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const v = (headers as { get(n: string): string | null }).get(name)
    return v ?? null
  }
  const record = headers as Record<string, unknown>
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(record)) {
    if (k.toLowerCase() === lower && typeof v === 'string') return v
  }
  return null
}

/**
 * Classify an HTTP status + message into a layered provider error.
 * Use for non-Anthropic providers and gateway responses.
 */
export function classifyProviderHttpError(
  statusCode: number,
  message: string,
  options?: {
    requestId?: string | null
    retryAfterMs?: number | null
    headers?: unknown
  },
): ProviderAPIError {
  const retryAfterMs =
    options?.retryAfterMs ??
    parseRetryAfterMs(readHeader(options?.headers, 'retry-after'))
  const requestId =
    options?.requestId ??
    readHeader(options?.headers, 'x-request-id') ??
    readHeader(options?.headers, 'request-id')

  if (statusCode === 429) {
    return new APIProviderRateLimitError(message, requestId, retryAfterMs)
  }
  // Context overflow first: Vertex returns prompt-too-long as 413.
  if (isContextOverflowStatusError(statusCode, message)) {
    return new APIContextOverflowError(
      statusCode,
      message,
      requestId,
      retryAfterMs,
    )
  }
  if (isRequestTooLargeStatusError(statusCode, message)) {
    return new APIRequestTooLargeError(
      statusCode,
      message,
      requestId,
      retryAfterMs,
    )
  }
  return new ProviderAPIError(statusCode, message, requestId, retryAfterMs)
}

/** True when the error carries a server-directed retry delay. */
export function getProviderRetryAfterMs(error: unknown): number | null {
  if (
    error &&
    typeof error === 'object' &&
    'retryAfterMs' in error &&
    typeof (error as { retryAfterMs: unknown }).retryAfterMs === 'number'
  ) {
    const n = (error as { retryAfterMs: number }).retryAfterMs
    return Number.isFinite(n) && n > 0 ? n : null
  }
  return null
}

export function isProviderContextOverflowError(error: unknown): boolean {
  return error instanceof APIContextOverflowError
}

export function isProviderRequestTooLargeError(error: unknown): boolean {
  return error instanceof APIRequestTooLargeError
}

export function isProviderRateLimitError(error: unknown): boolean {
  return error instanceof APIProviderRateLimitError
}
