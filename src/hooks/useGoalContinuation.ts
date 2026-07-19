/**
 * useGoalContinuation — React hook that drives the auto-continuation
 * loop for the `/goal` feature.
 *
 * Mounted inside REPL.tsx when feature('GOAL') is enabled. After each
 * turn completes (queryGuard transitions to idle), checks whether the
 * active goal should trigger another turn:
 *
 *   1. GOAL feature flag enabled
 *   2. Goal exists and status === 'active'
 *   3. Query just finished (isLoading transitioned false)
 *   4. No active local-JSX UI (modal dialog)
 *   5. Not in plan mode
 *   6. Budgets not exhausted (token / turn / wall-clock)
 *   7. No user messages in the queue (user input always takes priority)
 *
 * Budget hard-stops mark the goal blocked and enqueue one wrap-up prompt.
 * Aborted turns do not auto-continue (caller should pause separately).
 */
import { useLayoutEffect, useRef } from 'react'

import { logForDebugging } from 'src/utils/debug.js'
import {
  checkBudgets,
  getGoal,
  incrementGoalTurns,
  markGoalMaxTurnsReached,
  MAX_GOAL_TURNS,
} from 'src/services/goal/goalState.js'
import { persistCurrentGoal } from 'src/services/goal/goalStorage.js'
import {
  buildBudgetLimitPrompt,
  buildContinuationPrompt,
} from 'src/services/goal/prompts.js'
import {
  enqueue,
  getCommandQueueSnapshot,
} from 'src/utils/messageQueueManager.js'

function hookLog(msg: string): void {
  logForDebugging(`[goal] hook: ${msg}`)
}

export type UseGoalContinuationOpts = {
  isLoading: boolean
  wasAborted: boolean
  queuedCommandsLength: number
  hasActiveLocalJsxUI: boolean
  isInPlanMode: boolean
  isQueryActiveNow?: () => boolean
  onMaxTurnsReached?: () => void
  onContinuationEnqueued?: (payload: {
    turn: number
    objective: string
  }) => void
}

function isBudgetBlockReason(reason: string | null | undefined): boolean {
  if (!reason) return false
  return (
    reason.includes('Token budget reached') ||
    reason.includes('Turn budget reached') ||
    reason.includes('Max continuation turns') ||
    reason.includes('Wall-clock budget reached')
  )
}

export function useGoalContinuation(opts: UseGoalContinuationOpts): void {
  const optsRef = useRef(opts)
  optsRef.current = opts

  // Track whether we already enqueued for the current idle window.
  // Reset to false every time isLoading becomes true (new turn starts).
  const enqueuedRef = useRef(false)
  // Fire budget wrap-up prompt exactly once per block transition.
  const budgetLimitFiredRef = useRef(false)

  useLayoutEffect(() => {
    if (opts.isLoading) {
      enqueuedRef.current = false
      return
    }

    if (opts.isQueryActiveNow?.()) {
      hookLog('skip: queryActiveNow=true')
      return
    }

    // Codex/kimi parity: continuation only after normal completion.
    if (opts.wasAborted) {
      hookLog('skip: wasAborted=true')
      return
    }

    if (enqueuedRef.current) return

    const liveQueueLength = getCommandQueueSnapshot().length
    if (liveQueueLength > 0) {
      hookLog('skip: yielding to queued user messages')
      return
    }
    if (opts.hasActiveLocalJsxUI) {
      hookLog('skip: activeLocalJsxUI')
      return
    }
    if (opts.isInPlanMode) {
      hookLog('skip: planMode')
      return
    }

    let goal = getGoal()
    if (!goal) {
      budgetLimitFiredRef.current = false
      return
    }
    if (goal.status === 'active') {
      budgetLimitFiredRef.current = false
    }

    // Hard budget check before enqueuing the next turn.
    if (goal.status === 'active') {
      const blocked = checkBudgets()
      if (blocked) {
        persistCurrentGoal()
        goal = blocked
        if (isBudgetBlockReason(blocked.terminalReason)) {
          opts.onMaxTurnsReached?.()
        }
      }
    }

    // Budget/turn/wall blocked: one wrap-up prompt, then stop.
    if (
      goal.status === 'blocked' &&
      isBudgetBlockReason(goal.terminalReason) &&
      !budgetLimitFiredRef.current
    ) {
      budgetLimitFiredRef.current = true
      enqueuedRef.current = true
      const prompt = buildBudgetLimitPrompt(goal)
      logForDebugging(
        '[goal] hook: budget/turn limit reached, injecting wrap-up prompt',
      )
      enqueue({
        value: prompt,
        mode: 'prompt',
        priority: 'now',
        isMeta: true,
        origin: 'goal-budget-limit',
        skipSlashCommands: true,
      })
      return
    }

    if (goal.status !== 'active') {
      hookLog(`skip: status="${goal.status}" (not active)`)
      return
    }

    const cap = goal.turnBudget ?? MAX_GOAL_TURNS
    if (goal.turnsExecuted >= cap) {
      const marked = markGoalMaxTurnsReached()
      if (marked) {
        persistCurrentGoal()
        opts.onMaxTurnsReached?.()
        if (!budgetLimitFiredRef.current) {
          budgetLimitFiredRef.current = true
          enqueuedRef.current = true
          enqueue({
            value: buildBudgetLimitPrompt(marked),
            mode: 'prompt',
            priority: 'now',
            isMeta: true,
            origin: 'goal-budget-limit',
            skipSlashCommands: true,
          })
        }
      }
      logForDebugging(`[goal] hook: turn cap (${cap}) reached, stopping`)
      return
    }

    enqueuedRef.current = true

    const turns = incrementGoalTurns()
    // Re-check after increment (explicit turnBudget may trip now).
    const afterTurn = checkBudgets()
    if (afterTurn?.status === 'blocked') {
      persistCurrentGoal()
      if (
        isBudgetBlockReason(afterTurn.terminalReason) &&
        !budgetLimitFiredRef.current
      ) {
        budgetLimitFiredRef.current = true
        enqueue({
          value: buildBudgetLimitPrompt(afterTurn),
          mode: 'prompt',
          priority: 'now',
          isMeta: true,
          origin: 'goal-budget-limit',
          skipSlashCommands: true,
        })
      }
      opts.onMaxTurnsReached?.()
      return
    }
    persistCurrentGoal()

    const prompt = buildContinuationPrompt(getGoal() ?? goal)
    logForDebugging(
      `[goal] hook: enqueuing turn ${turns} for "${goal.objective.slice(0, 60)}"`,
    )

    enqueue({
      value: prompt,
      mode: 'prompt',
      priority: 'now',
      isMeta: true,
      origin: 'goal-continuation',
      skipSlashCommands: true,
    })
    opts.onContinuationEnqueued?.({
      turn: turns,
      objective: goal.objective,
    })
  }, [
    opts.isLoading,
    opts.wasAborted,
    opts.queuedCommandsLength,
    opts.hasActiveLocalJsxUI,
    opts.isInPlanMode,
  ])
}
