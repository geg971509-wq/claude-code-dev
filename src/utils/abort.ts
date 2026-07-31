/**
 * Abort-signal helpers — abortable promises, signal linking with reason
 * forwarding, and deadline signals that distinguish timeout from parent
 * cancellation. UserCancellationError lives in ./errors with the other
 * error classes and is re-exported here so call sites have a single
 * import for the abort primitives.
 */

import { AbortError, UserCancellationError } from './errors'

export { UserCancellationError }

/**
 * Reason to pass to `controller.abort(reason)` for user-initiated
 * cancellation, so downstream catch blocks can tell it apart from
 * timeouts via isUserCancellation().
 */
export function userCancellationReason(): UserCancellationError {
  return new UserCancellationError()
}

/**
 * True if `value` is a UserCancellationError.
 */
export function isUserCancellation(
  value: unknown,
): value is UserCancellationError {
  return value instanceof UserCancellationError
}

/**
 * Settles with `promise`, or rejects with the abort reason once `signal`
 * aborts — whichever comes first. Rejecting on abort does not cancel the
 * underlying promise; callers are expected to pass the same signal into
 * the operation backing it.
 */
export function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(abortReason(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

/**
 * Forwards aborts from `source` to `target`, preserving `source.reason`
 * as the target's abort reason. If `source` is already aborted, `target`
 * is aborted synchronously. Returns an unlink function that stops the
 * forwarding; call it once the target is done to avoid leaking listeners.
 */
export function linkAbortSignal(
  source: AbortSignal,
  target: AbortController,
): () => void {
  const onAbort = () => {
    target.abort(source.reason)
  }
  if (source.aborted) {
    onAbort()
    return () => {}
  }
  source.addEventListener('abort', onAbort, { once: true })
  return () => {
    source.removeEventListener('abort', onAbort)
  }
}

/**
 * Extracts the rejection reason for an aborted signal. A custom
 * `controller.abort(reason)` error is preserved as-is; the runtime's
 * default abort reason is replaced with our AbortError class so all
 * abort paths surface the same error shape.
 */
function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error && !isDefaultAbortReason(signal.reason)) {
    return signal.reason
  }
  return new AbortError('Aborted')
}

/**
 * The runtime's own abort reason is a DOMException named 'AbortError'
 * (message text differs — Node: 'This operation was aborted', Bun:
 * 'The operation was aborted.'). Anything else passed to abort() is a
 * custom reason we keep.
 */
function isDefaultAbortReason(reason: Error): boolean {
  return reason instanceof DOMException && reason.name === 'AbortError'
}

export interface DeadlineAbortSignal {
  readonly signal: AbortSignal
  readonly timedOut: () => boolean
  readonly clear: () => void
}

/**
 * Combines a timeout with a parent abort signal: `signal` aborts when
 * `source` aborts (reason preserved) or when `timeoutMs` elapses.
 * `timedOut()` distinguishes the two — true only when the deadline
 * fired. Call `clear()` when the operation finishes so the timer does
 * not keep the event loop alive.
 */
export function createDeadlineAbortSignal(
  source: AbortSignal,
  timeoutMs: number,
): DeadlineAbortSignal {
  const controller = new AbortController()
  const unlinkAbortSignal = linkAbortSignal(source, controller)
  let didTimeout = false
  let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    didTimeout = true
    controller.abort(new AbortError('Aborted'))
  }, timeoutMs)

  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    clear: () => {
      if (timeout !== undefined) clearTimeout(timeout)
      timeout = undefined
      unlinkAbortSignal()
    },
  }
}
