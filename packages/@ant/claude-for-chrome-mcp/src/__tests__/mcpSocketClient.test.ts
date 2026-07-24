import { describe, expect, test } from 'bun:test'
import {
  createMcpSocketClient,
  type McpSocketClient,
} from '../mcpSocketClient.js'
import type { ClaudeForChromeContext } from '../types.js'

type ToolRequest = {
  method: string
  params?: { tool?: string; args?: Record<string, unknown> }
}

type ClientInternals = {
  socket: { write(message: Buffer): void } | null
  connected: boolean
  sendRequest(request: ToolRequest, timeoutMs?: number): Promise<unknown>
  sendRequestWithRetry(request: ToolRequest): Promise<unknown>
  handleResponse(response: { result?: unknown; error?: string }): void
}

function createClient(): {
  client: McpSocketClient
  internals: ClientInternals
  writes: Buffer[]
} {
  const writes: Buffer[] = []
  const context: ClaudeForChromeContext = {
    serverName: 'test-chrome',
    socketPath: '/tmp/test-chrome.sock',
    clientTypeId: 'claude-code',
    logger: {
      info() {},
      error() {},
      warn() {},
      debug() {},
      silly() {},
    },
    onToolCallDisconnected: () => 'disconnected',
    onAuthenticationError() {},
  }
  const client = createMcpSocketClient(context)
  const internals = client as unknown as ClientInternals
  internals.socket = {
    write(message) {
      writes.push(message)
    },
  }
  internals.connected = true
  return { client, internals, writes }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('McpSocketClient request serialization', () => {
  test('writes one request at a time and preserves response ownership', async () => {
    const { client, internals, writes } = createClient()
    const sendRequest = internals.sendRequest.bind(client)
    internals.sendRequestWithRetry = request => sendRequest(request, 50)

    const first = client.callTool('first', { value: 1 })
    const second = client.callTool('second', { value: 2 })

    try {
      await flushPromises()
      expect(writes).toHaveLength(1)

      internals.handleResponse({ result: 'first-result' })
      await expect(first).resolves.toEqual({ result: 'first-result' })
      await flushPromises()
      expect(writes).toHaveLength(2)

      internals.handleResponse({ result: 'second-result' })
      await expect(second).resolves.toEqual({ result: 'second-result' })
    } finally {
      internals.handleResponse({ result: 'cleanup' })
      await Promise.allSettled([first, second])
    }
  })

  test('advances the queue after a request rejects', async () => {
    const { client, internals } = createClient()
    const calls: string[] = []
    const firstError = new Error('first failed')
    let rejectFirst: (() => void) | undefined
    internals.sendRequestWithRetry = request => {
      const tool = request.params?.tool ?? ''
      calls.push(tool)
      if (tool === 'first') {
        return new Promise((_, reject) => {
          rejectFirst = () => reject(firstError)
        })
      }
      return Promise.resolve({ result: 'second-result' })
    }

    const first = client.callTool('first', {})
    const second = client.callTool('second', {})

    try {
      await flushPromises()
      expect(calls).toEqual(['first'])
      rejectFirst?.()
      await expect(first).rejects.toBe(firstError)
      await expect(second).resolves.toEqual({ result: 'second-result' })
      expect(calls).toEqual(['first', 'second'])
    } finally {
      rejectFirst?.()
      await Promise.allSettled([first, second])
    }
  })

  test('keeps internal retries inside the first queue slot', async () => {
    const { client, internals } = createClient()
    const calls: string[] = []
    let releaseRetry: (() => void) | undefined
    const retryGate = new Promise<void>(resolve => {
      releaseRetry = resolve
    })
    internals.sendRequestWithRetry = async request => {
      const tool = request.params?.tool ?? ''
      if (tool === 'first') {
        calls.push('first-attempt-1')
        await retryGate
        calls.push('first-attempt-2')
        return { result: 'first-result' }
      }
      calls.push('second-attempt-1')
      return { result: 'second-result' }
    }

    const first = client.callTool('first', {})
    const second = client.callTool('second', {})

    try {
      await flushPromises()
      expect(calls).toEqual(['first-attempt-1'])
      releaseRetry?.()
      await expect(first).resolves.toEqual({ result: 'first-result' })
      await expect(second).resolves.toEqual({ result: 'second-result' })
      expect(calls).toEqual([
        'first-attempt-1',
        'first-attempt-2',
        'second-attempt-1',
      ])
    } finally {
      releaseRetry?.()
      await Promise.allSettled([first, second])
    }
  })
})
