import { describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../tests/mocks/debug'

mock.module('src/utils/debug.ts', debugMock)

import { registerCleanup, runCleanupFunctions } from '../cleanupRegistry'

describe('runCleanupFunctions', () => {
  test('continues after a cleanup throws synchronously', async () => {
    const calls: string[] = []
    const unregisterThrowing = registerCleanup(() => {
      calls.push('throwing')
      throw new Error('boom')
    })
    const unregisterFollowing = registerCleanup(async () => {
      calls.push('following')
    })

    try {
      await runCleanupFunctions()
      expect(calls).toEqual(['throwing', 'following'])
    } finally {
      unregisterThrowing()
      unregisterFollowing()
    }
  })
})
