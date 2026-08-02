import { getSdkBetas } from '../../bootstrap/state.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { getMaxOutputTokensForModel } from '../api/claude.js'

// Reserve this many tokens for output during compaction
// Based on p99.99 of compact summary output being 17,387 tokens.
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

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
export function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  let contextWindow = getContextWindowForModel(model, getSdkBetas())

  const autoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (autoCompactWindow) {
    const parsed = parseInt(autoCompactWindow, 10)
    if (!Number.isNaN(parsed) && parsed > 0) {
      contextWindow = Math.min(contextWindow, parsed)
    }
  }

  return contextWindow - reservedTokensForSummary
}
