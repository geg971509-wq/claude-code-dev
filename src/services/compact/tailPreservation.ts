import type { Message } from '../../types/message.js'
import { groupMessagesByApiRound } from './grouping.js'

/**
 * Tail preservation for full compaction (borrowed from opencode's
 * session/compaction.ts): instead of replacing the entire history with the
 * summary, keep the most recent API rounds verbatim after it.
 *
 * This module is intentionally dependency-light (no bootstrap/state, no API
 * imports) so it stays test-friendly and free of the compact.ts ↔
 * autoCompact.ts cycle. The token estimator is INJECTED rather than
 * imported: tokenEstimation.ts is mock.module'd by other test files
 * (process-global, last-write-wins), so importing it here would make this
 * module's behavior order-dependent under the full test suite.
 */

/** Estimator for one API round's token size (same shape as roughTokenCountEstimationForMessages). */
export type RoundTokenEstimator = (
  round: readonly { type: string; message?: { content?: unknown } }[],
) => number

export const TAIL_DEFAULT_MAX_ROUNDS = 2
export const PRESERVE_RECENT_MIN_TOKENS = 2_000
export const PRESERVE_RECENT_MAX_TOKENS = 8_000
/** Fraction of the effective context window budgeted for the verbatim tail. */
export const PRESERVE_RECENT_FRACTION = 0.25

/**
 * Max API rounds to preserve. CLAUDE_CODE_COMPACT_TAIL_ROUNDS overrides;
 * 0 disables tail preservation entirely.
 */
export function tailMaxRounds(): number {
  const override = process.env.CLAUDE_CODE_COMPACT_TAIL_ROUNDS
  if (override !== undefined) {
    const parsed = parseInt(override, 10)
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return parsed
    }
  }
  return TAIL_DEFAULT_MAX_ROUNDS
}

/**
 * Token budget for the verbatim tail: 25% of the effective context window,
 * clamped to [2k, 8k] (same shape as opencode's preserveRecentBudget).
 * CLAUDE_CODE_COMPACT_PRESERVE_RECENT_TOKENS overrides outright.
 */
export function preserveRecentBudget(effectiveWindowTokens: number): number {
  const override = process.env.CLAUDE_CODE_COMPACT_PRESERVE_RECENT_TOKENS
  if (override !== undefined) {
    const parsed = parseInt(override, 10)
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }
  return Math.min(
    PRESERVE_RECENT_MAX_TOKENS,
    Math.max(
      PRESERVE_RECENT_MIN_TOKENS,
      Math.floor(effectiveWindowTokens * PRESERVE_RECENT_FRACTION),
    ),
  )
}

export type TailSelection = {
  head: Message[]
  tail: Message[]
}

/**
 * Split messages into a head (to be summarized) and a tail (to be preserved
 * verbatim). Whole API rounds only — a round that doesn't fit the remaining
 * budget is never split, and the newest round never survives past
 * `maxRounds`. Returns an empty tail when nothing fits (round too large) or
 * when everything would fit (nothing left to summarize — fall back to the
 * old replace-everything behavior).
 */
export function selectPreservedTail(
  messages: Message[],
  budgetTokens: number,
  maxRounds: number,
  estimateRoundTokens: RoundTokenEstimator,
): TailSelection {
  if (maxRounds <= 0 || budgetTokens <= 0 || messages.length === 0) {
    return { head: messages, tail: [] }
  }
  const rounds = groupMessagesByApiRound(messages)

  let budgetLeft = budgetTokens
  let keptRounds = 0
  let firstKeptRoundIndex = rounds.length
  for (let i = rounds.length - 1; i >= 0 && keptRounds < maxRounds; i--) {
    const round = rounds[i]!
    const estimate = estimateRoundTokens(round)
    if (estimate > budgetLeft) {
      break
    }
    budgetLeft -= estimate
    keptRounds++
    firstKeptRoundIndex = i
  }

  if (firstKeptRoundIndex === rounds.length) {
    return { head: messages, tail: [] }
  }
  const keptMessageCount = rounds
    .slice(firstKeptRoundIndex)
    .reduce((count, round) => count + round.length, 0)
  if (keptMessageCount >= messages.length) {
    // The whole conversation fits in the tail — nothing to summarize.
    return { head: messages, tail: [] }
  }
  return {
    head: messages.slice(0, messages.length - keptMessageCount),
    tail: messages.slice(messages.length - keptMessageCount),
  }
}
