/**
 * Pure goal runtime helpers (park-on-error + continuation evaluate).
 * Hosts (REPL hook, later headless) own enqueue/UI; this module owns decisions.
 */
import type { GoalState } from '../../types/logs.js'
import {
  checkBudgets,
  getGoal,
  incrementGoalTurns,
  markGoalMaxTurnsReached,
  markUsageLimited,
  MAX_GOAL_TURNS,
  pauseActiveGoal,
} from './goalState.js'
import { buildBudgetLimitPrompt, buildContinuationPrompt } from './prompts.js'

export type GoalParkKind = 'rate_limit' | 'connectivity' | 'none'

export type ParkGoalOnErrorInput = {
  errorCode?: string | null
  messageText?: string | null
  sessionId?: string
}

export type ParkGoalOnErrorResult = {
  parked: boolean
  kind: GoalParkKind
  goal: GoalState | null
  /** User-facing notification when parked===true (caller shows once). */
  notification?: { key: string; text: string }
}

function classifyTransportError(
  errorCode?: string | null,
  messageText?: string | null,
): GoalParkKind {
  const code = (errorCode ?? '').toLowerCase()
  const text = (messageText ?? '').toLowerCase()

  const isRateLimit =
    code === 'rate_limit' ||
    text.includes('rate limit') ||
    text.includes('usage limit') ||
    text.includes('overloaded')

  const isConnectivity =
    text.includes('connection error') ||
    text.includes('fetch failed') ||
    text.includes('network error') ||
    text.includes('enotfound') ||
    text.includes('econnreset') ||
    text.includes('etimedout')

  // Match prior REPL: rate_limit only when exclusive; both → connectivity pause.
  if (isRateLimit && !isConnectivity) return 'rate_limit'
  if (isConnectivity) return 'connectivity'
  return 'none'
}

/**
 * Map transport failures to goal parking. No-op when goal missing/not active
 * or kind is unrecognized (unknown API errors must not pause).
 */
export function parkGoalOnTransportError(
  input: ParkGoalOnErrorInput,
): ParkGoalOnErrorResult {
  const kind = classifyTransportError(input.errorCode, input.messageText)
  if (kind === 'none') {
    return { parked: false, kind, goal: getGoal(input.sessionId) }
  }

  const before = getGoal(input.sessionId)
  if (!before || before.status !== 'active') {
    return { parked: false, kind, goal: before }
  }

  const goal =
    kind === 'rate_limit'
      ? markUsageLimited(input.sessionId)
      : pauseActiveGoal('Paused after connection error', input.sessionId)

  if (!goal) {
    return { parked: false, kind, goal: getGoal(input.sessionId) }
  }

  const notification =
    kind === 'rate_limit'
      ? {
          key: 'goal-auto-paused-usage-limit',
          text: 'Rate/usage limit hit. Active goal was auto-paused. Run /goal resume when limits reset.',
        }
      : {
          key: 'goal-auto-paused-connectivity-error',
          text: 'Detected connection error. Active goal was auto-paused. Run /goal resume after network recovers.',
        }

  return { parked: true, kind, goal, notification }
}

export function isBudgetBlockReason(
  reason: string | null | undefined,
): boolean {
  if (!reason) return false
  return (
    reason.includes('Token budget reached') ||
    reason.includes('Turn budget reached') ||
    reason.includes('Max continuation turns') ||
    reason.includes('Wall-clock budget reached')
  )
}

export type EvaluateGoalContinuationInput = {
  isLoading: boolean
  wasAborted: boolean
  hasActiveLocalJsxUI: boolean
  isInPlanMode: boolean
  isQueryActiveNow?: boolean
  queueLength: number
  /** When true, skip budget wrap-up enqueue (already fired this block). */
  budgetLimitAlreadyFired?: boolean
  sessionId?: string
}

export type EvaluateGoalContinuationResult =
  | { action: 'none'; reason?: string }
  | {
      action: 'continue'
      prompt: string
      turns: number
      objective: string
      goal: GoalState
    }
  | {
      action: 'budget_wrapup'
      prompt: string
      goal: GoalState
      fireMaxTurnsCallback: boolean
    }

/**
 * Pure-ish continuation decision. Mutates goal state via existing helpers
 * (budget check / turn increment) when action is continue/budget_wrapup.
 * Caller persists + enqueues.
 */
export function evaluateGoalContinuation(
  input: EvaluateGoalContinuationInput,
): EvaluateGoalContinuationResult {
  if (input.isLoading) return { action: 'none', reason: 'loading' }
  if (input.isQueryActiveNow) return { action: 'none', reason: 'query_active' }
  if (input.wasAborted) return { action: 'none', reason: 'aborted' }
  if (input.queueLength > 0) return { action: 'none', reason: 'queue' }
  if (input.hasActiveLocalJsxUI) return { action: 'none', reason: 'local_jsx' }
  if (input.isInPlanMode) return { action: 'none', reason: 'plan_mode' }

  let goal = getGoal(input.sessionId)
  if (!goal) return { action: 'none', reason: 'no_goal' }

  if (goal.status === 'active') {
    const blocked = checkBudgets(input.sessionId)
    if (blocked) goal = blocked
  }

  if (
    goal.status === 'blocked' &&
    isBudgetBlockReason(goal.terminalReason) &&
    !input.budgetLimitAlreadyFired
  ) {
    return {
      action: 'budget_wrapup',
      prompt: buildBudgetLimitPrompt(goal),
      goal,
      fireMaxTurnsCallback: true,
    }
  }

  if (goal.status !== 'active') {
    return { action: 'none', reason: `status_${goal.status}` }
  }

  const cap = goal.turnBudget ?? MAX_GOAL_TURNS
  if (goal.turnsExecuted >= cap) {
    const marked = markGoalMaxTurnsReached(input.sessionId)
    if (marked && !input.budgetLimitAlreadyFired) {
      return {
        action: 'budget_wrapup',
        prompt: buildBudgetLimitPrompt(marked),
        goal: marked,
        fireMaxTurnsCallback: true,
      }
    }
    return { action: 'none', reason: 'turn_cap' }
  }

  const turns = incrementGoalTurns(input.sessionId)
  const afterTurn = checkBudgets(input.sessionId)
  if (afterTurn?.status === 'blocked') {
    if (
      isBudgetBlockReason(afterTurn.terminalReason) &&
      !input.budgetLimitAlreadyFired
    ) {
      return {
        action: 'budget_wrapup',
        prompt: buildBudgetLimitPrompt(afterTurn),
        goal: afterTurn,
        fireMaxTurnsCallback: true,
      }
    }
    return { action: 'none', reason: 'budget_after_turn' }
  }

  const live = getGoal(input.sessionId) ?? goal
  return {
    action: 'continue',
    prompt: buildContinuationPrompt(live),
    turns,
    objective: live.objective,
    goal: live,
  }
}
