import type { WSContext } from 'hono/ws'
import {
  WireErrorCode,
  toJsonRpcErrorData,
  type WireErrorBody,
} from '@claude-code-best/wire-types'
import { jsonRpcContextStorage } from './jsonrpc-context.js'
import { clients, getRcsUpstream } from './runtime-state.js'
import {
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_PARSE_ERROR,
  type ClientState,
} from './types.js'

/** Map reserved JSON-RPC numeric codes → stable wire `error.data.code`. */
export function wireTypeFromJsonRpcCode(code: number): string {
  switch (code) {
    case JSONRPC_INVALID_PARAMS:
      return WireErrorCode.VALIDATION_FAILED
    case JSONRPC_PARSE_ERROR:
    case JSONRPC_INVALID_REQUEST:
    case JSONRPC_METHOD_NOT_FOUND:
      return WireErrorCode.REQUEST_MALFORMED
    default:
      return WireErrorCode.INTERNAL
  }
}

// Maps legacy notification type strings to their JSON-RPC method names so
// agent→client notifications are also emitted as JSON-RPC notifications for
// JSON-RPC 2.0 clients (audit §8.1). Notifications have no id.
export const LEGACY_NOTIFICATION_TO_JSONRPC: Record<string, string> = {
  session_update: 'session/update',
  permission_request: 'session/request_permission',
}

// Send a notification/response to the WebSocket client.
//
// For legacy `{type, payload}` clients this emits the proprietary envelope.
// For JSON-RPC 2.0 clients this additionally emits a JSON-RPC response that
// echoes the in-flight request id when the message type matches the pending
// request's expected response type (audit §8.2). Agent→client notifications
// (`session_update`, `permission_request`) are emitted as JSON-RPC
// notifications without an id.
export function send(
  ws: WSContext,
  type: string,
  payload?: unknown,
  jsonRpcContext?: { id: string | number; responseType: string },
): void {
  if (ws.readyState === 1) {
    // WebSocket.OPEN
    ws.send(JSON.stringify({ type, payload }))
  }
  // Forward to RCS upstream if connected
  const rcsUpstream = getRcsUpstream()
  if (rcsUpstream?.isRegistered()) {
    rcsUpstream.send({ type, payload })
  }

  const state = clients.get(ws)
  if (!state?.jsonRpc) return

  // Retrieve context from AsyncLocalStorage (primary) or fallback to parameter/slot.
  const requestContext =
    jsonRpcContext ?? jsonRpcContextStorage.getStore() ?? state.pendingJsonRpc
  if (requestContext?.responseType === type) {
    sendJsonRpcRaw(ws, {
      jsonrpc: '2.0',
      id: requestContext.id,
      result: payload ?? {},
    })
    // Only clear the slot if we read from it (legacy fallback path)
    if (!jsonRpcContext && !jsonRpcContextStorage.getStore()) {
      state.pendingJsonRpc = null
    }
    return
  }

  // Agent→client notifications are also emitted as JSON-RPC notifications
  // (no id) so JSON-RPC clients receive them in their native format.
  const notificationMethod = LEGACY_NOTIFICATION_TO_JSONRPC[type]
  if (notificationMethod) {
    sendJsonRpcRaw(ws, {
      jsonrpc: '2.0',
      method: notificationMethod,
      params: payload ?? {},
    })
  }
}

// Serialize a JSON-RPC 2.0 message and send it to a connected WS client.
export function sendJsonRpcRaw(ws: WSContext, message: object): void {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message))
  }
}

/**
 * Send a JSON-RPC 2.0 error response with a reserved -32xxx code (audit §8.3).
 * Application-level code lands in `error.data` via `@claude-code-best/wire-types`.
 * Also emits the legacy `{type: 'error', payload: {message}}` envelope for
 * backwards compatibility.
 */
export function sendJsonRpcError(
  ws: WSContext,
  state: ClientState | undefined,
  id: string | number | null,
  code: number,
  message: string,
  wire?: WireErrorBody,
): void {
  const body: WireErrorBody = wire ?? {
    type: wireTypeFromJsonRpcCode(code),
    message,
  }
  const data = toJsonRpcErrorData(body)
  if (state?.jsonRpc) {
    sendJsonRpcRaw(ws, {
      jsonrpc: '2.0',
      id,
      error: { code, message, data },
    })
  } else {
    send(ws, 'error', {
      message,
      code: String(code),
      type: body.type,
      ...(body.details !== undefined ? { details: body.details } : {}),
    })
  }
  // Error consumed the in-flight request, if any.
  if (state) state.pendingJsonRpc = null
}
