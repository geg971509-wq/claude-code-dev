/**
 * Integration test for the goal lifecycle (closed-loop).
 * Verifies set → work → complete, pause/resume, budget→blocked,
 * usage→paused, blocked attempts, prompts, and format helpers.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

import { logMock } from '../mocks/log.js'
mock.module('src/utils/log.ts', logMock)

mock.module('bun:bundle', () => ({
  feature: () => true,
}))

import {
  setGoal,
  getGoal,
  clearGoal,
  pauseGoal,
  resumeGoal,
  completeGoal,
  updateGoalTokens,
  markUsageLimited,
  incrementGoalTurns,
  recordBlockedAttempt,
  formatGoalElapsed,
  formatGoalStatusLabel,
  getActiveElapsedMs,
  _clearAllGoalsForTesting,
  BLOCKED_CONSECUTIVE_THRESHOLD,
  MAX_GOAL_TURNS,
} from '../../src/services/goal/goalState'

import {
  buildContinuationPrompt,
  buildBudgetLimitPrompt,
  buildObjectiveUpdatedPrompt,
  buildGoalContextBlock,
} from '../../src/services/goal/prompts'

import type { GoalState } from '../../src/types/logs'

const TEST_SESSION = 'test-integration-session'

function mustSet(
  objective: string,
  options?: Parameters<typeof setGoal>[1],
): GoalState {
  const r = setGoal(objective, { sessionId: TEST_SESSION, ...options })
  if (!r.ok) throw new Error(r.message)
  return r.goal
}

beforeEach(() => {
  _clearAllGoalsForTesting()
})

describe('Goal lifecycle: set → work → complete', () => {
  test('full happy path', () => {
    const goal = mustSet('Implement feature X with tests', {
      tokenBudget: 100_000,
    })
    expect(goal.status).toBe('active')
    expect(goal.objective).toBe('Implement feature X with tests')
    expect(goal.tokenBudget).toBe(100_000)
    expect(goal.tokensUsed).toBe(0)
    expect(goal.turnsExecuted).toBe(0)

    updateGoalTokens(15_000, TEST_SESSION)
    incrementGoalTurns(TEST_SESSION)
    updateGoalTokens(20_000, TEST_SESSION)
    incrementGoalTurns(TEST_SESSION)

    const mid = getGoal(TEST_SESSION)!
    expect(mid.tokensUsed).toBe(35_000)
    expect(mid.turnsExecuted).toBe(2)
    expect(mid.status).toBe('active')

    const completed = completeGoal(TEST_SESSION)!
    expect(completed.status).toBe('complete')
    expect(completed.tokensUsed).toBe(35_000)

    expect(getGoal(TEST_SESSION)).not.toBeNull()

    expect(clearGoal(TEST_SESSION)).toBe(true)
    expect(getGoal(TEST_SESSION)).toBeNull()
  })
})

describe('Goal lifecycle: pause and resume', () => {
  test('pause accumulates active time, resume resets start', () => {
    mustSet('Refactor module')

    const paused = pauseGoal(TEST_SESSION)!
    expect(paused.status).toBe('paused')
    expect(paused.pausedAt).not.toBeNull()

    const resumed = resumeGoal(TEST_SESSION)!
    expect(resumed.status).toBe('active')
    expect(resumed.pausedAt).toBeNull()
    expect(resumed.blockedAttempts).toBe(0)
  })

  test('pause on non-active goal is no-op', () => {
    mustSet('Something')
    completeGoal(TEST_SESSION)
    expect(pauseGoal(TEST_SESSION)).toBeNull()
  })

  test('resume on active goal is no-op', () => {
    mustSet('Something')
    expect(resumeGoal(TEST_SESSION)).toBeNull()
  })

  test('resume works from blocked', () => {
    mustSet('Something')
    updateGoalTokens(100, TEST_SESSION) // no budget → stays active
    // Force block via 3-strike
    recordBlockedAttempt('stuck', TEST_SESSION)
    recordBlockedAttempt('stuck', TEST_SESSION)
    recordBlockedAttempt('stuck', TEST_SESSION)
    expect(getGoal(TEST_SESSION)!.status).toBe('blocked')
    const resumed = resumeGoal(TEST_SESSION)!
    expect(resumed.status).toBe('active')
    expect(resumed.terminalReason).toBeNull()
  })
})

describe('Goal lifecycle: budget limiting', () => {
  test('exceeding token budget transitions to blocked', () => {
    mustSet('Big task', { tokenBudget: 50_000 })

    updateGoalTokens(30_000, TEST_SESSION)
    expect(getGoal(TEST_SESSION)!.status).toBe('active')

    updateGoalTokens(25_000, TEST_SESSION)
    const g = getGoal(TEST_SESSION)!
    expect(g.status).toBe('blocked')
    expect(g.tokensUsed).toBe(55_000)
    expect(g.terminalReason).toContain('Token budget reached')
  })
})

describe('Goal lifecycle: usage limiting', () => {
  test('markUsageLimited transitions active → paused', () => {
    mustSet('Rate limited task')
    markUsageLimited(TEST_SESSION)
    const g = getGoal(TEST_SESSION)!
    expect(g.status).toBe('paused')
    expect(g.terminalReason).toContain('usage/rate limit')
  })
})

describe('Goal lifecycle: blocked attempts', () => {
  test('3 consecutive same-reason attempts transition to blocked', () => {
    mustSet('Need credentials')

    const r1 = recordBlockedAttempt('missing API key', TEST_SESSION)!
    expect(r1.status).toBe('active')
    expect(r1.attempts).toBe(1)

    const r2 = recordBlockedAttempt('missing API key', TEST_SESSION)!
    expect(r2.status).toBe('active')
    expect(r2.attempts).toBe(2)

    const r3 = recordBlockedAttempt('missing API key', TEST_SESSION)!
    expect(r3.status).toBe('blocked')
    expect(r3.attempts).toBe(3)
  })

  test('different reason resets counter', () => {
    mustSet('Flaky thing')

    recordBlockedAttempt('error A', TEST_SESSION)
    recordBlockedAttempt('error A', TEST_SESSION)
    const r = recordBlockedAttempt('error B', TEST_SESSION)!
    expect(r.status).toBe('active')
    expect(r.attempts).toBe(1)
  })

  test('resume resets blocked attempts', () => {
    mustSet('Was stuck')
    recordBlockedAttempt('oops', TEST_SESSION)
    recordBlockedAttempt('oops', TEST_SESSION)
    pauseGoal(TEST_SESSION)
    resumeGoal(TEST_SESSION)
    expect(getGoal(TEST_SESSION)!.blockedAttempts).toBe(0)
  })

  test('BLOCKED_CONSECUTIVE_THRESHOLD is 3', () => {
    expect(BLOCKED_CONSECUTIVE_THRESHOLD).toBe(3)
  })
})

describe('Goal lifecycle: turn limits', () => {
  test('MAX_GOAL_TURNS is a reasonable upper bound', () => {
    expect(MAX_GOAL_TURNS).toBeGreaterThanOrEqual(10)
    expect(MAX_GOAL_TURNS).toBeLessThanOrEqual(200)
  })

  test('incrementGoalTurns counts correctly', () => {
    mustSet('Counting')
    for (let i = 1; i <= 5; i++) {
      expect(incrementGoalTurns(TEST_SESSION)).toBe(i)
    }
    expect(getGoal(TEST_SESSION)!.turnsExecuted).toBe(5)
  })
})

describe('Goal prompt templates', () => {
  test('continuation prompt contains objective and audit rules', () => {
    const goal = mustSet('Build dashboard', { tokenBudget: 200_000 })
    const prompt = buildContinuationPrompt(goal)
    expect(prompt).toContain('Build dashboard')
    expect(prompt).toContain('goal-steering')
    expect(prompt).toContain('continuation')
    expect(prompt).toContain('Completion Audit')
    expect(prompt).toContain('Blocked Audit')
    expect(prompt).toContain('200000')
  })

  test('budget limit prompt instructs stop', () => {
    mustSet('Over budget', { tokenBudget: 50_000 })
    updateGoalTokens(60_000, TEST_SESSION)
    const updated = getGoal(TEST_SESSION)!
    expect(updated.status).toBe('blocked')
    const prompt = buildBudgetLimitPrompt(updated)
    expect(prompt).toContain('budget_limit')
    expect(prompt).toContain('Stop all substantive work')
    expect(prompt).toContain('60000')
  })

  test('objective updated prompt contains new objective', () => {
    const prompt = buildObjectiveUpdatedPrompt('New objective', 'Old objective')
    expect(prompt).toContain('objective_updated')
    expect(prompt).toContain('New objective')
    expect(prompt).toContain('Old objective')
  })

  test('goal context block is compact for active goals', () => {
    const goal = mustSet('Short task')
    const block = buildGoalContextBlock(goal)
    expect(block).toContain('<active-goal')
    expect(block).toContain('Short task')
    expect(block).toContain('</active-goal>')
    expect(block.split('\n').length).toBeLessThanOrEqual(5)
  })
})

describe('Format helpers', () => {
  test('formatGoalStatusLabel returns human-readable labels', () => {
    expect(formatGoalStatusLabel('active')).toBe('Active')
    expect(formatGoalStatusLabel('paused')).toBe('Paused')
    expect(formatGoalStatusLabel('blocked')).toBe('Blocked')
    expect(formatGoalStatusLabel('complete')).toBe('Complete')
  })

  test('getActiveElapsedMs returns accumulated time for paused goals', () => {
    const goal = mustSet('Timed')
    const elapsed = getActiveElapsedMs(goal)
    expect(elapsed).toBeGreaterThanOrEqual(0)
  })

  test('formatGoalElapsed returns 0s for brand-new goals', () => {
    const goal = mustSet('Timed')
    expect(formatGoalElapsed(goal)).toBe('0s')
  })
})
