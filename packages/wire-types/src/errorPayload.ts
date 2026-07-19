import {
  type WireErrorCode,
  WireErrorCode as Codes,
  normalizeLegacyErrorType,
} from './errorCodes.js'

/**
 * Application-level error body used by RCS REST and ACP proxy envelopes.
 * JSON-RPC surfaces embed this under `error.data` (or flatten `type`/`message`).
 */
export type WireErrorBody = {
  type: WireErrorCode | string
  message: string
  /** Optional machine details (token gap, retry-after, etc.). */
  details?: string
  /** Server-directed backoff in ms when known. */
  retryAfterMs?: number
}

export type WireErrorResponse = {
  error: WireErrorBody
}

export function wireError(
  type: WireErrorCode | string,
  message: string,
  extra?: { details?: string; retryAfterMs?: number },
): WireErrorResponse {
  const body: WireErrorBody = {
    type: normalizeLegacyErrorType(type),
    message,
  }
  if (extra?.details !== undefined) body.details = extra.details
  if (extra?.retryAfterMs !== undefined) body.retryAfterMs = extra.retryAfterMs
  return { error: body }
}

export function isWireErrorResponse(
  value: unknown,
): value is WireErrorResponse {
  if (!value || typeof value !== 'object') return false
  const err = (value as { error?: unknown }).error
  if (!err || typeof err !== 'object') return false
  const e = err as { type?: unknown; message?: unknown }
  return typeof e.type === 'string' && typeof e.message === 'string'
}

/**
 * Map layered provider error class names / known markers into wire codes.
 * Call sites pass `error.name` or a classification string.
 */
export function wireCodeFromProviderErrorName(
  name: string | undefined,
): WireErrorCode {
  switch (name) {
    case 'APIContextOverflowError':
      return Codes.PROVIDER_CONTEXT_OVERFLOW
    case 'APIRequestTooLargeError':
      return Codes.PROVIDER_REQUEST_TOO_LARGE
    case 'APIProviderRateLimitError':
      return Codes.PROVIDER_RATE_LIMIT
    case 'APIConnectionError':
      return Codes.PROVIDER_CONNECTION_ERROR
    default:
      return Codes.PROVIDER_API_ERROR
  }
}

/** JSON-RPC `error.data` helper for ACP-link. */
export function toJsonRpcErrorData(body: WireErrorBody): {
  code: string
  message: string
  details?: string
  retryAfterMs?: number
} {
  return {
    code: body.type,
    message: body.message,
    ...(body.details !== undefined ? { details: body.details } : {}),
    ...(body.retryAfterMs !== undefined
      ? { retryAfterMs: body.retryAfterMs }
      : {}),
  }
}
