/**
 * Agent launch throttle (ported from kimi-code's subagent-batch.ts, reduced
 * to a single cooldown gate — the AIMD capacity window was dropped because
 * withRetry already handles per-request backoff; the only thing missing was
 * throttling NEW subagent launches during account-level rate limiting).
 *
 * Signal flow: withRetry's catch observes 429/529 → noteRateLimited() sets
 * `throttledUntil`. runAgent calls acquireLaunchSlot() before starting a
 * subagent's query loop, so launches during the cooldown wait instead of
 * adding N× retry amplification. The wait is abort-aware via src/utils/sleep.
 *
 * Known boundary: the OpenAI/Grok compatibility layers bypass withRetry, so
 * their rate limits never reach this controller (documented in withRetry).
 */

import { logForDebugging } from '../../utils/debug.js'
import { sleep } from '../../utils/sleep.js'

const DEFAULT_COOLDOWN_MS = 10_000
const MAX_COOLDOWN_MS = 30_000
const LOG_WAIT_THRESHOLD_MS = 2_000

let throttledUntil = 0

/**
 * Record a rate-limit hit. `cooldownMs` should be the server's retry-after
 * when available; defaults to 10s, capped at 30s. Concurrent hits extend the
 * window but never past the cap.
 */
export function noteRateLimited(cooldownMs?: number, now = Date.now()): void {
  const cooldown = Math.min(
    Math.max(cooldownMs ?? DEFAULT_COOLDOWN_MS, 1),
    MAX_COOLDOWN_MS,
  )
  throttledUntil = Math.max(throttledUntil, now + cooldown)
}

/** Milliseconds a new launch should still wait; 0 when the gate is open. */
export function throttleWaitMs(now = Date.now()): number {
  return Math.max(0, throttledUntil - now)
}

/**
 * Wait out the cooldown (if any) before launching a subagent. Aborting the
 * signal rejects with an AbortError-named error so a cancelled agent doesn't
 * hang in the wait.
 */
export async function acquireLaunchSlot(signal?: AbortSignal): Promise<void> {
  const waitMs = throttleWaitMs()
  if (waitMs <= 0) return
  if (waitMs > LOG_WAIT_THRESHOLD_MS) {
    logForDebugging(
      `Agent launch throttled for ${waitMs}ms after API rate limit`,
    )
  }
  await sleep(waitMs, signal, {
    abortError: () => {
      const err = new Error('Aborted while waiting for agent launch throttle')
      err.name = 'AbortError'
      return err
    },
  })
}

/** Test-only: reset throttle state. */
export function resetAgentLaunchThrottleForTesting(): void {
  throttledUntil = 0
}
