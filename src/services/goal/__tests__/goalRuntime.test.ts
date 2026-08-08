/**
 * Unit tests for parkGoalOnTransportError + evaluateGoalContinuation.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

import { logMock } from '../../../../tests/mocks/log.js'
mock.module('src/utils/log.ts', logMock)

import {
  evaluateGoalContinuation,
  parkGoalOnTransportError,
} from '../goalRuntime.js'
import {
  _clearAllGoalsForTesting,
  getGoal,
  setGoal,
  updateGoalTokens,
} from '../goalState.js'

const SESSION = 'goal-runtime-test-session'

function mustSet(objective: string, options?: Parameters<typeof setGoal>[1]) {
  const r = setGoal(objective, { sessionId: SESSION, ...options })
  if (!r.ok) throw new Error(r.message)
  return r.goal
}

beforeEach(() => {
  _clearAllGoalsForTesting()
})

describe('parkGoalOnTransportError', () => {
  test('rate_limit code → usage limited pause + notification', () => {
    mustSet('x')
    const r = parkGoalOnTransportError({
      errorCode: 'rate_limit',
      messageText: 'something failed',
      sessionId: SESSION,
    })
    expect(r.parked).toBe(true)
    expect(r.kind).toBe('rate_limit')
    expect(r.goal?.status).toBe('paused')
    expect(r.goal?.terminalReason).toContain('usage/rate limit')
    expect(r.notification?.key).toBe('goal-auto-paused-usage-limit')
  })

  test('usage limit text → rate_limit', () => {
    mustSet('x')
    const r = parkGoalOnTransportError({
      messageText: 'You hit a usage limit',
      sessionId: SESSION,
    })
    expect(r.parked).toBe(true)
    expect(r.kind).toBe('rate_limit')
  })

  test('connectivity text → pause after connection error', () => {
    mustSet('x')
    const r = parkGoalOnTransportError({
      messageText: 'Connection error: fetch failed',
      sessionId: SESSION,
    })
    expect(r.parked).toBe(true)
    expect(r.kind).toBe('connectivity')
    expect(r.goal?.terminalReason).toContain('connection error')
    expect(r.notification?.key).toBe('goal-auto-paused-connectivity-error')
  })

  test('both rate+connectivity prefers connectivity (prior REPL)', () => {
    mustSet('x')
    const r = parkGoalOnTransportError({
      errorCode: 'rate_limit',
      messageText: 'connection error and rate limit',
      sessionId: SESSION,
    })
    expect(r.parked).toBe(true)
    expect(r.kind).toBe('connectivity')
  })

  test('unknown API error does not park', () => {
    mustSet('x')
    const r = parkGoalOnTransportError({
      messageText: 'invalid request: bad schema',
      sessionId: SESSION,
    })
    expect(r.parked).toBe(false)
    expect(r.kind).toBe('none')
    expect(getGoal(SESSION)?.status).toBe('active')
  })

  test('no-op when goal missing or not active', () => {
    const missing = parkGoalOnTransportError({
      errorCode: 'rate_limit',
      sessionId: SESSION,
    })
    expect(missing.parked).toBe(false)

    mustSet('x')
    parkGoalOnTransportError({ errorCode: 'rate_limit', sessionId: SESSION })
    const again = parkGoalOnTransportError({
      errorCode: 'rate_limit',
      sessionId: SESSION,
    })
    expect(again.parked).toBe(false)
    expect(getGoal(SESSION)?.status).toBe('paused')
  })
})

describe('evaluateGoalContinuation', () => {
  const idle = {
    isLoading: false,
    wasAborted: false,
    hasActiveLocalJsxUI: false,
    isInPlanMode: false,
    queueLength: 0,
    sessionId: SESSION,
  }

  test('active + idle → continue and increments turns', () => {
    mustSet('ship feature')
    const r = evaluateGoalContinuation(idle)
    expect(r.action).toBe('continue')
    if (r.action === 'continue') {
      expect(r.turns).toBe(1)
      expect(r.prompt).toContain('untrusted_objective')
      expect(r.objective).toBe('ship feature')
    }
    expect(getGoal(SESSION)?.turnsExecuted).toBe(1)
  })

  test('aborted / planMode / queue → none', () => {
    mustSet('x')
    expect(evaluateGoalContinuation({ ...idle, wasAborted: true }).action).toBe(
      'none',
    )
    expect(
      evaluateGoalContinuation({ ...idle, isInPlanMode: true }).action,
    ).toBe('none')
    expect(evaluateGoalContinuation({ ...idle, queueLength: 1 }).action).toBe(
      'none',
    )
  })

  test('token budget → budget_wrapup', () => {
    mustSet('x', { tokenBudget: 10 })
    updateGoalTokens(10, SESSION)
    const r = evaluateGoalContinuation(idle)
    expect(r.action).toBe('budget_wrapup')
    if (r.action === 'budget_wrapup') {
      expect(r.prompt).toContain('budget_limit')
      expect(r.fireMaxTurnsCallback).toBe(true)
    }
    expect(getGoal(SESSION)?.status).toBe('blocked')
  })

  test('budget wrap-up skipped when already fired', () => {
    mustSet('x', { tokenBudget: 10 })
    updateGoalTokens(10, SESSION)
    evaluateGoalContinuation(idle)
    const r = evaluateGoalContinuation({
      ...idle,
      budgetLimitAlreadyFired: true,
    })
    expect(r.action).toBe('none')
  })
})
