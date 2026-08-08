/**
 * Unit tests for the per-session goal state machine (closed-loop).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

import { logMock } from '../../../../tests/mocks/log.js'
mock.module('src/utils/log.ts', logMock)

import {
  _clearAllGoalsForTesting,
  _setGoalFromPersistedState,
  BLOCKED_CONSECUTIVE_THRESHOLD,
  checkBudgets,
  continueGoalFromMaxTurns,
  clearGoal,
  completeGoal,
  formatGoalElapsed,
  formatGoalStatusLabel,
  getActiveElapsedMs,
  getGoal,
  incrementGoalTurns,
  markBlocked,
  markUsageLimited,
  markGoalMaxTurnsReached,
  maxBudgetFraction,
  MAX_GOAL_TURNS,
  normalizeGoalState,
  pauseGoal,
  recordBlockedAttempt,
  resumeGoal,
  setGoal,
  setGoalBudgets,
  updateGoalTokens,
} from '../goalState.js'
import type { GoalState } from '../../../types/logs.js'

const SESSION = 'test-session-id'

function mustSet(
  objective: string,
  options?: Parameters<typeof setGoal>[1],
): GoalState {
  const r = setGoal(objective, { sessionId: SESSION, ...options })
  if (!r.ok) throw new Error(r.message)
  return r.goal
}

beforeEach(() => {
  _clearAllGoalsForTesting()
})

describe('setGoal — creates an active goal with sane defaults', () => {
  test('initial state has status active, zero tokens, no budget by default', () => {
    const g = mustSet('improve test coverage')
    expect(g.status).toBe('active')
    expect(g.objective).toBe('improve test coverage')
    expect(g.tokensUsed).toBe(0)
    expect(g.tokenBudget).toBeNull()
    expect(g.turnBudget).toBeNull()
    expect(g.wallClockBudgetMs).toBeNull()
    expect(g.blockedAttempts).toBe(0)
    expect(g.turnsExecuted).toBe(0)
    expect(g.terminalReason).toBeNull()
  })

  test('accepts a positive integer token budget', () => {
    const g = mustSet('x', { tokenBudget: 5000 })
    expect(g.tokenBudget).toBe(5000)
  })

  test('rejects non-finite or negative budgets as null', () => {
    expect(mustSet('a', { tokenBudget: Number.NaN }).tokenBudget).toBeNull()
    expect(
      mustSet('a', { tokenBudget: -1, replace: true }).tokenBudget,
    ).toBeNull()
    expect(
      mustSet('a', { tokenBudget: Infinity, replace: true }).tokenBudget,
    ).toBeNull()
  })

  test('refuses silent overwrite without replace', () => {
    mustSet('first', { tokenBudget: 100 })
    updateGoalTokens(50, SESSION)
    const r = setGoal('second', { sessionId: SESSION })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('exists')
    expect(getGoal(SESSION)?.objective).toBe('first')
    expect(getGoal(SESSION)?.tokensUsed).toBe(50)
  })

  test('replace:true overwrites existing goal', () => {
    mustSet('first', { tokenBudget: 100 })
    updateGoalTokens(50, SESSION)
    const g = mustSet('second', { replace: true })
    expect(g.objective).toBe('second')
    expect(g.tokensUsed).toBe(0)
    expect(g.tokenBudget).toBeNull()
  })

  test('rejects empty / too long objective', () => {
    expect(setGoal('   ', { sessionId: SESSION }).ok).toBe(false)
    expect(setGoal('x'.repeat(4001), { sessionId: SESSION }).ok).toBe(false)
  })
})

describe('pause / resume — preserves active elapsed time', () => {
  test('pause then resume keeps accumulated active time', async () => {
    mustSet('x')
    await Bun.sleep(10)
    const paused = pauseGoal(SESSION)
    expect(paused?.status).toBe('paused')
    expect(paused?.accumulatedActiveMs).toBeGreaterThanOrEqual(10)

    const before = paused?.accumulatedActiveMs ?? 0
    await Bun.sleep(20)
    const resumed = resumeGoal(SESSION)
    expect(resumed?.status).toBe('active')
    expect(resumed?.accumulatedActiveMs).toBe(before)
    expect(resumed?.terminalReason).toBeNull()
  })

  test('pause is a no-op on a non-active goal', () => {
    mustSet('x')
    pauseGoal(SESSION)
    const second = pauseGoal(SESSION)
    expect(second).toBeNull()
  })

  test('resume is a no-op on an active goal', () => {
    mustSet('x')
    expect(resumeGoal(SESSION)).toBeNull()
  })

  test('resume works from blocked', () => {
    mustSet('x')
    markBlocked('stuck', SESSION)
    expect(getGoal(SESSION)?.status).toBe('blocked')
    const resumed = resumeGoal(SESSION)
    expect(resumed?.status).toBe('active')
    expect(resumed?.blockedAttempts).toBe(0)
    expect(resumed?.terminalReason).toBeNull()
  })

  test('getActiveElapsedMs while active includes ongoing interval', async () => {
    mustSet('x')
    await Bun.sleep(10)
    const g = getGoal(SESSION)!
    expect(getActiveElapsedMs(g)).toBeGreaterThanOrEqual(10)
  })

  test('getActiveElapsedMs while paused freezes at accumulated total', async () => {
    mustSet('x')
    await Bun.sleep(10)
    pauseGoal(SESSION)
    const g = getGoal(SESSION)!
    const a = getActiveElapsedMs(g)
    await Bun.sleep(20)
    const b = getActiveElapsedMs(g)
    expect(b).toBe(a)
  })
})

describe('updateGoalTokens — accumulates and hard-stops as blocked', () => {
  test('accumulates positive deltas', () => {
    mustSet('x', { tokenBudget: 1000 })
    updateGoalTokens(100, SESSION)
    updateGoalTokens(200, SESSION)
    expect(getGoal(SESSION)?.tokensUsed).toBe(300)
  })

  test('crossing budget transitions to blocked', () => {
    mustSet('x', { tokenBudget: 100 })
    updateGoalTokens(150, SESSION)
    const g = getGoal(SESSION)
    expect(g?.status).toBe('blocked')
    expect(g?.terminalReason).toContain('Token budget reached')
  })

  test('further updates after blocked are no-ops (status-guarded)', () => {
    mustSet('x', { tokenBudget: 100 })
    updateGoalTokens(150, SESSION)
    updateGoalTokens(50, SESSION)
    expect(getGoal(SESSION)?.tokensUsed).toBe(150)
  })

  test('coerces non-finite or negative deltas to zero', () => {
    mustSet('x', { tokenBudget: 1000 })
    updateGoalTokens(Number.NaN, SESSION)
    updateGoalTokens(-100, SESSION)
    updateGoalTokens(Infinity, SESSION)
    expect(getGoal(SESSION)?.tokensUsed).toBe(0)
  })

  test('no-op when there is no goal', () => {
    expect(updateGoalTokens(100, SESSION)).toBeNull()
  })
})

describe('recordBlockedAttempt — 3-consecutive-attempts audit', () => {
  test('first attempt records but stays active', () => {
    mustSet('x')
    const r = recordBlockedAttempt('compile error', SESSION)
    expect(r?.status).toBe('active')
    expect(r?.attempts).toBe(1)
  })

  test('three same-reason attempts in a row flip to blocked', () => {
    mustSet('x')
    recordBlockedAttempt('compile error', SESSION)
    recordBlockedAttempt('compile error', SESSION)
    const r = recordBlockedAttempt('compile error', SESSION)
    expect(r?.status).toBe('blocked')
    expect(r?.attempts).toBe(BLOCKED_CONSECUTIVE_THRESHOLD)
  })

  test('different reason resets counter', () => {
    mustSet('x')
    recordBlockedAttempt('A', SESSION)
    recordBlockedAttempt('A', SESSION)
    const r = recordBlockedAttempt('B', SESSION)
    expect(r?.status).toBe('active')
    expect(r?.attempts).toBe(1)
  })

  test('case-insensitive comparison', () => {
    mustSet('x')
    recordBlockedAttempt('compile error', SESSION)
    recordBlockedAttempt('Compile Error', SESSION)
    const r = recordBlockedAttempt('COMPILE ERROR', SESSION)
    expect(r?.status).toBe('blocked')
  })

  test('resume resets blocked attempts', () => {
    mustSet('x')
    recordBlockedAttempt('oops', SESSION)
    recordBlockedAttempt('oops', SESSION)
    pauseGoal(SESSION)
    resumeGoal(SESSION)
    expect(getGoal(SESSION)!.blockedAttempts).toBe(0)
  })

  test('markBlocked immediate skip strikes', () => {
    mustSet('x')
    markBlocked('impossible objective', SESSION)
    expect(getGoal(SESSION)?.status).toBe('blocked')
    expect(getGoal(SESSION)?.terminalReason).toBe('impossible objective')
  })
})

describe('completeGoal / clearGoal / markUsageLimited', () => {
  test('completeGoal transitions to complete only from active', () => {
    mustSet('x')
    const g = completeGoal(SESSION, 'done')
    expect(g?.status).toBe('complete')
    expect(g?.terminalReason).toBe('done')
  })

  test('completeGoal no-ops when not active', () => {
    mustSet('x')
    pauseGoal(SESSION)
    expect(completeGoal(SESSION)).toBeNull()
  })

  test('clearGoal removes entirely', () => {
    mustSet('x')
    expect(clearGoal(SESSION)).toBe(true)
    expect(getGoal(SESSION)).toBeNull()
  })

  test('markUsageLimited transitions active → paused', () => {
    mustSet('x')
    markUsageLimited(SESSION)
    const g = getGoal(SESSION)
    expect(g?.status).toBe('paused')
    expect(g?.terminalReason).toContain('usage/rate limit')
  })
})

describe('incrementGoalTurns', () => {
  test('counts correctly while active', () => {
    mustSet('x')
    expect(incrementGoalTurns(SESSION)).toBe(1)
    expect(incrementGoalTurns(SESSION)).toBe(2)
    expect(getGoal(SESSION)?.turnsExecuted).toBe(2)
  })

  test('returns 0 when no goal', () => {
    expect(incrementGoalTurns(SESSION)).toBe(0)
  })
})

describe('turn budget / max turns lifecycle', () => {
  test('markGoalMaxTurnsReached flips to blocked once cap is reached', () => {
    mustSet('x')
    const goal = getGoal(SESSION)!
    goal.turnsExecuted = MAX_GOAL_TURNS
    const marked = markGoalMaxTurnsReached(SESSION)
    expect(marked?.status).toBe('blocked')
    expect(marked?.terminalReason).toContain('Max continuation turns')
  })

  test('continueGoalFromMaxTurns resets turns and re-activates goal', () => {
    mustSet('x')
    const goal = getGoal(SESSION)!
    goal.turnsExecuted = MAX_GOAL_TURNS
    markGoalMaxTurnsReached(SESSION)
    const resumed = continueGoalFromMaxTurns(SESSION)
    expect(resumed?.status).toBe('active')
    expect(resumed?.turnsExecuted).toBe(0)
  })

  test('explicit turnBudget hard-stops via checkBudgets', () => {
    mustSet('x', { turnBudget: 2 })
    incrementGoalTurns(SESSION)
    incrementGoalTurns(SESSION)
    const blocked = checkBudgets(SESSION)
    expect(blocked?.status).toBe('blocked')
    expect(blocked?.terminalReason).toContain('Turn budget reached')
  })
})

describe('hydrate / normalizeAfterReplay', () => {
  test('active demotes to paused on hydrate', () => {
    const raw = mustSet('persist me')
    _clearAllGoalsForTesting()
    _setGoalFromPersistedState(raw, SESSION)
    const g = getGoal(SESSION)
    expect(g?.status).toBe('paused')
    expect(g?.terminalReason).toContain('session resume')
  })

  test('paused and blocked preserved', () => {
    mustSet('x')
    pauseGoal(SESSION, 'user pause')
    const paused = { ...getGoal(SESSION)! }
    _clearAllGoalsForTesting()
    _setGoalFromPersistedState(paused, SESSION)
    expect(getGoal(SESSION)?.status).toBe('paused')

    mustSet('y', { replace: true })
    markBlocked('no pe', SESSION)
    const blocked = { ...getGoal(SESSION)! }
    _clearAllGoalsForTesting()
    _setGoalFromPersistedState(blocked, SESSION)
    expect(getGoal(SESSION)?.status).toBe('blocked')
  })

  test('legacy statuses map into closed-loop set', () => {
    const legacy = {
      objective: 'old',
      status: 'budget_limited',
      tokenBudget: 10,
      tokensUsed: 12,
      startTime: 1,
      pausedAt: null,
      accumulatedActiveMs: 0,
      blockedAttempts: 0,
      lastBlockReason: null,
      createdAt: 1,
      updatedAt: 1,
      turnsExecuted: 1,
    } as unknown as GoalState
    const n = normalizeGoalState(legacy)
    expect(n.status).toBe('blocked')
    expect(n.terminalReason).toContain('Token budget')
    expect(n.turnBudget).toBeNull()
    expect(n.wallClockBudgetMs).toBeNull()
    expect(n.terminalReason).not.toBeNull()
  })

  test('complete is dropped on hydrate', () => {
    mustSet('x')
    completeGoal(SESSION)
    const done = { ...getGoal(SESSION)! }
    _clearAllGoalsForTesting()
    _setGoalFromPersistedState(done, SESSION)
    expect(getGoal(SESSION)).toBeNull()
  })
})

describe('budget helpers', () => {
  test('setGoalBudgets updates limits', () => {
    mustSet('x')
    setGoalBudgets({ tokenBudget: 500, turnBudget: 10 }, SESSION)
    const g = getGoal(SESSION)!
    expect(g.tokenBudget).toBe(500)
    expect(g.turnBudget).toBe(10)
  })

  test('maxBudgetFraction reflects usage', () => {
    mustSet('x', { tokenBudget: 100 })
    updateGoalTokens(50, SESSION)
    expect(maxBudgetFraction(getGoal(SESSION)!)).toBeGreaterThanOrEqual(0.5)
  })
})

describe('formatGoalStatusLabel', () => {
  test('returns human-readable labels', () => {
    expect(formatGoalStatusLabel('active')).toBe('Active')
    expect(formatGoalStatusLabel('paused')).toBe('Paused')
    expect(formatGoalStatusLabel('blocked')).toBe('Blocked')
    expect(formatGoalStatusLabel('complete')).toBe('Complete')
  })
})

describe('formatGoalElapsed', () => {
  test('returns "0s" for brand-new goals', () => {
    const g = mustSet('x')
    expect(formatGoalElapsed(g)).toBe('0s')
  })
})

describe('completionCriterion', () => {
  test('setGoal stores trimmed criterion; empty becomes null', () => {
    const g = mustSet('x', { completionCriterion: '  all tests pass  ' })
    expect(g.completionCriterion).toBe('all tests pass')
    const g2 = mustSet('y', { replace: true, completionCriterion: '   ' })
    expect(g2.completionCriterion).toBeNull()
  })

  test('over-long criterion is truncated, not rejected', () => {
    const long = 'c'.repeat(5000)
    const g = mustSet('x', { completionCriterion: long })
    expect(g.completionCriterion?.length).toBe(4000)
  })

  test('normalize fills null for legacy objects missing field', () => {
    const legacy = {
      objective: 'old',
      status: 'active',
      tokenBudget: null,
      turnBudget: null,
      wallClockBudgetMs: null,
      tokensUsed: 0,
      startTime: 1,
      pausedAt: null,
      accumulatedActiveMs: 0,
      blockedAttempts: 0,
      lastBlockReason: null,
      terminalReason: null,
      createdAt: 1,
      updatedAt: 1,
      turnsExecuted: 0,
    } as unknown as GoalState
    const n = normalizeGoalState(legacy)
    expect(n.completionCriterion).toBeNull()
  })
})
