/**
 * Indirection for the agent launch throttle.
 *
 * The throttle implementation lives in src (src/services/api/agentLaunchController.ts),
 * but builtin-tools must not gain new reverse imports into the app's src tree
 * (scripts/boundaries-baseline.json ratchet — note the checker is regex-based,
 * so even quoting an example import specifier in a comment would count). So
 * src registers its implementation here at startup (see src/tools.ts) and
 * runAgent calls the passthrough. Default is a no-op (throttle disabled
 * until registered).
 */

export type AcquireLaunchSlot = (signal?: AbortSignal) => Promise<void>

let impl: AcquireLaunchSlot = async () => {}

export function setAgentLaunchThrottle(acquire: AcquireLaunchSlot): void {
  impl = acquire
}

export function acquireAgentLaunchSlot(signal?: AbortSignal): Promise<void> {
  return impl(signal)
}
