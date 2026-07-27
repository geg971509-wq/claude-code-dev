import { describe, expect, test, mock } from 'bun:test'
import { createMcpManager } from '../manager.js'
import type { McpManager } from '../manager.js'
import { McpConnectionError } from '../errors.js'
import type { McpClientDependencies } from '../interfaces.js'
import type {
  ScopedMcpServerConfig,
  MCPServerConnection,
  ConnectedMCPServer,
} from '../types.js'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'

type TestMcpManager = McpManager & {
  setConnectFn(
    fn: (
      name: string,
      config: ScopedMcpServerConfig,
    ) => Promise<MCPServerConnection>,
  ): void
}

function createDeferred<T>() {
  return Promise.withResolvers<T>()
}

function createConnectedServer(
  name: string,
  command: string,
  cleanup = mock(() => Promise.resolve()),
  client = {
    request: mock(() => Promise.resolve({ tools: [] })),
    onclose: null,
  } as unknown as Client,
): ConnectedMCPServer {
  return {
    type: 'connected',
    name,
    client,
    capabilities: {},
    config: {
      command,
      args: [],
      scope: 'dynamic',
    } as ScopedMcpServerConfig,
    cleanup,
  }
}

function createTestManager(): TestMcpManager {
  return createMcpManager(createMockDeps()) as TestMcpManager
}

function createMockDeps(): McpClientDependencies {
  return {
    logger: {
      debug: mock(() => {}),
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    },
    httpConfig: {
      getUserAgent: () => 'test-agent/1.0',
      getSessionId: () => 'test-session',
    },
  }
}

describe('createMcpManager', () => {
  test('creates a manager instance', () => {
    const manager = createMcpManager(createMockDeps())
    expect(manager).toBeDefined()
    expect(manager.getConnections).toBeTypeOf('function')
    expect(manager.connect).toBeTypeOf('function')
    expect(manager.disconnect).toBeTypeOf('function')
    expect(manager.getTools).toBeTypeOf('function')
    expect(manager.getAllTools).toBeTypeOf('function')
    expect(manager.callTool).toBeTypeOf('function')
    expect(manager.on).toBeTypeOf('function')
    expect(manager.off).toBeTypeOf('function')
  })

  test('connect throws if connectFn not set', async () => {
    const manager = createMcpManager(createMockDeps())
    await expect(
      manager.connect('test', { command: 'npx', args: [] }),
    ).rejects.toThrow('connectFn not set')
  })

  test('connect calls connectFn and emits connected event', async () => {
    const manager = createMcpManager(createMockDeps()) as any
    let connectedEvent: string | null = null
    manager.on('connected', (name: string) => {
      connectedEvent = name
    })

    const mockConnection: ConnectedMCPServer = {
      type: 'connected',
      name: 'test-server',
      client: {
        request: mock(() => Promise.resolve({ tools: [] })),
        onclose: null,
      } as unknown as Client,
      capabilities: {},
      config: {
        command: 'npx',
        args: [],
        scope: 'dynamic',
      } as ScopedMcpServerConfig,
      cleanup: mock(() => Promise.resolve()),
    }

    manager.setConnectFn(
      async (name: string, config: ScopedMcpServerConfig) => {
        expect(name).toBe('test-server')
        expect(config.scope).toBe('dynamic')
        return mockConnection
      },
    )

    const result = await manager.connect('test-server', {
      command: 'npx',
      args: [],
    })
    expect(result.type).toBe('connected')
    expect(connectedEvent as unknown as string).toBe('test-server')
  })

  test('disconnect calls cleanup and emits disconnected', async () => {
    const manager = createMcpManager(createMockDeps()) as any
    let disconnected = false
    manager.on('disconnected', () => {
      disconnected = true
    })

    const mockCleanup = mock(() => Promise.resolve())
    const mockConnection: ConnectedMCPServer = {
      type: 'connected',
      name: 'test-server',
      client: {
        request: mock(() => Promise.resolve({ tools: [] })),
      } as unknown as Client,
      capabilities: {},
      config: {
        command: 'npx',
        args: [],
        scope: 'dynamic',
      } as ScopedMcpServerConfig,
      cleanup: mockCleanup,
    }

    manager.setConnectFn(async () => mockConnection)
    await manager.connect('test-server', { command: 'npx', args: [] })

    await manager.disconnect('test-server')
    expect(mockCleanup).toHaveBeenCalled()
    expect(disconnected).toBe(true)
    expect(manager.getConnections().size).toBe(0)
  })

  test('shares an identical pending connect promise', async () => {
    const manager = createTestManager()
    const connection = createConnectedServer('test-server', 'npx')
    const deferred = createDeferred<MCPServerConnection>()
    const connectFn = mock(() => deferred.promise)
    manager.setConnectFn(connectFn)

    const first = manager.connect('test-server', { command: 'npx', args: [] })
    const second = manager.connect('test-server', { command: 'npx', args: [] })

    expect(first).toBe(second)
    expect(connectFn).toHaveBeenCalledTimes(1)

    deferred.resolve(connection)
    await expect(first).resolves.toBe(connection)
  })

  test('publishes only the newest configuration when connects resolve out of order', async () => {
    const manager = createTestManager()
    const firstDeferred = createDeferred<MCPServerConnection>()
    const secondDeferred = createDeferred<MCPServerConnection>()
    const firstConnection = createConnectedServer('test-server', 'first')
    const secondConnection = createConnectedServer('test-server', 'second')
    const connected = mock(() => {})
    const toolsChanged = mock(() => {})
    manager.on('connected', connected)
    manager.on('toolsChanged', toolsChanged)
    const deferreds = [firstDeferred, secondDeferred]
    manager.setConnectFn(mock(() => deferreds.shift()!.promise))

    const first = manager.connect('test-server', { command: 'first', args: [] })
    const second = manager.connect('test-server', {
      command: 'second',
      args: [],
    })

    secondDeferred.resolve(secondConnection)
    await expect(second).resolves.toBe(secondConnection)
    firstDeferred.resolve(firstConnection)
    await expect(first).rejects.toBeInstanceOf(McpConnectionError)

    expect(firstConnection.cleanup).toHaveBeenCalledTimes(1)
    expect(manager.getConnections().get('test-server')).toBe(secondConnection)
    expect(connected).toHaveBeenCalledTimes(1)
    expect(toolsChanged).toHaveBeenCalledTimes(1)
  })

  test('retracts a connection superseded by a connected handler', async () => {
    const manager = createTestManager()
    const firstDeferred = createDeferred<MCPServerConnection>()
    const secondDeferred = createDeferred<MCPServerConnection>()
    const firstConnection = createConnectedServer('test-server', 'first')
    const secondConnection = createConnectedServer('test-server', 'second')
    const deferreds = [firstDeferred, secondDeferred]
    let second: Promise<MCPServerConnection> | undefined
    manager.setConnectFn(mock(() => deferreds.shift()!.promise))
    manager.on('connected', () => {
      second ??= manager.connect('test-server', {
        command: 'second',
        args: [],
      })
    })

    const first = manager.connect('test-server', { command: 'first', args: [] })
    firstDeferred.resolve(firstConnection)

    await expect(first).rejects.toBeInstanceOf(McpConnectionError)
    expect(firstConnection.cleanup).toHaveBeenCalledTimes(1)
    expect(manager.getConnections().has('test-server')).toBe(false)
    expect(manager.getTools('test-server')).toEqual([])

    secondDeferred.resolve(secondConnection)
    await expect(second).resolves.toBe(secondConnection)
  })

  test('disconnect aborts only its active calls before cleanup', async () => {
    const manager = createTestManager()
    const cleanupStarted = createDeferred<void>()
    const cleanupGate = createDeferred<void>()
    const aCallStarted = createDeferred<void>()
    const bCallStarted = createDeferred<void>()
    const cCallStarted = createDeferred<void>()
    const aToolCall = createDeferred<{ content: unknown[] }>()
    const bToolCall = createDeferred<{ content: unknown[] }>()
    const cToolCall = createDeferred<{ content: unknown[] }>()
    let aSignal: AbortSignal | undefined
    let bSignal: AbortSignal | undefined
    const createToolClient = (
      started: ReturnType<typeof createDeferred<void>>,
      toolCall: ReturnType<typeof createDeferred<{ content: unknown[] }>>,
      setSignal: (signal: AbortSignal) => void,
    ) =>
      ({
        request: mock(() => Promise.resolve({ tools: [] })),
        onclose: null,
        callTool: mock(
          (
            _request: unknown,
            _schema: unknown,
            options: { signal: AbortSignal },
          ) => {
            setSignal(options.signal)
            started.resolve()
            return toolCall.promise
          },
        ),
      }) as unknown as Client
    const aConnection = createConnectedServer(
      'server-a',
      'a',
      mock(() => {
        cleanupStarted.resolve()
        return cleanupGate.promise
      }),
      createToolClient(aCallStarted, aToolCall, signal => {
        aSignal = signal
      }),
    )
    const bConnection = createConnectedServer(
      'server-b',
      'b',
      undefined,
      createToolClient(bCallStarted, bToolCall, signal => {
        bSignal = signal
      }),
    )
    const cConnection = createConnectedServer(
      'server-c',
      'c',
      undefined,
      createToolClient(cCallStarted, cToolCall, () => {}),
    )
    const connections = [
      Promise.resolve(aConnection),
      Promise.resolve(bConnection),
      Promise.resolve(cConnection),
    ]
    manager.setConnectFn(mock(() => connections.shift()!))

    await manager.connect('server-a', { command: 'a', args: [] })
    await manager.connect('server-b', { command: 'b', args: [] })
    await manager.connect('server-c', { command: 'c', args: [] })
    const aCall = manager.callTool('server-a', 'tool', {})
    const bCall = manager.callTool('server-b', 'tool', {})
    const cCall = manager.callTool('server-c', 'tool', {})
    await Promise.all([
      aCallStarted.promise,
      bCallStarted.promise,
      cCallStarted.promise,
    ])

    const disconnecting = manager.disconnect('server-a')
    await cleanupStarted.promise
    const wasAbortedBeforeCleanup = aSignal?.aborted
    const otherCallWasAborted = bSignal?.aborted

    cleanupGate.resolve()
    await disconnecting
    aToolCall.resolve({ content: [] })
    await aCall

    const activeCalls = (
      manager as unknown as {
        activeCalls: Map<string, Set<AbortController>>
      }
    ).activeCalls
    expect(wasAbortedBeforeCleanup).toBe(true)
    expect(otherCallWasAborted).toBe(false)
    expect(activeCalls.has('server-a')).toBe(false)

    bToolCall.resolve({ content: [] })
    await bCall
    expect(activeCalls.has('server-b')).toBe(false)

    cToolCall.reject(new Error('tool failed'))
    await expect(cCall).rejects.toThrow('tool failed')
    expect(activeCalls.size).toBe(0)
  })

  test('disconnect invalidates a pending connect and waits for stale cleanup', async () => {
    const manager = createTestManager()
    const connectionDeferred = createDeferred<MCPServerConnection>()
    const cleanupStarted = createDeferred<void>()
    const cleanupDeferred = createDeferred<void>()
    const cleanup = mock(() => {
      cleanupStarted.resolve()
      return cleanupDeferred.promise
    })
    const connection = createConnectedServer('test-server', 'npx', cleanup)
    manager.setConnectFn(mock(() => connectionDeferred.promise))

    const connecting = manager.connect('test-server', {
      command: 'npx',
      args: [],
    })
    const disconnecting = manager.disconnect('test-server')

    connectionDeferred.resolve(connection)
    await cleanupStarted.promise

    let disconnected = false
    disconnecting.then(() => {
      disconnected = true
    })
    await Promise.resolve()
    expect(disconnected).toBe(false)

    cleanupDeferred.resolve()
    await Promise.all([
      disconnecting,
      expect(connecting).rejects.toBeInstanceOf(McpConnectionError),
    ])

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(manager.getConnections().size).toBe(0)
  })

  test('disconnectAll invalidates both settled and pending names', async () => {
    const manager = createTestManager()
    const pendingDeferred = createDeferred<MCPServerConnection>()
    const settledCleanup = mock(() => Promise.resolve())
    const pendingCleanup = mock(() => Promise.resolve())
    const settledConnection = createConnectedServer(
      'settled-server',
      'settled',
      settledCleanup,
    )
    const pendingConnection = createConnectedServer(
      'pending-server',
      'pending',
      pendingCleanup,
    )
    const connections = [
      Promise.resolve(settledConnection),
      pendingDeferred.promise,
    ]
    manager.setConnectFn(mock(() => connections.shift()!))

    await manager.connect('settled-server', { command: 'settled', args: [] })
    const pending = manager.connect('pending-server', {
      command: 'pending',
      args: [],
    })
    const disconnecting = manager.disconnectAll()

    pendingDeferred.resolve(pendingConnection)
    await Promise.all([
      disconnecting,
      expect(pending).rejects.toBeInstanceOf(McpConnectionError),
    ])

    expect(settledCleanup).toHaveBeenCalledTimes(1)
    expect(pendingCleanup).toHaveBeenCalledTimes(1)
    expect(manager.getConnections().size).toBe(0)
  })

  test('on/off event handling', () => {
    const manager = createMcpManager(createMockDeps()) as any
    const handler = mock(() => {})
    manager.on('error', handler)
    manager.off('error', handler)
    // No crash — just verifying it works
    expect(true).toBe(true)
  })

  test('getTools returns empty array for unknown server', () => {
    const manager = createMcpManager(createMockDeps())
    expect(manager.getTools('unknown')).toEqual([])
  })

  test('getAllTools returns empty array initially', () => {
    const manager = createMcpManager(createMockDeps())
    expect(manager.getAllTools()).toEqual([])
  })
})
