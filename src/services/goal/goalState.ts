/**
 * Per-session goal state machine. Pure in-memory management — no FS,
 * no network. Persistence is handled by goalStorage.ts.
 *
 * Closed-loop rules (aligned with kimi GOAL.md, without DI rewrite):
 * - Durable statuses: active | paused | blocked. complete is transient.
 * - budget / usage / max-turns map to blocked(+reason), not extra statuses.
 * - resume works for paused and blocked.
 * - setGoal refuses silent overwrite unless replace:true.
 * - hydrate demotes active → paused (prevents resume steal-running).
 *
 * Map keyed by sessionId so concurrent sub-sessions don't leak.
 */
import type { GoalState, GoalStatus } from '../../types/logs.js'
import { getSessionId } from '../../bootstrap/state.js'
import { logForDebugging } from '../../utils/debug.js'

export const BLOCKED_CONSECUTIVE_THRESHOLD = 3
/** Hard safety cap when no explicit turnBudget is set. */
export const MAX_GOAL_TURNS = 150
export const MAX_GOAL_OBJECTIVE_LENGTH = 4000
/** Completion criterion is truncated (not rejected) when over this length. */
export const MAX_GOAL_COMPLETION_CRITERION_LENGTH = MAX_GOAL_OBJECTIVE_LENGTH
/** Wall-clock budgets must be within [1 min, 24 h]. */
export const MIN_WALL_CLOCK_BUDGET_MS = 60_000
export const MAX_WALL_CLOCK_BUDGET_MS = 24 * 60 * 60 * 1000

const goals = new Map<string, GoalState>()

function goalLog(
  tag: string,
  msg: string,
  extra?: Record<string, unknown>,
): void {
  const suffix = extra ? ` ${JSON.stringify(extra)}` : ''
  logForDebugging(`[goal] ${tag}: ${msg}${suffix}`)
}

function resolveSessionId(sessionId?: string): string {
  return sessionId ?? getSessionId()
}

function foldActiveInterval(goal: GoalState, now = Date.now()): void {
  if (goal.status === 'active' && goal.pausedAt === null) {
    goal.accumulatedActiveMs += now - goal.startTime
  }
}

function positiveIntOrNull(value: number | undefined | null): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.floor(value)
}

function wallClockBudgetOrNull(
  value: number | undefined | null,
): number | null {
  const n = positiveIntOrNull(value)
  if (n === null) return null
  if (n < MIN_WALL_CLOCK_BUDGET_MS || n > MAX_WALL_CLOCK_BUDGET_MS) return null
  return n
}

/** Trim + cap criterion; empty → null. Over-long is truncated (kimi parity). */
export function normalizeCompletionCriterion(
  value: string | null | undefined,
): string | null {
  if (value === undefined || value === null) return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > MAX_GOAL_COMPLETION_CRITERION_LENGTH) {
    return trimmed.slice(0, MAX_GOAL_COMPLETION_CRITERION_LENGTH)
  }
  return trimmed
}

/** Normalize legacy transcript statuses into the closed-loop set. */
export function normalizeGoalState(raw: GoalState): GoalState {
  // Status may be a legacy string from older transcripts.
  const rawStatus = String((raw as GoalState & { status: string }).status)
  let status: GoalStatus
  let terminalReason = raw.terminalReason ?? null

  switch (rawStatus) {
    case 'active':
    case 'paused':
    case 'blocked':
    case 'complete':
      status = rawStatus
      break
    case 'budget_limited':
      status = 'blocked'
      terminalReason = terminalReason ?? 'Token budget reached'
      break
    case 'usage_limited':
      status = 'paused'
      terminalReason = terminalReason ?? 'Provider usage/rate limit'
      break
    case 'max_turns':
      status = 'blocked'
      terminalReason =
        terminalReason ?? `Max continuation turns (${MAX_GOAL_TURNS}) reached`
      break
    default:
      status = 'paused'
      terminalReason = terminalReason ?? `Unknown status: ${rawStatus}`
  }

  return {
    objective: raw.objective,
    status,
    completionCriterion: normalizeCompletionCriterion(
      raw.completionCriterion ?? null,
    ),
    tokenBudget: positiveIntOrNull(raw.tokenBudget),
    turnBudget: positiveIntOrNull(raw.turnBudget),
    wallClockBudgetMs: wallClockBudgetOrNull(raw.wallClockBudgetMs),
    tokensUsed: Number.isFinite(raw.tokensUsed)
      ? Math.max(0, raw.tokensUsed)
      : 0,
    startTime: raw.startTime,
    pausedAt: raw.pausedAt,
    accumulatedActiveMs: Number.isFinite(raw.accumulatedActiveMs)
      ? Math.max(0, raw.accumulatedActiveMs)
      : 0,
    blockedAttempts: Number.isFinite(raw.blockedAttempts)
      ? Math.max(0, raw.blockedAttempts)
      : 0,
    lastBlockReason: raw.lastBlockReason ?? null,
    terminalReason,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    turnsExecuted: Number.isFinite(raw.turnsExecuted)
      ? Math.max(0, raw.turnsExecuted)
      : 0,
  }
}

export type SetGoalOptions = {
  tokenBudget?: number
  turnBudget?: number
  wallClockBudgetMs?: number
  completionCriterion?: string | null
  sessionId?: string
  /** Required when a non-complete goal already exists. */
  replace?: boolean
}

export type SetGoalResult =
  | { ok: true; goal: GoalState }
  | { ok: false; error: 'empty' | 'too_long' | 'exists'; message: string }

export function setGoal(
  objective: string,
  options?: SetGoalOptions,
): SetGoalResult {
  const trimmed = objective.trim()
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: 'empty',
      message: 'Goal objective cannot be empty',
    }
  }
  if (trimmed.length > MAX_GOAL_OBJECTIVE_LENGTH) {
    return {
      ok: false,
      error: 'too_long',
      message: `Goal objective cannot exceed ${MAX_GOAL_OBJECTIVE_LENGTH} characters`,
    }
  }

  const id = resolveSessionId(options?.sessionId)
  const existing = goals.get(id)
  if (existing && existing.status !== 'complete' && options?.replace !== true) {
    return {
      ok: false,
      error: 'exists',
      message:
        'A goal already exists; pass replace:true or confirm with the user',
    }
  }

  const now = Date.now()
  const state: GoalState = {
    objective: trimmed,
    status: 'active',
    completionCriterion: normalizeCompletionCriterion(
      options?.completionCriterion,
    ),
    tokenBudget: positiveIntOrNull(options?.tokenBudget),
    turnBudget: positiveIntOrNull(options?.turnBudget),
    wallClockBudgetMs: wallClockBudgetOrNull(options?.wallClockBudgetMs),
    tokensUsed: 0,
    startTime: now,
    pausedAt: null,
    accumulatedActiveMs: 0,
    blockedAttempts: 0,
    lastBlockReason: null,
    terminalReason: null,
    createdAt: now,
    updatedAt: now,
    turnsExecuted: 0,
  }
  goals.set(id, state)
  goalLog('SET', `objective="${trimmed.slice(0, 80)}"`, {
    tokenBudget: state.tokenBudget,
    turnBudget: state.turnBudget,
    wallClockBudgetMs: state.wallClockBudgetMs,
    replace: options?.replace === true,
  })
  return { ok: true, goal: state }
}

export function getGoal(sessionId?: string): GoalState | null {
  return goals.get(resolveSessionId(sessionId)) ?? null
}

export function clearGoal(sessionId?: string): boolean {
  const had = goals.has(resolveSessionId(sessionId))
  const result = goals.delete(resolveSessionId(sessionId))
  if (had) goalLog('CLEAR', 'goal removed')
  return result
}

export function pauseGoal(
  sessionId?: string,
  reason?: string,
): GoalState | null {
  const id = resolveSessionId(sessionId)
  const goal = goals.get(id)
  if (!goal || goal.status !== 'active') return null
  const now = Date.now()
  foldActiveInterval(goal, now)
  goal.pausedAt = now
  goal.status = 'paused'
  goal.terminalReason = reason?.trim() || null
  goal.updatedAt = now
  goalLog(
    'PAUSE',
    `paused after ${Math.round(goal.accumulatedActiveMs / 1000)}s active`,
    { reason: goal.terminalReason },
  )
  return goal
}

/**
 * Parks an active goal for runtime/provider failures. No-op if missing or
 * not active (won't clobber a user pause/clear).
 */
export function pauseActiveGoal(
  reason: string,
  sessionId?: string,
): GoalState | null {
  return pauseGoal(sessionId, reason)
}

/**
 * Resume paused OR blocked goals. Clears terminal reason + blocked audit
 * so the next run is a fresh attempt.
 */
export function resumeGoal(sessionId?: string): GoalState | null {
  const id = resolveSessionId(sessionId)
  const goal = goals.get(id)
  if (!goal) return null
  if (goal.status !== 'paused' && goal.status !== 'blocked') {
    return null
  }
  const now = Date.now()
  goal.startTime = now
  goal.pausedAt = null
  goal.status = 'active'
  goal.terminalReason = null
  goal.blockedAttempts = 0
  goal.lastBlockReason = null
  goal.updatedAt = now
  goalLog('RESUME', 'goal resumed')
  return goal
}

/**
 * Hard-stop when the safety turn cap or explicit turnBudget is hit.
 * Maps to blocked (resumable), not a separate max_turns status.
 */
export function markGoalMaxTurnsReached(sessionId?: string): GoalState | null {
  const goal = getGoal(sessionId)
  if (!goal || goal.status !== 'active') return null
  const cap = goal.turnBudget ?? MAX_GOAL_TURNS
  if (goal.turnsExecuted < cap) return null
  return markBlocked(
    goal.turnBudget !== null
      ? `Turn budget reached (${goal.turnBudget})`
      : `Max continuation turns (${MAX_GOAL_TURNS}) reached`,
    sessionId,
  )
}

/**
 * After a turn-budget block: reset the counter and re-activate.
 * (User action: `/goal continue`.)
 */
export function continueGoalFromMaxTurns(sessionId?: string): GoalState | null {
  const goal = getGoal(sessionId)
  if (!goal || goal.status !== 'blocked') return null
  const reason = goal.terminalReason ?? ''
  const isTurnCap =
    reason.includes('Max continuation turns') ||
    reason.includes('Turn budget reached')
  if (!isTurnCap) return null
  const now = Date.now()
  goal.turnsExecuted = 0
  goal.status = 'active'
  goal.startTime = now
  goal.pausedAt = null
  goal.blockedAttempts = 0
  goal.lastBlockReason = null
  goal.terminalReason = null
  goal.updatedAt = now
  goalLog('CONTINUE', 'turn counter reset after turn-budget block')
  return goal
}

/**
 * Transient success: set complete, return snapshot for outcome prompt.
 * Callers should clear after the wrap-up turn (or immediately if no wrap-up).
 */
export function completeGoal(
  sessionId?: string,
  reason?: string,
): GoalState | null {
  const id = resolveSessionId(sessionId)
  const goal = goals.get(id)
  if (!goal || goal.status !== 'active') return null
  const now = Date.now()
  foldActiveInterval(goal, now)
  goal.status = 'complete'
  goal.terminalReason = reason?.trim() || null
  goal.updatedAt = now
  goalLog('COMPLETE', 'goal achieved', {
    tokensUsed: goal.tokensUsed,
    turns: goal.turnsExecuted,
  })
  return goal
}

/**
 * System stop: model blocker, hard budget, prompt-hook. Resumable.
 */
export function markBlocked(
  reason: string,
  sessionId?: string,
): GoalState | null {
  const id = resolveSessionId(sessionId)
  const goal = goals.get(id)
  if (!goal || goal.status !== 'active') return null
  const now = Date.now()
  foldActiveInterval(goal, now)
  goal.pausedAt = now
  goal.status = 'blocked'
  goal.terminalReason = reason.trim() || 'blocked'
  goal.updatedAt = now
  goalLog('BLOCKED', goal.terminalReason)
  return goal
}

export function updateGoalTokens(
  delta: number,
  sessionId?: string,
): GoalState | null {
  const id = resolveSessionId(sessionId)
  const goal = goals.get(id)
  if (!goal) return null
  if (goal.status !== 'active') return null
  if (!Number.isFinite(delta) || delta <= 0) return goal
  goal.tokensUsed += delta
  goal.updatedAt = Date.now()
  if (goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) {
    return markBlocked(
      `Token budget reached (${goal.tokensUsed}/${goal.tokenBudget})`,
      sessionId,
    )
  }
  goalLog(
    'TOKENS',
    `+${delta} → total ${goal.tokensUsed}${goal.tokenBudget ? `/${goal.tokenBudget}` : ''}`,
  )
  return goal
}

/** Provider rate/usage limit → paused (retryable runtime stop). */
export function markUsageLimited(sessionId?: string): GoalState | null {
  return pauseActiveGoal('Provider usage/rate limit', sessionId)
}

export function setGoalBudgets(
  budgets: {
    tokenBudget?: number | null
    turnBudget?: number | null
    wallClockBudgetMs?: number | null
  },
  sessionId?: string,
): GoalState | null {
  const goal = getGoal(sessionId)
  if (!goal) return null
  if (budgets.tokenBudget !== undefined) {
    goal.tokenBudget = positiveIntOrNull(budgets.tokenBudget)
  }
  if (budgets.turnBudget !== undefined) {
    goal.turnBudget = positiveIntOrNull(budgets.turnBudget)
  }
  if (budgets.wallClockBudgetMs !== undefined) {
    goal.wallClockBudgetMs = wallClockBudgetOrNull(budgets.wallClockBudgetMs)
  }
  goal.updatedAt = Date.now()
  goalLog('BUDGET', 'limits updated', {
    tokenBudget: goal.tokenBudget,
    turnBudget: goal.turnBudget,
    wallClockBudgetMs: goal.wallClockBudgetMs,
  })
  // Immediate hard-stop if already over a newly set limit.
  return checkBudgets(sessionId) ?? goal
}

/**
 * Hard budget check before/after a goal turn. Returns the goal if a
 * transition happened, else null.
 */
export function checkBudgets(sessionId?: string): GoalState | null {
  const goal = getGoal(sessionId)
  if (!goal || goal.status !== 'active') return null

  if (goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) {
    return markBlocked(
      `Token budget reached (${goal.tokensUsed}/${goal.tokenBudget})`,
      sessionId,
    )
  }

  const turnCap = goal.turnBudget ?? MAX_GOAL_TURNS
  if (goal.turnsExecuted >= turnCap) {
    return markBlocked(
      goal.turnBudget !== null
        ? `Turn budget reached (${goal.turnBudget})`
        : `Max continuation turns (${MAX_GOAL_TURNS}) reached`,
      sessionId,
    )
  }

  if (goal.wallClockBudgetMs !== null) {
    const elapsed = getActiveElapsedMs(goal)
    if (elapsed >= goal.wallClockBudgetMs) {
      return markBlocked(
        `Wall-clock budget reached (${formatGoalElapsed(goal)})`,
        sessionId,
      )
    }
  }

  return null
}

/** Highest budget-usage fraction across set hard budgets (0 when none). */
export function maxBudgetFraction(goal: GoalState): number {
  const fractions: number[] = []
  if (goal.tokenBudget !== null && goal.tokenBudget > 0) {
    fractions.push(goal.tokensUsed / goal.tokenBudget)
  }
  const turnCap = goal.turnBudget ?? MAX_GOAL_TURNS
  if (turnCap > 0) {
    fractions.push(goal.turnsExecuted / turnCap)
  }
  if (goal.wallClockBudgetMs !== null && goal.wallClockBudgetMs > 0) {
    fractions.push(getActiveElapsedMs(goal) / goal.wallClockBudgetMs)
  }
  return fractions.length === 0 ? 0 : Math.max(...fractions)
}

export function incrementGoalTurns(sessionId?: string): number {
  const id = resolveSessionId(sessionId)
  const goal = goals.get(id)
  if (!goal) return 0
  if (goal.status !== 'active') return goal.turnsExecuted
  goal.turnsExecuted += 1
  goal.updatedAt = Date.now()
  const cap = goal.turnBudget ?? MAX_GOAL_TURNS
  goalLog('TURN', `#${goal.turnsExecuted}/${cap}`, {
    status: goal.status,
    tokensUsed: goal.tokensUsed,
  })
  return goal.turnsExecuted
}

/**
 * Model reports a blocker. Immediate block if reason is empty (treated as
 * system block) is NOT done — empty still counts as an attempt. After
 * BLOCKED_CONSECUTIVE_THRESHOLD same-reason attempts → blocked.
 *
 * For forced immediate block (impossible objective), callers use markBlocked.
 */
export function recordBlockedAttempt(
  reason: string,
  sessionId?: string,
): { status: GoalStatus; attempts: number } | null {
  const id = resolveSessionId(sessionId)
  const goal = goals.get(id)
  if (!goal || goal.status !== 'active') return null
  const normalised = reason.trim().toLowerCase()
  if (
    goal.lastBlockReason !== null &&
    goal.lastBlockReason.trim().toLowerCase() !== normalised
  ) {
    goal.blockedAttempts = 0
  }
  goal.lastBlockReason = reason
  goal.blockedAttempts += 1
  goal.updatedAt = Date.now()
  if (goal.blockedAttempts >= BLOCKED_CONSECUTIVE_THRESHOLD) {
    markBlocked(reason, sessionId)
    goalLog('BLOCKED', `3-strike reached! reason="${normalised}"`)
  } else {
    goalLog(
      'BLOCK_ATTEMPT',
      `attempt ${goal.blockedAttempts}/${BLOCKED_CONSECUTIVE_THRESHOLD} reason="${normalised}"`,
    )
  }
  return { status: getGoal(sessionId)!.status, attempts: goal.blockedAttempts }
}

export function getActiveElapsedMs(goal: GoalState): number {
  const ongoing =
    goal.status === 'active' && goal.pausedAt === null
      ? Date.now() - goal.startTime
      : 0
  return goal.accumulatedActiveMs + ongoing
}

/** Test-only: wipe the in-memory map without touching disk. */
export function _clearAllGoalsForTesting(): void {
  goals.clear()
}

/**
 * Hydrate in-memory map from persisted state.
 * Always demotes active → paused (process restart cannot still be running).
 * Stray complete is dropped.
 */
export function _setGoalFromPersistedState(
  state: GoalState,
  sessionId?: string,
): void {
  const normalized = normalizeGoalState(state)
  if (normalized.status === 'complete') {
    goalLog('HYDRATE', 'dropping transient complete goal')
    return
  }
  if (normalized.status === 'active') {
    const now = Date.now()
    foldActiveInterval(normalized, now)
    normalized.status = 'paused'
    normalized.pausedAt = now
    normalized.terminalReason =
      normalized.terminalReason ?? 'Paused after session resume'
    normalized.updatedAt = now
    goalLog('HYDRATE', 'demoted active → paused after resume')
  }
  goals.set(resolveSessionId(sessionId), normalized)
}

export function formatGoalElapsed(goal: GoalState): string {
  const elapsedMs = getActiveElapsedMs(goal)
  const seconds = Math.floor(elapsedMs / 1000)
  const minutes = Math.floor(seconds / 60)
  if (minutes === 0) return `${seconds}s`
  return `${minutes}m ${seconds % 60}s`
}

export function formatGoalStatusLabel(status: GoalStatus): string {
  switch (status) {
    case 'active':
      return 'Active'
    case 'paused':
      return 'Paused'
    case 'blocked':
      return 'Blocked'
    case 'complete':
      return 'Complete'
  }
}
