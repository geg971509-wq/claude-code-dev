import { describe, expect, mock, test } from 'bun:test'

const calls: unknown[][] = []
const raw = {
  base64: 'test',
  width: 100,
  height: 50,
  displayWidth: 100,
  displayHeight: 50,
  originX: 0,
  originY: 0,
  displayId: 7,
  hidden: [],
}
const computerUse = {
  apps: {},
  display: {
    getSize: () => ({ width: 100, height: 50, scaleFactor: 1, displayId: 7 }),
  },
  screenshot: {},
  resolvePrepareCapture: async (...args: unknown[]) => {
    calls.push(args)
    return raw
  },
}

mock.module('src/utils/debug.ts', () => ({ logForDebugging: () => {} }))
mock.module('src/utils/computerUse/common.ts', () => ({
  CLI_CU_CAPABILITIES: {},
  CLI_HOST_BUNDLE_ID: 'test.cli',
  getTerminalBundleId: () => null,
}))
mock.module('src/utils/computerUse/drainRunLoop.ts', () => ({
  drainRunLoop: <T>(fn: () => Promise<T>) => fn(),
}))
mock.module('src/utils/computerUse/escHotkey.ts', () => ({
  notifyExpectedEscape: () => {},
}))
mock.module('src/utils/computerUse/inputLoader.ts', () => ({
  requireComputerUseInput: () => ({}),
}))
mock.module('src/utils/computerUse/swiftLoader.ts', () => ({
  requireComputerUseSwift: () => computerUse,
}))

const { createCliExecutor } = await import('../executor.js')

describe('createCliExecutor resolvePrepareCapture', () => {
  test('forwards the complete official eight-argument contract', async () => {
    const executor = createCliExecutor({
      getMouseAnimationEnabled: () => false,
      getHideBeforeActionEnabled: () => true,
    })

    expect(
      await executor.resolvePrepareCapture({
        allowedBundleIds: ['com.example.app'],
        preferredDisplayId: 7,
        autoResolve: true,
        doHide: false,
      }),
    ).toEqual(raw)
    expect(calls).toEqual([
      [['com.example.app'], 'test.cli', 0.75, 100, 50, 7, true, false],
    ])
  })
})
