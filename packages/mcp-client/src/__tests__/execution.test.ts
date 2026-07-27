import { describe, expect, test, mock } from 'bun:test'
import { callMcpTool, resolveMcpToolTimeoutMs } from '../execution.js'
import type { ConnectedMCPServer } from '../types.js'
import type { McpClientDependencies } from '../interfaces.js'
import { McpAuthError, McpToolCallError } from '../errors.js'

type TimeoutSpy = {
  scheduled: number
  cleared: unknown[]
  fire(): void
}

async function withTimeoutSpy(
  run: (spy: TimeoutSpy) => Promise<void>,
): Promise<void> {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const callbacks: Array<() => void> = []
  const handle = { unref() {} } as unknown as ReturnType<typeof setTimeout>
  const spy: TimeoutSpy = {
    scheduled: 0,
    cleared: [],
    fire() {
      callbacks.at(-1)?.()
    },
  }

  globalThis.setTimeout = ((callback: () => void) => {
    spy.scheduled++
    callbacks.push(callback)
    return handle
  }) as typeof setTimeout
  globalThis.clearTimeout = ((timeout: unknown) => {
    spy.cleared.push(timeout)
  }) as typeof clearTimeout

  try {
    await run(spy)
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }
}

function createMockConnection(
  callTool: (...args: any[]) => any,
): ConnectedMCPServer {
  return {
    name: 'test-server',
    client: { callTool },
    type: 'connected' as const,
  } as unknown as ConnectedMCPServer
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
    },
  }
}

describe('resolveMcpToolTimeoutMs', () => {
  const defaultTimeoutMs = 100_000_000

  test('accepts whitespace-padded positive integers', () => {
    expect(resolveMcpToolTimeoutMs(' 5000 ')).toBe(5000)
  })

  test.each([
    undefined,
    '',
    '   ',
    '0',
    '-1',
    '1.5',
    '5000ms',
    'NaN',
    'Infinity',
  ])('falls back to the default for %p', raw => {
    expect(resolveMcpToolTimeoutMs(raw)).toBe(defaultTimeoutMs)
  })
})

describe('callMcpTool', () => {
  test('clears the race timeout after success', async () => {
    await withTimeoutSpy(async spy => {
      const connection = createMockConnection(() =>
        Promise.resolve({ content: [{ type: 'text', text: 'ok' }] }),
      )

      await callMcpTool(
        {
          client: connection,
          tool: 'success',
          args: {},
          signal: new AbortController().signal,
        },
        createMockDeps(),
      )

      expect(spy.scheduled).toBe(1)
      expect(spy.cleared).toHaveLength(1)
    })
  })

  test('clears the race timeout after client rejection', async () => {
    await withTimeoutSpy(async spy => {
      const connection = createMockConnection(() =>
        Promise.reject(new Error('client failed')),
      )

      await expect(
        callMcpTool(
          {
            client: connection,
            tool: 'reject',
            args: {},
            signal: new AbortController().signal,
          },
          createMockDeps(),
        ),
      ).rejects.toThrow('client failed')
      expect(spy.scheduled).toBe(1)
      expect(spy.cleared).toHaveLength(1)
    })
  })

  test('clears the race timeout after a synchronous client throw', async () => {
    await withTimeoutSpy(async spy => {
      const connection = createMockConnection(() => {
        throw new Error('sync failed')
      })

      await expect(
        callMcpTool(
          {
            client: connection,
            tool: 'sync-throw',
            args: {},
            signal: new AbortController().signal,
          },
          createMockDeps(),
        ),
      ).rejects.toThrow('sync failed')
      expect(spy.scheduled).toBe(1)
      expect(spy.cleared).toHaveLength(1)
    })
  })

  test('clears the race timeout when isError is converted', async () => {
    await withTimeoutSpy(async spy => {
      const connection = createMockConnection(() =>
        Promise.resolve({
          isError: true,
          content: [{ type: 'text', text: 'tool failed' }],
        }),
      )

      await expect(
        callMcpTool(
          {
            client: connection,
            tool: 'is-error',
            args: {},
            signal: new AbortController().signal,
          },
          createMockDeps(),
        ),
      ).rejects.toBeInstanceOf(McpToolCallError)
      expect(spy.scheduled).toBe(1)
      expect(spy.cleared).toHaveLength(1)
    })
  })

  test('clears the race timeout after timeout', async () => {
    await withTimeoutSpy(async spy => {
      const connection = createMockConnection(() => new Promise(() => {}))
      const call = callMcpTool(
        {
          client: connection,
          tool: 'timeout',
          args: {},
          signal: new AbortController().signal,
          timeoutMs: 500,
        },
        createMockDeps(),
      )

      spy.fire()
      await expect(call).rejects.toThrow('timed out after 0s')
      expect(spy.scheduled).toBe(1)
      expect(spy.cleared).toHaveLength(1)
    })
  })

  test('clears the race timeout after abort', async () => {
    await withTimeoutSpy(async spy => {
      const controller = new AbortController()
      const connection = createMockConnection(
        (_request, _schema, options: { signal: AbortSignal }) =>
          new Promise((_, reject) => {
            options.signal.addEventListener('abort', () => {
              const error = new Error('aborted')
              error.name = 'AbortError'
              reject(error)
            })
          }),
      )
      const call = callMcpTool(
        {
          client: connection,
          tool: 'abort',
          args: {},
          signal: controller.signal,
        },
        createMockDeps(),
      )

      controller.abort()
      await expect(call).rejects.toMatchObject({ name: 'AbortError' })
      expect(spy.scheduled).toBe(1)
      expect(spy.cleared).toHaveLength(1)
    })
  })

  test('calls tool and returns result', async () => {
    const mockResult = {
      content: [{ type: 'text', text: 'result data' }],
      _meta: { requestId: '123' },
    }

    const mockConn = {
      name: 'test-server',
      client: {
        callTool: mock(() => Promise.resolve(mockResult)),
      },
      type: 'connected' as const,
    } as unknown as ConnectedMCPServer

    const result = await callMcpTool(
      {
        client: mockConn,
        tool: 'search',
        args: { query: 'test' },
        signal: new AbortController().signal,
      },
      createMockDeps(),
    )

    expect(result.content).toBeDefined()
  })

  test('throws McpToolCallError when result has isError=true', async () => {
    const mockResult = {
      isError: true,
      content: [{ type: 'text', text: 'Something went wrong' }],
    }

    const mockConn = {
      name: 'test-server',
      client: {
        callTool: mock(() => Promise.resolve(mockResult)),
      },
      type: 'connected' as const,
    } as unknown as ConnectedMCPServer

    await expect(
      callMcpTool(
        {
          client: mockConn,
          tool: 'fail-tool',
          args: {},
          signal: new AbortController().signal,
        },
        createMockDeps(),
      ),
    ).rejects.toThrow()

    try {
      await callMcpTool(
        {
          client: mockConn,
          tool: 'fail-tool',
          args: {},
          signal: new AbortController().signal,
        },
        createMockDeps(),
      )
    } catch (e) {
      expect(e).toBeInstanceOf(McpToolCallError)
      expect((e as McpToolCallError).serverName).toBe('test-server')
      expect((e as McpToolCallError).toolName).toBe('fail-tool')
    }
  })

  test('throws McpAuthError on 401 response', async () => {
    const error = new Error('Unauthorized')
    Object.assign(error, { code: 401 })

    const mockConn = {
      name: 'auth-server',
      client: {
        callTool: mock(() => Promise.reject(error)),
      },
      type: 'connected' as const,
    } as unknown as ConnectedMCPServer

    await expect(
      callMcpTool(
        {
          client: mockConn,
          tool: 'protected-tool',
          args: {},
          signal: new AbortController().signal,
        },
        createMockDeps(),
      ),
    ).rejects.toThrow(McpAuthError)
  })

  test('passes metadata to the client', async () => {
    const mockResult = { content: [{ type: 'text', text: 'ok' }] }
    const callToolMock = mock(() => Promise.resolve(mockResult))

    const mockConn = {
      name: 'test-server',
      client: {
        callTool: callToolMock,
      },
      type: 'connected' as const,
    } as unknown as ConnectedMCPServer

    await callMcpTool(
      {
        client: mockConn,
        tool: 'my-tool',
        args: { key: 'value' },
        meta: { 'custom-key': 'custom-value' },
        signal: new AbortController().signal,
      },
      createMockDeps(),
    )

    expect(callToolMock).toHaveBeenCalled()
    const callArgs = callToolMock.mock.calls[0] as any[]
    expect(callArgs[0]._meta).toEqual({ 'custom-key': 'custom-value' })
  })
})
