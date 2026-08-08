/**
 * useGoalContinuation — thin React host for goal auto-continuation.
 *
 * Decision logic lives in `evaluateGoalContinuation` (goalRuntime).
 * This hook owns React timing + enqueue + persist + callbacks only.
 */
import { useLayoutEffect, useRef } from 'react'

import { logForDebugging } from 'src/utils/debug.js'
import { evaluateGoalContinuation } from 'src/services/goal/goalRuntime.js'
import { getGoal } from 'src/services/goal/goalState.js'
import { persistCurrentGoal } from 'src/services/goal/goalStorage.js'
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

    if (enqueuedRef.current) return

    // Mirror prior hook: no goal / active clears the once-per-block wrap-up latch.
    const pre = getGoal()
    if (!pre || pre.status === 'active') {
      budgetLimitFiredRef.current = false
    }

    const decision = evaluateGoalContinuation({
      isLoading: opts.isLoading,
      wasAborted: opts.wasAborted,
      hasActiveLocalJsxUI: opts.hasActiveLocalJsxUI,
      isInPlanMode: opts.isInPlanMode,
      isQueryActiveNow: opts.isQueryActiveNow?.(),
      queueLength: getCommandQueueSnapshot().length,
      budgetLimitAlreadyFired: budgetLimitFiredRef.current,
    })

    if (decision.action === 'none') {
      if (decision.reason) hookLog(`skip: ${decision.reason}`)
      return
    }

    if (decision.action === 'budget_wrapup') {
      budgetLimitFiredRef.current = true
      enqueuedRef.current = true
      persistCurrentGoal()
      if (decision.fireMaxTurnsCallback) {
        opts.onMaxTurnsReached?.()
      }
      logForDebugging(
        '[goal] hook: budget/turn limit reached, injecting wrap-up prompt',
      )
      enqueue({
        value: decision.prompt,
        mode: 'prompt',
        priority: 'now',
        isMeta: true,
        origin: 'goal-budget-limit',
        skipSlashCommands: true,
      })
      return
    }

    // continue
    enqueuedRef.current = true
    persistCurrentGoal()
    logForDebugging(
      `[goal] hook: enqueuing turn ${decision.turns} for "${decision.objective.slice(0, 60)}"`,
    )
    enqueue({
      value: decision.prompt,
      mode: 'prompt',
      priority: 'now',
      isMeta: true,
      origin: 'goal-continuation',
      skipSlashCommands: true,
    })
    opts.onContinuationEnqueued?.({
      turn: decision.turns,
      objective: decision.objective,
    })
  }, [
    opts.isLoading,
    opts.wasAborted,
    opts.queuedCommandsLength,
    opts.hasActiveLocalJsxUI,
    opts.isInPlanMode,
  ])
}
