/**
 * Stable wire error codes for RCS / ACP surfaces.
 *
 * Shape: `domain.reason` (string). Renaming/removing a code is a breaking
 * change for remote clients; adding is non-breaking.
 *
 * Integer JSON-RPC codes stay in ACP/JSON-RPC layers; this table is the
 * application-level code carried in `error.type` / `error.data.code`.
 */

export const WireErrorCode = {
  // Generic
  INTERNAL: 'internal',
  VALIDATION_FAILED: 'validation.failed',
  REQUEST_MALFORMED: 'request.malformed',

  // Auth
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  AUTH_TOKEN_MISSING: 'auth.token_missing',
  AUTH_TOKEN_INVALID: 'auth.token_invalid',

  // Session / resource
  NOT_FOUND: 'not_found',
  SESSION_NOT_FOUND: 'session.not_found',
  SESSION_BUSY: 'session.busy',
  SESSION_CLOSED: 'session_closed',
  SESSION_FORBIDDEN: 'session.forbidden',

  // Channel / ACP proxy
  CHANNEL_NOT_FOUND: 'channel.not_found',
  AGENT_NOT_CONNECTED: 'agent.not_connected',
  PROXY_DISCONNECTED: 'proxy.disconnected',

  // Provider (aligned with layered provider errors)
  PROVIDER_API_ERROR: 'provider.api_error',
  PROVIDER_RATE_LIMIT: 'provider.rate_limit',
  PROVIDER_CONTEXT_OVERFLOW: 'provider.context_overflow',
  PROVIDER_REQUEST_TOO_LARGE: 'provider.request_too_large',
  PROVIDER_AUTH_ERROR: 'provider.auth_error',
  PROVIDER_CONNECTION_ERROR: 'provider.connection_error',

  // Goal (surface codes for remote goal control if exposed)
  GOAL_ALREADY_EXISTS: 'goal.already_exists',
  GOAL_NOT_FOUND: 'goal.not_found',
  GOAL_STATUS_INVALID: 'goal.status_invalid',
  GOAL_NOT_RESUMABLE: 'goal.not_resumable',
  GOAL_OBJECTIVE_EMPTY: 'goal.objective_empty',
  GOAL_OBJECTIVE_TOO_LONG: 'goal.objective_too_long',
} as const

export type WireErrorCode = (typeof WireErrorCode)[keyof typeof WireErrorCode]

const CODE_SET: ReadonlySet<string> = new Set(Object.values(WireErrorCode))

export function isWireErrorCode(value: unknown): value is WireErrorCode {
  return typeof value === 'string' && CODE_SET.has(value)
}

/**
 * Best-effort map from legacy RCS `error.type` strings already on the wire
 * into the stable table (identity for known codes).
 */
export function normalizeLegacyErrorType(type: string): WireErrorCode | string {
  if (isWireErrorCode(type)) return type
  switch (type) {
    case 'unauthorized':
      return WireErrorCode.UNAUTHORIZED
    case 'forbidden':
      return WireErrorCode.FORBIDDEN
    case 'not_found':
      return WireErrorCode.NOT_FOUND
    case 'session_closed':
      return WireErrorCode.SESSION_CLOSED
    default:
      return type
  }
}
