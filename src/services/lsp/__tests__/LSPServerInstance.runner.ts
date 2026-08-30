import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { InitializeResult } from 'vscode-languageserver-protocol'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'
import { withResolvers } from '../../../utils/withResolvers.js'
import type { LSPClient } from '../LSPClient.js'
import type { ScopedLspServerConfig } from '../types.js'

mock.module('src/utils/debug.ts', debugMock)
const logErrorMock = mock(() => {})
mock.module('src/utils/log.ts', () => ({
  ...logMock(),
  logError: logErrorMock,
}))

let initializeGate = withResolvers<InitializeResult>()
let stopGate: PromiseWithResolvers<void> | undefined

const startClient = mock(async () => {})
const initializeClient = mock(() => initializeGate.promise)
const stopClient = mock(() => stopGate?.promise ?? Promise.resolve())
const client: LSPClient = {
  capabilities: undefined,
  isInitialized: false,
  start: startClient,
  initialize: initializeClient,
  sendRequest: mock(
    async () => undefined,
  ) as unknown as LSPClient['sendRequest'],
  sendNotification: mock(async () => {}),
  onNotification: mock(() => {}),
  onRequest: mock(() => {}),
  stop: stopClient,
}

mock.module('../LSPClient.js', () => ({
  createLSPClient: () => client,
}))

const { createLSPServerInstance } = await import('../LSPServerInstance.js')

const config: ScopedLspServerConfig = {
  command: 'test-lsp',
  extensionToLanguage: { '.ts': 'typescript' },
  transport: 'stdio',
  scope: 'dynamic',
  source: 'test',
}

beforeEach(() => {
  initializeGate = withResolvers<InitializeResult>()
  stopGate = undefined
  startClient.mockClear()
  initializeClient.mockClear()
  stopClient.mockClear()
  logErrorMock.mockClear()
})

describe('LSPServerInstance lifecycle', () => {
  test('concurrent starts share one initialization', async () => {
    const instance = createLSPServerInstance('test-server', config)
    const first = instance.start()
    const second = instance.start()

    await Promise.resolve()
    expect(startClient).toHaveBeenCalledTimes(1)
    expect(initializeClient).toHaveBeenCalledTimes(1)

    initializeGate.resolve({ capabilities: {} })
    await Promise.all([first, second])
    expect(instance.state).toBe('running')
  })

  test('stop waits for startup and leaves the instance stopped', async () => {
    const instance = createLSPServerInstance('test-server', config)
    const startup = instance.start()
    await Promise.resolve()
    expect(instance.state).toBe('starting')

    const shutdown = instance.stop()
    initializeGate.resolve({ capabilities: {} })

    await Promise.all([startup, shutdown])
    expect(stopClient).toHaveBeenCalledTimes(1)
    expect(instance.state).toBe('stopped')
  })

  test('concurrent stop calls share the same cleanup', async () => {
    const instance = createLSPServerInstance('test-server', config)
    initializeGate.resolve({ capabilities: {} })
    await instance.start()

    stopGate = withResolvers<void>()
    const first = instance.stop()
    const second = instance.stop()
    let secondSettled = false
    void second.then(() => {
      secondSettled = true
    })

    await Promise.resolve()
    expect(stopClient).toHaveBeenCalledTimes(1)
    expect(secondSettled).toBe(false)

    stopGate.resolve()
    await Promise.all([first, second])
    expect(instance.state).toBe('stopped')
  })

  test('startup failure waits for client cleanup', async () => {
    const instance = createLSPServerInstance('test-server', config)
    stopGate = withResolvers<void>()
    const startup = instance.start()
    let startupSettled = false
    void startup.then(
      () => {
        startupSettled = true
      },
      () => {
        startupSettled = true
      },
    )

    initializeGate.reject(new Error('initialize failed'))
    await Promise.resolve()
    await Promise.resolve()
    expect(startupSettled).toBe(false)

    stopGate.resolve()
    await expect(startup).rejects.toThrow('initialize failed')
    expect(stopClient).toHaveBeenCalledTimes(1)
    expect(instance.state).toBe('error')
  })

  test('stop completes after a failed startup cleanup', async () => {
    const instance = createLSPServerInstance('test-server', config)
    stopGate = withResolvers<void>()
    const startup = instance.start()
    const shutdown = instance.stop()

    initializeGate.reject(new Error('initialize failed'))
    await Promise.resolve()
    await Promise.resolve()
    stopGate.resolve()

    await expect(startup).rejects.toThrow('initialize failed')
    await shutdown
    expect(stopClient).toHaveBeenCalledTimes(2)
    expect(instance.state).toBe('stopped')
  })

  test('logs cleanup failure without replacing the startup error', async () => {
    const instance = createLSPServerInstance('test-server', config)
    stopGate = withResolvers<void>()
    const startup = instance.start()

    initializeGate.reject(new Error('initialize failed'))
    await Promise.resolve()
    await Promise.resolve()
    stopGate.reject(new Error('cleanup failed'))

    await expect(startup).rejects.toThrow('initialize failed')
    expect(logErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          "Failed to clean up LSP server 'test-server'",
        ),
      }),
    )
    expect(instance.state).toBe('error')
  })
})
