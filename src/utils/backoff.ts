/**
 * Reconnect/retry backoff helpers.
 *
 * Zero-dependency leaf module: importable from transports, the bridge, and
 * provider paths without dragging in axios or import-time side effects.
 */

/**
 * Add ±25% jitter to a delay value, clamped at 0.
 *
 * Spreads reconnect attempts so a fleet of clients that dropped on the same
 * server event does not retry in lockstep.
 */
export function addJitter(ms: number): number {
  return Math.max(0, ms + ms * 0.25 * (2 * Math.random() - 1))
}
