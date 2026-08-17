import { feature } from 'bun:bundle'
import { markPostCompaction } from 'src/bootstrap/state.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { getGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { hasExactErrorMessage } from '../../utils/errors.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { logError } from '../../utils/log.js'
import {
  getCurrentUsage,
  tokenCountWithEstimation,
} from '../../utils/tokens.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { logEvent } from '../analytics/index.js'
import { roughTokenCountEstimationForMessages } from '../tokenEstimation.js'
import { notifyCompaction } from '../api/promptCacheBreakDetection.js'
import { setLastSummarizedMessageId } from '../SessionMemory/sessionMemoryUtils.js'
import {
  type CompactionResult,
  compactConversation,
  COMPACT_BLOCKED_BY_HOOK_PREFIX,
  ERROR_MESSAGE_USER_ABORT,
  type RecompactionInfo,
} from './compact.js'
import { getEffectiveContextWindowSize } from './effectiveWindow.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'
import { trySessionMemoryCompaction } from './sessionMemoryCompact.js'

export type AutoCompactTrackingState = {
  compacted: boolean
  turnCounter: number
  // Unique ID per turn
  turnId: string
  // Consecutive autocompact failures. Reset on success.
  // Used as a circuit breaker to stop retrying when the context is
  // irrecoverably over the limit (e.g., prompt_too_long).
  consecutiveFailures?: number
  // Consecutive post-compact refills that re-hit the autocompact threshold
  // within RAPID_REFILL_TURN_THRESHOLD turns. Reset when a compact holds.
  consecutiveRapidRefills?: number
}

/** Official-aligned autocompact outcome (kind discriminant). */
export type AutoCompactResult =
  | { kind: 'not_needed' }
  | { kind: 'failure_breaker_open' }
  | { kind: 'rapid_refill_breaker_tripped' }
  | {
      kind: 'compacted'
      result: CompactionResult
      consecutiveRapidRefills: number
      routedThroughReactive: boolean
    }
  | { kind: 'failed'; consecutiveFailures: number }
  | { kind: 'hook_blocked' }

export function isColdCompactEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_COLD_COMPACT)
}

export function isCompactBlockedByHookError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return msg.startsWith(COMPACT_BLOCKED_BY_HOOK_PREFIX)
}

export function createPostAutoCompactTracking(
  turnId: string,
  consecutiveRapidRefills: number,
): AutoCompactTrackingState {
  return {
    compacted: true,
    turnId,
    turnCounter: 0,
    consecutiveFailures: 0,
    consecutiveRapidRefills,
  }
}

export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

/**
 * Context-aware autocompact buffer. Larger context windows need more
 * headroom because a single turn can produce proportionally more tokens
 * (longer model outputs + larger tool results).
 */
export function getAutocompactBufferTokens(model: string): number {
  const effectiveWindow = getEffectiveContextWindowSize(model)
  if (effectiveWindow >= 800_000) return 50_000
  if (effectiveWindow >= 400_000) return 30_000
  return AUTOCOMPACT_BUFFER_TOKENS
}

// Stop trying autocompact after this many consecutive failures.
// BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures (up to 3,272)
// in a single session, wasting ~250K API calls/day globally.
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

// Rapid-refill breaker: if context re-hits the autocompact threshold within
// this many turns of a successful compact, count it as a rapid refill.
// Trip after MAX_CONSECUTIVE_RAPID_REFILLS in a row (official port).
const RAPID_REFILL_TURN_THRESHOLD = 3
const MAX_CONSECUTIVE_RAPID_REFILLS = 3

export const RAPID_REFILL_BREAKER_MESSAGE =
  'Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row. A file being read or a tool output is likely too large for the context window. Try reading in smaller chunks, or use /clear to start fresh.'

export function countConsecutiveRapidRefills(
  tracking?: AutoCompactTrackingState,
): number {
  if (
    tracking?.compacted === true &&
    tracking.turnCounter < RAPID_REFILL_TURN_THRESHOLD
  ) {
    return (tracking.consecutiveRapidRefills ?? 0) + 1
  }
  return 0
}

export function evaluateRapidRefillBreaker(
  tracking?: AutoCompactTrackingState,
): { action: 'trip' | 'proceed'; consecutiveRapidRefills: number } {
  const consecutiveRapidRefills = countConsecutiveRapidRefills(tracking)
  return {
    action:
      consecutiveRapidRefills >= MAX_CONSECUTIVE_RAPID_REFILLS
        ? 'trip'
        : 'proceed',
    consecutiveRapidRefills,
  }
}

/**
 * Detect when the fixed (non-compactable) prefix alone already exceeds the
 * autocompact threshold. Compaction only rewrites messages; system/tools/
 * media still sit in the window. Diagnostic only — does not block compact.
 */
export function detectFixedPrefixOverflow(
  messages: Message[],
  model: string,
  snipTokensFreed = 0,
): {
  prefixTokens: number
  thresholdTokens: number
  totalInputTokens: number
  messagesEstimate: number
  snipTokensFreed: number
  documentBlockCount: number
  imageBlockCount: number
} | null {
  const usage = getCurrentUsage(messages)
  if (!usage) return null

  const totalInputTokens =
    usage.input_tokens +
    usage.cache_read_input_tokens +
    usage.cache_creation_input_tokens
  const messagesEstimate = roughTokenCountEstimationForMessages(
    messages as Parameters<typeof roughTokenCountEstimationForMessages>[0],
  )
  const prefixTokens = Math.max(
    0,
    totalInputTokens - snipTokensFreed - messagesEstimate,
  )
  const thresholdTokens = getAutoCompactThreshold(model)
  if (prefixTokens <= thresholdTokens) return null

  let documentBlockCount = 0
  let imageBlockCount = 0
  const countBlocks = (blocks: unknown[]): void => {
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue
      const b = block as { type?: string; content?: unknown }
      if (b.type === 'document') documentBlockCount++
      else if (b.type === 'image') imageBlockCount++
      else if (b.type === 'tool_result' && Array.isArray(b.content)) {
        countBlocks(b.content)
      }
    }
  }
  for (const message of messages) {
    const content = (message as { message?: { content?: unknown } }).message
      ?.content
    if (Array.isArray(content)) countBlocks(content)
  }

  return {
    prefixTokens,
    thresholdTokens,
    totalInputTokens,
    messagesEstimate,
    snipTokensFreed,
    documentBlockCount,
    imageBlockCount,
  }
}

/**
 * Test knob: CLAUDE_AUTOCOMPACT_PCT_OVERRIDE.
 * Returns the parsed percent when active, else null.
 * Active iff finite, > 0, and <= 100 (same rules as the threshold branch).
 * Can only lower the autocompact trigger (see getAutoCompactThreshold).
 */
export function getAutocompactPctOverride(): number | null {
  const envPercent = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  if (!envPercent) return null
  const parsed = parseFloat(envPercent)
  if (isNaN(parsed) || parsed <= 0 || parsed > 100) return null
  return parsed
}

export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)

  const autocompactThreshold =
    effectiveContextWindow - getAutocompactBufferTokens(model)

  // Override for easier testing of autocompact
  const parsed = getAutocompactPctOverride()
  if (parsed !== null) {
    const percentageThreshold = Math.floor(
      effectiveContextWindow * (parsed / 100),
    )
    return Math.min(percentageThreshold, autocompactThreshold)
  }

  return autocompactThreshold
}

export function calculateTokenWarningState(
  tokenUsage: number,
  model: string,
): {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveErrorThreshold: boolean
  isAboveAutoCompactThreshold: boolean
  isAtBlockingLimit: boolean
} {
  const autoCompactThreshold = getAutoCompactThreshold(model)
  const threshold = isAutoCompactEnabled()
    ? autoCompactThreshold
    : getEffectiveContextWindowSize(model)

  const percentLeft = Math.max(
    0,
    Math.round(((threshold - tokenUsage) / threshold) * 100),
  )

  const warningThreshold = threshold - WARNING_THRESHOLD_BUFFER_TOKENS
  const errorThreshold = threshold - ERROR_THRESHOLD_BUFFER_TOKENS

  const isAboveWarningThreshold = tokenUsage >= warningThreshold
  const isAboveErrorThreshold = tokenUsage >= errorThreshold

  const isAboveAutoCompactThreshold =
    isAutoCompactEnabled() && tokenUsage >= autoCompactThreshold

  const actualContextWindow = getEffectiveContextWindowSize(model)
  const defaultBlockingLimit =
    actualContextWindow - MANUAL_COMPACT_BUFFER_TOKENS

  // Allow override for testing
  const blockingLimitOverride = process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE
  const parsedOverride = blockingLimitOverride
    ? parseInt(blockingLimitOverride, 10)
    : NaN
  const blockingLimit =
    !isNaN(parsedOverride) && parsedOverride > 0
      ? parsedOverride
      : defaultBlockingLimit

  const isAtBlockingLimit = tokenUsage >= blockingLimit

  return {
    percentLeft,
    isAboveWarningThreshold,
    isAboveErrorThreshold,
    isAboveAutoCompactThreshold,
    isAtBlockingLimit,
  }
}

export function isAutoCompactEnabled(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return false
  }
  // Allow disabling just auto-compact (keeps manual /compact working)
  if (isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)) {
    return false
  }
  // Check if user has disabled auto-compact in their settings
  const userConfig = getGlobalConfig()
  return userConfig.autoCompactEnabled
}

export async function shouldAutoCompact(
  messages: Message[],
  model: string,
  querySource?: QuerySource,
  // Snip removes messages but the surviving assistant's usage still reflects
  // pre-snip context, so tokenCountWithEstimation can't see the savings.
  // Subtract the rough-delta that snip already computed.
  snipTokensFreed = 0,
): Promise<boolean> {
  // Recursion guards. session_memory and compact are forked agents that
  // would deadlock.
  if (querySource === 'session_memory' || querySource === 'compact') {
    return false
  }
  // marble_origami is the ctx-agent — if ITS context blows up and
  // autocompact fires, runPostCompactCleanup calls resetContextCollapse()
  // which destroys the MAIN thread's committed log (module-level state
  // shared across forks). Inside feature() so the string DCEs from
  // external builds (it's in excluded-strings.txt).

  if (!isAutoCompactEnabled()) {
    return false
  }

  // Reactive-only mode: suppress proactive autocompact, let reactive compact
  // catch the API's prompt-too-long. feature() wrapper keeps the flag string
  // out of external builds (REACTIVE_COMPACT is ant-only).
  // Note: returning false here also means autoCompactIfNeeded never reaches
  // trySessionMemoryCompaction in the query loop — the /compact call site
  // still tries session memory first. Revisit if reactive-only graduates.
  if (feature('REACTIVE_COMPACT')) {
    if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false)) {
      return false
    }
  }

  // Context-collapse mode: same suppression. Collapse IS the context
  // management system when it's on — the 90% commit / 95% blocking-spawn
  // flow owns the headroom problem. Autocompact firing at effective-13k
  // (~93% of effective) sits right between collapse's commit-start (90%)
  // and blocking (95%), so it would race collapse and usually win, nuking
  // granular context that collapse was about to save. Gating here rather
  // than in isAutoCompactEnabled() keeps reactiveCompact alive as the 413
  // fallback (it consults isAutoCompactEnabled directly) and leaves
  // sessionMemory + manual /compact working.

  const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
  const threshold = getAutoCompactThreshold(model)
  const effectiveWindow = getEffectiveContextWindowSize(model)

  logForDebugging(
    `autocompact: tokens=${tokenCount} threshold=${threshold} effectiveWindow=${effectiveWindow}${snipTokensFreed > 0 ? ` snipFreed=${snipTokensFreed}` : ''}`,
  )

  const { isAboveAutoCompactThreshold } = calculateTokenWarningState(
    tokenCount,
    model,
  )

  return isAboveAutoCompactThreshold
}

export async function autoCompactIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource?: QuerySource,
  tracking?: AutoCompactTrackingState,
  snipTokensFreed?: number,
): Promise<AutoCompactResult> {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return { kind: 'not_needed' }
  }

  // Circuit breaker: stop retrying after N consecutive failures.
  // Without this, sessions where context is irrecoverably over the limit
  // hammer the API with doomed compaction attempts on every turn.
  if (
    tracking?.consecutiveFailures !== undefined &&
    tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
  ) {
    return { kind: 'failure_breaker_open' }
  }

  const model = toolUseContext.options.mainLoopModel
  const shouldCompact = await shouldAutoCompact(
    messages,
    model,
    querySource,
    snipTokensFreed,
  )

  if (!shouldCompact) {
    return { kind: 'not_needed' }
  }

  // Fixed-prefix overflow: system/tools/media already exceed the threshold.
  // Compact rewrites messages only, so it cannot free this headroom. Log and
  // continue — still attempt compact in case messages share blame.
  const prefixOverflow = detectFixedPrefixOverflow(
    messages,
    model,
    snipTokensFreed ?? 0,
  )
  if (prefixOverflow) {
    logForDebugging(
      `autocompact: fixed prefix ~${prefixOverflow.prefixTokens} > threshold ${prefixOverflow.thresholdTokens} — compaction cannot help`,
      { level: 'warn' },
    )
    logEvent('tengu_auto_compact_prefix_overflow', {
      ...prefixOverflow,
      wouldHaveBlocked: true,
    })
  }

  // Rapid-refill breaker: context keeps refilling to the limit within a few
  // turns of each compact. Further compact attempts thrash without helping.
  const rapidRefill = evaluateRapidRefillBreaker(tracking)
  const { consecutiveRapidRefills } = rapidRefill
  if (rapidRefill.action === 'trip') {
    logForDebugging(
      `autocompact: rapid-refill breaker tripped — ${consecutiveRapidRefills} consecutive refills within <${RAPID_REFILL_TURN_THRESHOLD} turns each (last was ${tracking?.turnCounter} turns)`,
      { level: 'warn' },
    )
    // Official returns only {kind}; query logs using pre-trip tracking.
    return { kind: 'rapid_refill_breaker_tripped' }
  }

  const recompactionInfo: RecompactionInfo = {
    isRecompactionInChain: tracking?.compacted === true,
    turnsSincePreviousCompact: tracking?.turnCounter ?? -1,
    previousCompactTurnId: tracking?.turnId,
    autoCompactThreshold: getAutoCompactThreshold(model),
    querySource,
  }

  // EXPERIMENT: Try session memory compaction first
  const sessionMemoryResult = await trySessionMemoryCompaction(
    messages,
    toolUseContext.agentId,
    recompactionInfo.autoCompactThreshold,
  )
  if (sessionMemoryResult) {
    // Reset lastSummarizedMessageId since session memory compaction prunes messages
    // and the old message UUID will no longer exist after the REPL replaces messages
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)
    // Reset cache read baseline so the post-compact drop isn't flagged as a
    // break. compactConversation does this internally; SM-compact doesn't.
    // BQ 2026-03-01: missing this made 20% of tengu_prompt_cache_break events
    // false positives (systemPromptChanged=true, timeSinceLastAssistantMsg=-1).
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      notifyCompaction(querySource ?? 'compact', toolUseContext.agentId)
    }
    markPostCompaction()
    return {
      kind: 'compacted',
      result: sessionMemoryResult,
      consecutiveRapidRefills,
      routedThroughReactive: false,
    }
  }

  try {
    const cold = isColdCompactEnabled()
    if (cold) {
      logForDebugging('autocompact: cold compact enabled (stripNonEssential)')
      logEvent('tengu_cold_compact', {})
    }
    const compactionResult = await compactConversation(
      messages,
      toolUseContext,
      cacheSafeParams,
      true, // Suppress user questions for autocompact
      undefined, // No custom instructions for autocompact
      true, // isAutoCompact
      recompactionInfo,
      cold ? { stripNonEssential: true } : undefined,
    )

    // Reset lastSummarizedMessageId since legacy compaction replaces all messages
    // and the old message UUID will no longer exist in the new messages array
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)

    return {
      kind: 'compacted',
      result: compactionResult,
      consecutiveRapidRefills,
      routedThroughReactive: false,
    }
  } catch (error) {
    // PreCompact decision=block — not a compact failure; do not trip breaker.
    if (isCompactBlockedByHookError(error)) {
      logForDebugging(
        `autocompact: blocked by PreCompact hook — ${error instanceof Error ? error.message : String(error)}`,
        { level: 'warn' },
      )
      return { kind: 'hook_blocked' }
    }
    if (!hasExactErrorMessage(error, ERROR_MESSAGE_USER_ABORT)) {
      logError(error)
    }
    // Increment consecutive failure count for circuit breaker.
    // The caller threads this through autoCompactTracking so the
    // next query loop iteration can skip futile retry attempts.
    const prevFailures = tracking?.consecutiveFailures ?? 0
    const nextFailures = prevFailures + 1
    if (nextFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      logForDebugging(
        `autocompact: circuit breaker tripped after ${nextFailures} consecutive failures — skipping future attempts this session`,
        { level: 'warn' },
      )
    }
    return { kind: 'failed', consecutiveFailures: nextFailures }
  }
}
