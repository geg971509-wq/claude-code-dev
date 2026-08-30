import {
  APIContextOverflowError,
  APIProviderRateLimitError,
  ProviderStreamError,
} from '@ant/model-provider'

type UnknownRecord = Record<string, unknown>

export type CodexResponsesErrorDetails = {
  message: string
  rawMessage: string
  code: string | null
  type: string | null
  param: string | null
  requestId: string | null
  completionState: string | null
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object'
    ? (value as UnknownRecord)
    : undefined
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null
}

/**
 * Read the provider error embedded in a Responses SSE event.
 *
 * Responses can place fields at the event root, in `error`, or in
 * `response.error`. Keep the precedence explicit so compatible gateways do
 * not lose useful diagnostics when they use a slightly different envelope.
 */
export function getCodexResponsesErrorDetails(
  eventValue: unknown,
  fallback: string,
): CodexResponsesErrorDetails {
  const event = asRecord(eventValue) ?? {}
  const response = asRecord(event.response)
  const topError = asRecord(event.error)
  const responseError = asRecord(response?.error)

  const rawMessage =
    nonEmptyString(event.message) ??
    nonEmptyString(topError?.message) ??
    nonEmptyString(responseError?.message) ??
    fallback
  const code =
    nonEmptyString(event.code) ??
    nonEmptyString(topError?.code) ??
    nonEmptyString(responseError?.code)
  const type =
    nonEmptyString(topError?.type) ?? nonEmptyString(responseError?.type)
  const param =
    nonEmptyString(topError?.param) ?? nonEmptyString(responseError?.param)
  const requestId =
    nonEmptyString(event.request_id) ?? nonEmptyString(response?.id)
  const completionState = nonEmptyString(response?.status) ?? 'failed'

  return {
    message: code ? `${code}: ${rawMessage}` : rawMessage,
    rawMessage,
    code,
    type,
    param,
    requestId,
    completionState,
  }
}

/** Match Codex's stream-error retry hint parser, including fractional values. */
export function parseCodexResponsesRetryAfterMs(
  message: string,
): number | null {
  const match = message.match(
    /try again in\s*(\d+(?:\.\d+)?)\s*(ms|seconds?|s)\b/i,
  )
  if (!match) return null

  const value = Number(match[1])
  if (!Number.isFinite(value) || value < 0) return null

  const unit = match[2]?.toLowerCase()
  if (unit === 'ms') return Math.round(value)
  if (unit === 's' || unit?.startsWith('second')) {
    return Math.round(value * 1000)
  }
  return null
}

function streamError(
  details: CodexResponsesErrorDetails,
  options: {
    retryable: boolean
    status?: number
    retryAfterMs?: number | null
  },
): ProviderStreamError {
  return new ProviderStreamError(details.message, {
    kind: 'provider',
    retryable: options.retryable,
    terminal: true,
    completionState: details.completionState,
    requestId: details.requestId,
    code: details.code,
    type: details.type,
    param: details.param,
    retryAfterMs: options.retryAfterMs,
    status: options.status,
  })
}

/**
 * Convert `response.failed` and top-level Responses `error` events using the
 * same decision table as Codex's SSE bridge.
 */
export function createCodexResponsesStreamError(
  event: unknown,
  fallback = 'Codex Responses stream failed',
): Error {
  const details = getCodexResponsesErrorDetails(event, fallback)
  const code = details.code?.toLowerCase() ?? null

  switch (code) {
    case 'context_length_exceeded':
      return new APIContextOverflowError(
        400,
        details.message,
        details.requestId,
        null,
        {
          code: details.code,
          type: details.type,
          param: details.param,
        },
      )

    case 'rate_limit_exceeded': {
      const retryAfterMs = parseCodexResponsesRetryAfterMs(details.rawMessage)
      return new APIProviderRateLimitError(
        details.message,
        details.requestId,
        retryAfterMs,
        {
          code: details.code,
          type: details.type,
          param: details.param,
        },
      )
    }

    case 'server_is_overloaded':
    case 'slow_down':
      // Codex surfaces these as ServerOverloaded and intentionally does not
      // retry the same model automatically; the caller can select another.
      return streamError(details, { retryable: false, status: 503 })

    case 'insufficient_quota':
      return streamError(details, { retryable: false, status: 429 })

    case 'usage_not_included':
      return streamError(details, { retryable: false, status: 403 })

    case 'cyber_policy':
    case 'misalignment_policy_violation':
    case 'invalid_prompt':
    case 'bio_policy':
      return streamError(details, { retryable: false, status: 400 })

    default:
      // Codex treats an otherwise unclassified response.failed payload as a
      // retryable stream failure. Preserve any server-directed delay even on
      // compatible gateways that omit the canonical rate-limit code.
      return streamError(details, {
        retryable: true,
        retryAfterMs: parseCodexResponsesRetryAfterMs(details.rawMessage),
      })
  }
}

/** `response.incomplete` is an error terminal in Codex, not a completed turn. */
export function createCodexIncompleteStreamError(
  eventValue: unknown,
): ProviderStreamError {
  const event = asRecord(eventValue) ?? {}
  const response = asRecord(event.response)
  const status = nonEmptyString(response?.status)

  if (status !== null && status !== 'incomplete') {
    return new ProviderStreamError(
      'Codex Responses response.incomplete event had an invalid response status',
      {
        kind: 'protocol',
        retryable: false,
        terminal: false,
        completionState: status,
        requestId: nonEmptyString(response?.id),
      },
    )
  }

  const incompleteDetails = asRecord(response?.incomplete_details)
  const reason = nonEmptyString(incompleteDetails?.reason) ?? 'unknown'
  return new ProviderStreamError(
    `Incomplete response returned, reason: ${reason}`,
    {
      kind: 'incomplete',
      retryable: true,
      terminal: true,
      completionState: 'incomplete',
      requestId: nonEmptyString(response?.id),
      incompleteReason: reason,
    },
  )
}
