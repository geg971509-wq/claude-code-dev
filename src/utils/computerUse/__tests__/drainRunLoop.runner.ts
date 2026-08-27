import { describe, expect, mock, test } from 'bun:test'

mock.module('src/utils/debug.ts', () => ({ logForDebugging: () => {} }))
mock.module('src/utils/computerUse/swiftLoader.ts', () => ({
  requireComputerUseSwift: () => ({ _drainMainRunLoop: () => {} }),
}))

const { drainRunLoop } = await import('../drainRunLoop.js')

describe('drainRunLoop timeout', () => {
  test('uses the caller timeout and label', async () => {
    await expect(
      drainRunLoop(() => Bun.sleep(100), 10, 'CU screenshot backstop'),
    ).rejects.toThrow('CU screenshot backstop exceeded 10ms')
  })
})
