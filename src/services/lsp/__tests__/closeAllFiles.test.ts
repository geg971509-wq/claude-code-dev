import { beforeEach, describe, expect, test, mock } from 'bun:test'
import { withResolvers } from '../../../utils/withResolvers.js'
import { createLSPServerManager } from '../LSPServerManager.js'

// Mock config loading to avoid real filesystem/LSP server access
mock.module('../config.js', () => ({
  getAllLspServers: async () => ({
    servers: {
      'test-server': {
        command: ['test-lsp'],
        extensionToLanguage: {
          '.ts': 'typescript',
          '.js': 'javascript',
        },
      },
    },
  }),
}))

// Mock LSPServerInstance to avoid spawning real processes
let mockServerState = 'running'
let startGate: PromiseWithResolvers<void> | undefined
let stopGate: PromiseWithResolvers<void> | undefined
const startMock = mock(() => startGate?.promise ?? Promise.resolve())
const stopMock = mock(() => stopGate?.promise ?? Promise.resolve())
const sendNotificationMock = mock(() => Promise.resolve())
mock.module('../LSPServerInstance.js', () => ({
  createLSPServerInstance: (name: string, config: any) => ({
    name,
    config,
    get state() {
      return mockServerState
    },
    start: startMock,
    stop: stopMock,
    sendRequest: mock(async () => undefined),
    sendNotification: sendNotificationMock,
    onRequest: mock(() => {}),
  }),
}))

// Mock log modules with side effects
mock.module('../../../utils/log.js', () => ({
  logError: mock(() => {}),
}))

mock.module('../../../utils/debug.js', () => ({
  logForDebugging: mock(() => {}),
}))

beforeEach(() => {
  mockServerState = 'running'
  startGate = undefined
  stopGate = undefined
  startMock.mockClear()
  stopMock.mockClear()
  sendNotificationMock.mockClear()
})

describe('LSPServerManager closeAllFiles', () => {
  test('closeAllFiles is a no-op when no files are open', async () => {
    const manager = createLSPServerManager()
    await manager.initialize()
    // Should not throw
    await manager.closeAllFiles()
  })

  test('closeAllFiles sends didClose for each open file', async () => {
    const manager = createLSPServerManager()
    await manager.initialize()

    // Open some files via the public API.
    // Since createLSPServerInstance is mocked with state='running',
    // openFile should track them and send didOpen.
    sendNotificationMock.mockClear()
    await manager.openFile('/project/a.ts', 'content-a')
    await manager.openFile('/project/b.js', 'content-b')

    // Verify files are tracked as open
    expect(manager.isFileOpen('/project/a.ts')).toBe(true)
    expect(manager.isFileOpen('/project/b.js')).toBe(true)

    // Now close all
    sendNotificationMock.mockClear()
    await manager.closeAllFiles()

    // didClose should have been sent for both files
    expect(sendNotificationMock).toHaveBeenCalledTimes(2)
    const calls = sendNotificationMock.mock.calls.map((c: any[]) => c)
    const uris = calls.map(c => (c[1] as any)?.textDocument?.uri as string)
    expect(uris).toEqual(
      expect.arrayContaining([
        expect.stringContaining('a.ts'),
        expect.stringContaining('b.js'),
      ]),
    )

    // Files should no longer be tracked
    expect(manager.isFileOpen('/project/a.ts')).toBe(false)
    expect(manager.isFileOpen('/project/b.js')).toBe(false)
  })

  test('closeAllFiles clears tracking even if server notification fails', async () => {
    const manager = createLSPServerManager()
    await manager.initialize()

    await manager.openFile('/project/x.ts', 'content-x')
    expect(manager.isFileOpen('/project/x.ts')).toBe(true)

    // Make sendNotification throw
    sendNotificationMock.mockRejectedValueOnce(new Error('server gone'))

    // Should not throw, and file tracking should be cleared
    await manager.closeAllFiles()
    expect(manager.isFileOpen('/project/x.ts')).toBe(false)
  })

  test('closeAllFiles handles double invocation gracefully', async () => {
    const manager = createLSPServerManager()
    await manager.initialize()

    await manager.openFile('/project/y.ts', 'content-y')
    await manager.closeAllFiles()
    expect(manager.isFileOpen('/project/y.ts')).toBe(false)

    // Second call should be a no-op (no files to close)
    sendNotificationMock.mockClear()
    await manager.closeAllFiles()
    expect(sendNotificationMock).not.toHaveBeenCalled()
  })

  test('closeAllFiles skips servers that are not running', async () => {
    const manager = createLSPServerManager()
    await manager.initialize()

    await manager.openFile('/project/z.ts', 'content-z')
    expect(manager.isFileOpen('/project/z.ts')).toBe(true)

    mockServerState = 'stopped'
    sendNotificationMock.mockClear()
    await manager.closeAllFiles()
    expect(sendNotificationMock).not.toHaveBeenCalled()
    expect(manager.isFileOpen('/project/z.ts')).toBe(false)
  })
})

describe('LSPServerManager lifecycle', () => {
  test('shutdown waits for a starting server before clearing it', async () => {
    mockServerState = 'starting'
    stopGate = withResolvers<void>()
    const manager = createLSPServerManager()
    await manager.initialize()

    const shutdown = manager.shutdown()
    await Promise.resolve()
    expect(stopMock).toHaveBeenCalledTimes(1)
    expect(manager.getAllServers()).toHaveLength(1)

    stopGate.resolve()
    await shutdown
    expect(manager.getAllServers()).toHaveLength(0)
  })

  test('requests made while starting await the shared startup', async () => {
    mockServerState = 'starting'
    startGate = withResolvers<void>()
    const manager = createLSPServerManager()
    await manager.initialize()

    const first = manager.ensureServerStarted('/project/a.ts')
    const second = manager.ensureServerStarted('/project/b.ts')
    let settled = false
    void Promise.all([first, second]).then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(startMock).toHaveBeenCalledTimes(2)
    expect(settled).toBe(false)

    startGate.resolve()
    await Promise.all([first, second])
  })

  test('rejects new starts after shutdown begins', async () => {
    mockServerState = 'stopped'
    stopGate = withResolvers<void>()
    const manager = createLSPServerManager()
    await manager.initialize()

    const shutdown = manager.shutdown()
    await expect(manager.ensureServerStarted('/project/a.ts')).rejects.toThrow(
      'LSP server manager is shutting down',
    )
    expect(startMock).not.toHaveBeenCalled()

    stopGate.resolve()
    await shutdown
  })
})
