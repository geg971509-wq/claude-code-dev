import { beforeEach, describe, expect, mock, test } from 'bun:test'

import { logMock } from '../../../../../../tests/mocks/log.js'
mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', () => ({
  logForDebugging: () => {},
}))

import { GoalTool } from '../GoalTool.js'
import {
  _clearAllGoalsForTesting,
  setGoal,
} from 'src/services/goal/goalState.js'

beforeEach(() => {
  _clearAllGoalsForTesting()
})

describe('GoalTool complete + completionCriterion', () => {
  test('requires non-empty reason when criterion is set', async () => {
    const r = setGoal('ship', {
      completionCriterion: 'all tests pass',
    })
    expect(r.ok).toBe(true)
    const out = await GoalTool.call({ action: 'update', status: 'complete' })
    expect(out.data.success).toBe(false)
    expect(out.data.error).toContain('completionCriterion')
  })

  test('succeeds with non-empty reason when criterion is set', async () => {
    const r = setGoal('ship', {
      completionCriterion: 'all tests pass',
    })
    expect(r.ok).toBe(true)
    const out = await GoalTool.call({
      action: 'update',
      status: 'complete',
      reason: 'all tests pass locally',
    })
    expect(out.data.success).toBe(true)
  })

  test('complete without criterion still allows missing reason', async () => {
    const r = setGoal('ship')
    expect(r.ok).toBe(true)
    const out = await GoalTool.call({ action: 'update', status: 'complete' })
    expect(out.data.success).toBe(true)
  })
})
