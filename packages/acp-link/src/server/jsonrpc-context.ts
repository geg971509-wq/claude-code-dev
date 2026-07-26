import { AsyncLocalStorage } from 'node:async_hooks'
import type { ClientState } from './types.js'

/**
 * Per-request JSON-RPC context.
 *
 * Carries the in-flight request's id and expected response type down to
 * `send()` and to handler error paths. A shared per-client slot cannot be used
 * here: `@hono/node-ws` does not await `onMessage`, so a second request can
 * overwrite the slot while the first is suspended on an await, which made
 * responses come back under the wrong id.
 */
export const jsonRpcContextStorage = new AsyncLocalStorage<{
  id: string | number
  responseType: string
}>()

/**
 * Resolve the id of the request currently being handled.
 *
 * Prefers the async-local context, falling back to the legacy per-client slot
 * for call paths that still set it (`$/cancel_request`, the pre-dispatch
 * validation in `start-server.ts`). Returns null when there is no in-flight
 * request, which is the correct JSON-RPC id for an error that cannot be
 * attributed to one.
 */
export function currentJsonRpcId(
  state: ClientState | undefined,
): string | number | null {
  return (
    jsonRpcContextStorage.getStore()?.id ?? state?.pendingJsonRpc?.id ?? null
  )
}
