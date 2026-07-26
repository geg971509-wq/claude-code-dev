import { describe, expect, test } from 'bun:test'
import { SessionsWebSocket } from '../SessionsWebSocket.js'

type Listener = (event: any) => void

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static constructorHook: ((socket: FakeWebSocket) => void) | null = null

  private readonly listeners = new Map<string, Listener[]>()
  readonly sent: string[] = []
  closed = false
  sendError: Error | null = null

  constructor(_url: string, _options?: unknown) {
    FakeWebSocket.instances.push(this)
    FakeWebSocket.constructorHook?.(this)
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  emit(type: string, event: any = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  close(): void {
    this.closed = true
  }

  send(data: string): void {
    if (this.sendError) throw this.sendError
    this.sent.push(data)
  }

  ping(): void {}
}

describe('SessionsWebSocket stale callbacks', () => {
  test('reports whether a control response was accepted', async () => {
    const originalWebSocket = globalThis.WebSocket
    FakeWebSocket.instances = []
    FakeWebSocket.constructorHook = null
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket

    const client = new SessionsWebSocket('session-1', 'org-1', () => 'token', {
      onMessage: () => {},
    })
    const response = {
      type: 'control_response',
      response: { subtype: 'success' },
    } as any

    try {
      expect(client.sendControlResponse(response)).toBe(false)

      await client.connect()
      const socket = FakeWebSocket.instances[0]!
      socket.emit('open')
      expect(client.sendControlResponse(response)).toBe(true)

      socket.sendError = new Error('send failed')
      expect(client.sendControlResponse(response)).toBe(false)
      expect(socket.sent).toHaveLength(1)
    } finally {
      client.close()
      globalThis.WebSocket = originalWebSocket
    }
  })

  test('close before open uses the bounded reconnect policy', async () => {
    const originalWebSocket = globalThis.WebSocket
    FakeWebSocket.instances = []
    FakeWebSocket.constructorHook = null
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket

    let closed = 0
    let reconnecting = 0
    const client = new SessionsWebSocket('session-1', 'org-1', () => 'token', {
      onMessage: () => {},
      onClose: () => closed++,
      onReconnecting: () => reconnecting++,
    })

    try {
      await client.connect()
      FakeWebSocket.instances[0]!.emit('close', { code: 1006, reason: '' })

      expect((client as any).state).toBe('closed')
      expect((client as any).reconnectAttempts).toBe(1)
      expect((client as any).reconnectTimer).not.toBeNull()
      expect(reconnecting).toBe(1)
      expect(closed).toBe(0)
    } finally {
      client.close()
      globalThis.WebSocket = originalWebSocket
    }
  })

  test('late events from an old socket do not disturb the current connection', async () => {
    const originalWebSocket = globalThis.WebSocket
    FakeWebSocket.instances = []
    FakeWebSocket.constructorHook = null
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket

    let connected = 0
    let messages = 0
    let errors = 0
    let closed = 0
    let reconnecting = 0
    const client = new SessionsWebSocket('session-1', 'org-1', () => 'token', {
      onConnected: () => connected++,
      onMessage: () => messages++,
      onError: () => errors++,
      onClose: () => closed++,
      onReconnecting: () => reconnecting++,
    })

    try {
      await client.connect()
      const first = FakeWebSocket.instances[0]!
      first.emit('open')
      client.close()

      await client.connect()
      const second = FakeWebSocket.instances[1]!
      second.emit('open')
      const pingInterval = (client as any).pingInterval

      first.emit('close', { code: 1006, reason: 'late close' })
      first.emit('message', { data: '{"type":"assistant"}' })
      first.emit('error')
      first.emit('pong')

      expect(client.isConnected()).toBe(true)
      expect((client as any).ws).toBe(second)
      expect((client as any).pingInterval).toBe(pingInterval)
      expect((client as any).reconnectTimer).toBeNull()
      expect(FakeWebSocket.instances).toHaveLength(2)
      expect(connected).toBe(2)
      expect(messages).toBe(0)
      expect(errors).toBe(0)
      expect(closed).toBe(0)
      expect(reconnecting).toBe(0)

      client.sendControlResponse({
        type: 'control_response',
        response: { subtype: 'success' },
      } as any)
      expect(second.sent).toHaveLength(1)
    } finally {
      client.close()
      FakeWebSocket.constructorHook = null
      globalThis.WebSocket = originalWebSocket
    }
  })

  test('setup failure is retryable', async () => {
    const originalWebSocket = globalThis.WebSocket
    FakeWebSocket.instances = []
    FakeWebSocket.constructorHook = () => {
      throw new Error('setup failed')
    }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket

    const client = new SessionsWebSocket('session-1', 'org-1', () => 'token', {
      onMessage: () => {},
    })

    try {
      await expect(client.connect()).rejects.toThrow('setup failed')

      FakeWebSocket.constructorHook = null
      await client.connect()
      const socket = FakeWebSocket.instances[1]!
      socket.emit('open')

      expect(client.isConnected()).toBe(true)
      expect((client as any).ws).toBe(socket)
    } finally {
      client.close()
      FakeWebSocket.constructorHook = null
      globalThis.WebSocket = originalWebSocket
    }
  })

  test('setup failure during reconnect continues the existing retry policy', async () => {
    const originalWebSocket = globalThis.WebSocket
    FakeWebSocket.instances = []
    FakeWebSocket.constructorHook = null
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket

    let reconnecting = 0
    const client = new SessionsWebSocket('session-1', 'org-1', () => 'token', {
      onMessage: () => {},
      onReconnecting: () => reconnecting++,
    })

    try {
      await client.connect()
      FakeWebSocket.instances[0]!.emit('open')
      FakeWebSocket.instances[0]!.emit('close', { code: 1006, reason: '' })

      clearTimeout((client as any).reconnectTimer)
      ;(client as any).reconnectTimer = null
      FakeWebSocket.constructorHook = () => {
        throw new Error('reconnect setup failed')
      }
      await (client as any).connectForReconnect()

      expect((client as any).state).toBe('closed')
      expect((client as any).reconnectAttempts).toBe(2)
      expect((client as any).reconnectTimer).not.toBeNull()
      expect(reconnecting).toBe(2)
    } finally {
      client.close()
      FakeWebSocket.constructorHook = null
      globalThis.WebSocket = originalWebSocket
    }
  })

  test('close wins while setup is in progress', async () => {
    const originalWebSocket = globalThis.WebSocket
    FakeWebSocket.instances = []
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket

    const client = new SessionsWebSocket('session-1', 'org-1', () => 'token', {
      onMessage: () => {},
    })
    FakeWebSocket.constructorHook = socket => {
      client.close()
      expect(socket.closed).toBe(false)
    }

    try {
      await client.connect()

      expect(client.isConnected()).toBe(false)
      expect((client as any).state).toBe('closed')
      expect(FakeWebSocket.instances[0]?.closed).toBe(true)
      expect((client as any).ws).toBeNull()
    } finally {
      client.close()
      FakeWebSocket.constructorHook = null
      globalThis.WebSocket = originalWebSocket
    }
  })

  test('old setup failure does not reset a newer connection', async () => {
    const originalWebSocket = globalThis.WebSocket
    FakeWebSocket.instances = []
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket

    const client = new SessionsWebSocket('session-1', 'org-1', () => 'token', {
      onMessage: () => {},
    })
    let nestedConnect: Promise<void> | null = null
    FakeWebSocket.constructorHook = () => {
      FakeWebSocket.constructorHook = null
      client.close()
      nestedConnect = client.connect()
      throw new Error('old setup failed')
    }

    try {
      await expect(client.connect()).rejects.toThrow('old setup failed')
      await nestedConnect
      const socket = FakeWebSocket.instances[1]!
      socket.emit('open')

      expect(client.isConnected()).toBe(true)
      expect((client as any).ws).toBe(socket)
    } finally {
      client.close()
      FakeWebSocket.constructorHook = null
      globalThis.WebSocket = originalWebSocket
    }
  })
})
