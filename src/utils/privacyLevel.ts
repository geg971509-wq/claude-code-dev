/**
 * Privacy level controls how much nonessential network traffic and telemetry
 * Claude Code generates.
 *
 * Levels are ordered by restrictiveness:
 *   default < no-telemetry < essential-traffic
 *
 * - default:            Telemetry was explicitly enabled.
 * - no-telemetry:       Analytics/telemetry disabled (Datadog, 1P events, feedback survey).
 * - essential-traffic:  ALL nonessential network traffic disabled
 *                       (telemetry + auto-updates, grove, release notes, model capabilities, etc.).
 *
 * The resolved level is the most restrictive signal from:
 *   CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC  →  essential-traffic
 *   DISABLE_TELEMETRY                         →  no-telemetry
 *   no CLAUDE_CODE_ENABLE_TELEMETRY opt-in    →  no-telemetry
 */

import { isEnvTruthy } from './envUtils.js'

type PrivacyLevel = 'default' | 'no-telemetry' | 'essential-traffic'

export function getPrivacyLevel(): PrivacyLevel {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)) {
    return 'essential-traffic'
  }
  if (!isTelemetryOptedIn()) {
    return 'no-telemetry'
  }
  return 'default'
}

/**
 * Telemetry is opt-in in this fork. Explicit disable switches always win,
 * even when CLAUDE_CODE_ENABLE_TELEMETRY is also present.
 */
export function isTelemetryOptedIn(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_TELEMETRY) &&
    !isEnvTruthy(process.env.DISABLE_TELEMETRY) &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)
  )
}

/**
 * True when all nonessential network traffic should be suppressed.
 * Equivalent to the old `process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` check.
 */
export function isEssentialTrafficOnly(): boolean {
  return getPrivacyLevel() === 'essential-traffic'
}

/**
 * True when telemetry/analytics should be suppressed.
 * True at both `no-telemetry` and `essential-traffic` levels.
 */
export function isTelemetryDisabled(): boolean {
  return getPrivacyLevel() !== 'default'
}

/**
 * Returns the env var name responsible for the current essential-traffic restriction,
 * or null if unrestricted. Used for user-facing "unset X to re-enable" messages.
 */
export function getEssentialTrafficOnlyReason(): string | null {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)) {
    return 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'
  }
  return null
}
