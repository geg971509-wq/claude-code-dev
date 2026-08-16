import { describe, expect, test } from 'bun:test'
import { checkTokenBudget, createBudgetTracker } from '../tokenBudget.js'

describe('checkTokenBudget', () => {
  test('continues while under 90% and not diminishing', () => {
    const tracker = createBudgetTracker()
    const decision = checkTokenBudget(tracker, undefined, 100_000, 600)
    expect(decision.action).toBe('continue')
    expect(tracker.continuationCount).toBe(1)
  })

  test('stops after MAX_CONTINUATIONS even when under budget', () => {
    const tracker = createBudgetTracker()
    const budget = 100_000
    let tokens = 0
    let last: ReturnType<typeof checkTokenBudget> | undefined
    for (let i = 0; i < 51; i++) {
      tokens += 600
      last = checkTokenBudget(tracker, undefined, budget, tokens)
    }
    expect(last?.action).toBe('stop')
    expect(tracker.continuationCount).toBe(50)
    if (last?.action === 'stop') {
      expect(last.completionEvent?.continuationCount).toBe(50)
      expect(last.completionEvent?.diminishingReturns).toBe(false)
    }
  })
})
