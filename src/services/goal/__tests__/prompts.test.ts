import { describe, expect, mock, test } from 'bun:test'

import { logMock } from '../../../../tests/mocks/log.js'
mock.module('src/utils/log.ts', logMock)

import { buildContinuationPrompt, buildGoalContextBlock } from '../prompts.js'
import type { GoalState } from '../../../types/logs.js'

function baseGoal(over: Partial<GoalState> = {}): GoalState {
  return {
    objective: 'do the thing',
    status: 'active',
    completionCriterion: null,
    tokenBudget: null,
    turnBudget: null,
    wallClockBudgetMs: null,
    tokensUsed: 0,
    startTime: Date.now(),
    pausedAt: null,
    accumulatedActiveMs: 0,
    blockedAttempts: 0,
    lastBlockReason: null,
    terminalReason: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    turnsExecuted: 0,
    ...over,
  }
}

describe('goal prompts criterion injection', () => {
  test('continuation includes untrusted_completion_criterion when set', () => {
    const p = buildContinuationPrompt(
      baseGoal({ completionCriterion: 'tests green' }),
    )
    expect(p).toContain('<untrusted_completion_criterion>')
    expect(p).toContain('tests green')
  })

  test('context block includes criterion when set', () => {
    const p = buildGoalContextBlock(
      baseGoal({ completionCriterion: 'tests green' }),
    )
    expect(p).toContain('<untrusted_completion_criterion>')
    expect(p).toContain('tests green')
  })

  test('omits criterion tags when null', () => {
    const p = buildContinuationPrompt(baseGoal())
    expect(p).not.toContain('untrusted_completion_criterion')
  })
})
