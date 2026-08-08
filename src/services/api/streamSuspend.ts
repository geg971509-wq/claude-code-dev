/**
 * Official-aligned stream hang classification for diagnostics only.
 * Does not change retry / non-streaming fallback policy by itself.
 */
import { extractConnectionErrorDetails } from './errorUtils.js'

export type StreamSuspendKind =
  | 'stream_suspended'
  | 'stale_connection'
  | 'context_hint_sse'
  | 'watchdog'
  | 'other'

export type StreamSuspendInput = {
  streamIdleAborted?: boolean
  isStaleConnection?: boolean
  isContextHintSse?: boolean
  /** Optional connection error code (e.g. StreamSuspended). */
  connCode?: string | null
}

/** Official Kie subset used for stale_connection diagnostics. */
const STALE_CONN_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ConnectionClosed',
  'ETIMEDOUT',
  'ECONNABORTED',
  'ERR_SOCKET_CLOSED',
  'StreamSuspended',
])

export function classifyStreamSuspend(
  input: StreamSuspendInput,
): StreamSuspendKind {
  if (input.connCode === 'StreamSuspended') {
    return 'stream_suspended'
  }
  if (input.isStaleConnection) {
    return 'stale_connection'
  }
  if (input.isContextHintSse) {
    return 'context_hint_sse'
  }
  if (input.streamIdleAborted) {
    return 'watchdog'
  }
  return 'other'
}

/**
 * Derive classify inputs from an error + idle flag.
 * context_hint_sse needs server-side SSE classify not present locally —
 * left false unless caller already set it on the input path.
 */
export function classifyStreamSuspendFromError(
  err: unknown,
  streamIdleAborted = false,
): StreamSuspendKind {
  const details = extractConnectionErrorDetails(err)
  const connCode = details?.code ?? null
  const name =
    err instanceof Error
      ? err.name
      : typeof err === 'object' &&
          err !== null &&
          'name' in err &&
          typeof (err as { name: unknown }).name === 'string'
        ? (err as { name: string }).name
        : null
  const effectiveCode =
    connCode ??
    (name === 'StreamSuspendedError' || name === 'StreamSuspended'
      ? 'StreamSuspended'
      : null)

  return classifyStreamSuspend({
    streamIdleAborted,
    connCode: effectiveCode,
    isStaleConnection:
      effectiveCode !== null && STALE_CONN_CODES.has(effectiveCode),
    // Local tree has no classifyStreamError/context-hint SSE path yet.
    isContextHintSse: false,
  })
}
