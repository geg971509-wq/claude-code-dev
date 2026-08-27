import { getSdkBetas } from '../../bootstrap/state.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { getMaxOutputTokensForModel } from '../api/claude.js'
import { getGlobalConfig } from '../../utils/config.js'

// Reserve this many tokens for output during compaction
// Based on p99.99 of compact summary output being 17,387 tokens.
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

export type AutoCompactWindowSource = 'env' | 'session' | 'settings' | 'model'

export type AutoCompactWindowResolution = {
  configured: string
  window: number
  source: AutoCompactWindowSource
  capped: boolean
}

const MIN_AUTO_COMPACT_WINDOW = 100_000
const MAX_AUTO_COMPACT_WINDOW = 1_000_000

/** Parse the official compact-window spellings without accepting parseInt prefixes. */
export function parseAutoCompactWindow(
  value: string,
): number | 'auto' | undefined {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'auto') return 'auto'
  const match = /^(\d+)(k)?$/.exec(normalized)
  if (!match) return undefined
  const numeric = Number(match[1]) * (match[2] ? 1_000 : 1)
  // Bare values up to 1000 are shorthand in thousands (200 => 200k).
  const resolved = !match[2] && numeric <= 1_000 ? numeric * 1_000 : numeric
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < MIN_AUTO_COMPACT_WINDOW ||
    resolved > MAX_AUTO_COMPACT_WINDOW
  ) {
    return undefined
  }
  return resolved
}

export function resolveAutoCompactWindow(
  model: string,
  sessionOverride?: string,
): AutoCompactWindowResolution {
  const modelWindow = getContextWindowForModel(model, getSdkBetas())
  const configuredEnv = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  const configuredSettings = getGlobalConfig().autoCompactWindow
  const candidates: Array<[string | undefined, AutoCompactWindowSource]> = [
    [configuredEnv, 'env'],
    [sessionOverride, 'session'],
    [configuredSettings, 'settings'],
  ]
  for (const [configured, source] of candidates) {
    if (configured === undefined) continue
    const parsed = parseAutoCompactWindow(configured)
    if (parsed === undefined) continue
    const requested = parsed === 'auto' ? modelWindow : parsed
    const window = Math.min(requested, modelWindow)
    return { configured, window, source, capped: window !== requested }
  }
  return {
    configured: 'auto',
    window: modelWindow,
    source: 'model',
    capped: false,
  }
}

/**
 * Context window size minus the tokens reserved for the compact summary.
 *
 * Lives in its own module so compact.ts and autoCompact.ts can share it —
 * they cannot import each other (compact.ts ← autoCompact.ts already), and a
 * verbatim copy in each was previously kept in sync by comment alone.
 *
 * Not in utils/context.ts despite getContextWindowForModel living there:
 * this needs getMaxOutputTokensForModel from api/claude.ts, which already
 * imports utils/context.ts.
 */
export function getEffectiveContextWindowSize(
  model: string,
  sessionOverride?: string,
): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  let contextWindow = resolveAutoCompactWindow(model, sessionOverride).window
  // Preserve the legacy test/automation knob for small numeric values while
  // keeping the user-facing resolver strict at 100k..1M.
  const legacyEnv = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (legacyEnv && parseAutoCompactWindow(legacyEnv) === undefined) {
    const numeric = Number(legacyEnv)
    if (Number.isFinite(numeric) && numeric > 0) {
      contextWindow = Math.min(contextWindow, numeric)
    }
  }

  return contextWindow - reservedTokensForSummary
}
