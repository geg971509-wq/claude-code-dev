import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'events'
import { WebSocketTransport } from '../WebSocketTransport.js'

type Listener = (event: any) => void

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static constructorHook: ((socket: FakeWebSocket) => void) | null = null

  private readonly listeners = new Map<string, Listener[]>()
  closed = false

  constructor(_url: string, _options?: unknown) {
    FakeWebSocket.instances.push(this)
    FakeWebSocket.constructorHook?.(this)
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? []
    this.listeners.set(
      type,
      listeners.filter(candidate => candidate !== listener),
    )
  }

  emit(type: string, event: any = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  capture(type: string): (event?: any) => void {
    const listeners = [...(this.listeners.get(type) ?? [])]
    return (event: any = {}) => {
      for (const listener of listeners) listener(event)
    }
  }

  close(): void {
    this.closed = true
  }

  send(_data: string): void {}

  ping(): void {}
}

function createTransport(): WebSocketTransport {
  return new WebSocketTransport(new URL('wss://example.com/session'))
}

class FakeNodeWebSocket extends EventEmitter {
  closed = false

  close(): void {
    this.closed = true
    queueMicrotask(() => {
      this.emit('error', new Error('closed before connection established'))
    })
  }

  send(_data: string): void {}

  ping(): void {}
}

describe('WebSocketTransport setup ownership', () => {
  test('initial setup failure returns to idle and can be retried', async () => {
    const originalWebSocket = globalThis.WebSocket
    FakeWebSocket.instances = []
    FakeWebSocket.constructorHook = () => {
      throw new Error('setup failed')
    }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const transport = createTransport()

    try {
      await expect(transport.connect()).rejects.toThrow('setup failed')
      expect(transport.getStateLabel()).toBe('idle')

      FakeWebSocket.constructorHook = null
      await transport.connect()
      FakeWebSocket.instances[1]?.emit('open')

      expect(transport.isConnectedStatus()).toBe(true)
    } finally {
      transport.close()
      FakeWebSocket.constructorHook = null
      globalThis.WebSocket = originalWebSocket
    }
  })

  test('reconnect setup failure uses the existing reconnect policy', async () => {
    const originalWebSocket = globalThis.WebSocket
    FakeWebSocket.instances = []
    FakeWebSocket.constructorHook = null
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const transport = createTransport()

    try {
      await transport.connect()
      const first = FakeWebSocket.instances[0]!
      first.emit('open')
      first.emit('close', { code: 1006 })
      const firstTimer = (transport as any).reconnectTimer

      clearTimeout(firstTimer)
      ;(transport as any).reconnectTimer = null
      FakeWebSocket.constructorHook = () => {
        throw new Error('reconnect setup failed')
      }
      await expect(transport.connect()).rejects.toThrow(
        'reconnect setup failed',
      )

      expect(transport.getStateLabel()).toBe('reconnecting')
      expect((transport as any).reconnectAttempts).toBe(2)
      expect((transport as any).reconnectTimer).not.toBeNull()
    } finally {
      transport.close()
      FakeWebSocket.constructorHook = null
      globalThis.WebSocket = originalWebSocket
    }
  })

  test('close wins while setup is in progress', async () => {
    const originalWebSocket = globalThis.WebSocket
    FakeWebSocket.instances = []
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const transport = createTransport()
    FakeWebSocket.constructorHook = () => transport.close()

    try {
      await transport.connect()

      expect(transport.isClosedStatus()).toBe(true)
      expect(FakeWebSocket.instances[0]?.closed).toBe(true)
      expect((transport as any).ws).toBeNull()
    } finally {
      transport.close()
      FakeWebSocket.constructorHook = null
      globalThis.WebSocket = originalWebSocket
    }
  })

  test('old setup failure does not reset a newer connection', async () => {
    const originalWebSocket = globalThis.WebSocket
    FakeWebSocket.instances = []
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const transport = createTransport()
    let nestedConnect: Promise<void> | null = null
    FakeWebSocket.constructorHook = () => {
      FakeWebSocket.constructorHook = null
      nestedConnect = transport.connect()
      throw new Error('old setup failed')
    }

    try {
      await expect(transport.connect()).rejects.toThrow('old setup failed')
      await nestedConnect
      const socket = FakeWebSocket.instances[1]!
      socket.emit('open')

      expect(transport.isConnectedStatus()).toBe(true)
      expect((transport as any).ws).toBe(socket)
    } finally {
      transport.close()
      FakeWebSocket.constructorHook = null
      globalThis.WebSocket = originalWebSocket
    }
  })

  test('closing a handshaking Node socket absorbs its expected error', async () => {
    const transport = createTransport()
    const socket = new FakeNodeWebSocket()
    ;(transport as any).addNodeListeners(socket)

    expect(() => (transport as any).closeWebSocket(socket)).not.toThrow()
    await Promise.resolve()

    expect(socket.closed).toBe(true)
    expect(socket.listenerCount('open')).toBe(0)
    expect(socket.listenerCount('message')).toBe(0)
    expect(socket.listenerCount('close')).toBe(0)
    expect(socket.listenerCount('error')).toBe(0)
  })

  test('late events from an old socket do not disturb the current connection', async () => {
    const originalWebSocket = globalThis.WebSocket
    FakeWebSocket.instances = []
    FakeWebSocket.constructorHook = null
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const transport = createTransport()
    let connected = 0
    let messages = 0
    transport.setOnConnect(() => connected++)
    transport.setOnData(() => messages++)

    try {
      await transport.connect()
      const first = FakeWebSocket.instances[0]!
      const lateOpen = first.capture('open')
      const lateMessage = first.capture('message')
      const lateError = first.capture('error')
      const lateClose = first.capture('close')
      const latePong = first.capture('pong')

      await transport.connect()
      const second = FakeWebSocket.instances[1]!
      second.emit('open')
      ;(transport as any).pongReceived = false

      lateOpen()
      lateMessage({ data: '{"type":"old"}' })
      lateError()
      lateClose({ code: 1006 })
      latePong()

      expect(transport.isConnectedStatus()).toBe(true)
      expect((transport as any).ws).toBe(second)
      expect(second.closed).toBe(false)
      expect((transport as any).reconnectTimer).toBeNull()
      expect((transport as any).pongReceived).toBe(false)
      expect(connected).toBe(1)
      expect(messages).toBe(0)
    } finally {
      transport.close()
      FakeWebSocket.constructorHook = null
      globalThis.WebSocket = originalWebSocket
    }
  })
})
