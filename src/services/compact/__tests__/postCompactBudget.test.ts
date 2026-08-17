import { describe, expect, test } from 'bun:test'
import {
  allocatePostCompactBudget,
  POST_COMPACT_PRESERVE_MAX_TOKENS,
  POST_COMPACT_PRESERVE_MIN_TOKENS,
} from '../postCompactBudget.js'
import { PRESERVE_RECENT_MIN_TOKENS } from '../tailPreservation.js'

describe('allocatePostCompactBudget', () => {
  test('tail + preservedUser always equals total', () => {
    for (const window of [0, 1_000, 16_000, 40_000, 200_000, 1_000_000]) {
      const b = allocatePostCompactBudget(window)
      expect(b.tail + b.preservedUser).toBe(b.total)
    }
  })

  test('total is bounded by the ceiling regardless of window size', () => {
    // 仲裁前这里是 8k + 8k = 16k 无条件相加，与窗口无关。
    expect(allocatePostCompactBudget(1_000_000).total).toBe(
      POST_COMPACT_PRESERVE_MAX_TOKENS,
    )
    expect(allocatePostCompactBudget(0).total).toBe(
      POST_COMPACT_PRESERVE_MIN_TOKENS,
    )
  })

  test('never exceeds a quarter of the window once past the floor', () => {
    const window = 40_000
    const b = allocatePostCompactBudget(window)
    expect(b.total).toBeLessThanOrEqual(window * 0.25)
    // 回归守卫：旧行为下 40k 窗口能保留 16k（40%），压缩几乎白做。
    expect(b.total).toBeLessThan(16_000)
  })

  test('leaves the preserved-user floor even when tail wants everything', () => {
    for (const window of [0, 8_000, 200_000]) {
      expect(
        allocatePostCompactBudget(window).preservedUser,
      ).toBeGreaterThanOrEqual(PRESERVE_RECENT_MIN_TOKENS)
    }
  })

  test('large windows keep the pre-arbitration 8k/8k split', () => {
    const b = allocatePostCompactBudget(200_000)
    expect(b.tail).toBe(8_000)
    expect(b.preservedUser).toBe(8_000)
  })
})
