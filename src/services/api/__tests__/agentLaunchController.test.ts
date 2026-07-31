import { afterEach, describe, expect, test } from 'bun:test'
import {
  acquireLaunchSlot,
  noteRateLimited,
  resetAgentLaunchThrottleForTesting,
  throttleWaitMs,
} from '../agentLaunchController'

afterEach(() => {
  resetAgentLaunchThrottleForTesting()
})

describe('noteRateLimited / throttleWaitMs', () => {
  test('gate is open before any rate limit', () => {
    expect(throttleWaitMs()).toBe(0)
  })

  test('default cooldown is 10s', () => {
    const now = 1_000_000
    noteRateLimited(undefined, now)
    expect(throttleWaitMs(now)).toBe(10_000)
    expect(throttleWaitMs(now + 10_001)).toBe(0)
  })

  test('uses retry-after when provided, capped at 30s', () => {
    const now = 1_000_000
    noteRateLimited(500, now)
    expect(throttleWaitMs(now)).toBe(500)

    noteRateLimited(999_999, now)
    expect(throttleWaitMs(now)).toBe(30_000)
  })

  test('concurrent hits extend but never shrink the window', () => {
    const now = 1_000_000
    noteRateLimited(20_000, now)
    noteRateLimited(5_000, now)
    expect(throttleWaitMs(now)).toBe(20_000)
  })
})

describe('acquireLaunchSlot', () => {
  test('returns immediately when the gate is open', async () => {
    const start = Date.now()
    await acquireLaunchSlot()
    expect(Date.now() - start).toBeLessThan(50)
  })

  test('waits out the cooldown', async () => {
    noteRateLimited(80, Date.now())
    const start = Date.now()
    await acquireLaunchSlot()
    expect(Date.now() - start).toBeGreaterThanOrEqual(60)
  })

  test('rejects on abort during the wait', async () => {
    noteRateLimited(30_000, Date.now())
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    await expect(acquireLaunchSlot(controller.signal)).rejects.toThrow(
      /Aborted while waiting/,
    )
  })

  test('rejects immediately when already aborted', async () => {
    noteRateLimited(30_000, Date.now())
    const controller = new AbortController()
    controller.abort()
    await expect(acquireLaunchSlot(controller.signal)).rejects.toThrow()
  })
})
