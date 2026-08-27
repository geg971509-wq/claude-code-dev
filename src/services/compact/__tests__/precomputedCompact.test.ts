import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type {
  AssistantMessage,
  Message,
  MessageContent,
} from '../../../types/message.js'
import type { PreparedCompactSummary } from '../compact.js'
import {
  mergePrecomputedResult,
  PrecomputedCompactManager,
  type PrecomputedCompactEntry,
  type PrecomputedCompactTransition,
} from '../precomputedCompact.js'
import type { PrecomputedCompactStore } from '../precomputedCompactStore.js'

function message(
  type: Message['type'],
  content: MessageContent = type,
  extra: Record<string, unknown> = {},
): Message {
  return {
    type,
    uuid: randomUUID(),
    message: { role: type, content },
    ...extra,
  }
}

function preparedSummary(
  messagesToKeep: Message[] = [],
): PreparedCompactSummary {
  return {
    summaryResponse: message(
      'assistant',
      'prepared summary',
    ) as AssistantMessage,
    summary: 'prepared summary',
    messagesToKeep,
    preservedUserSection: '',
  }
}

function finalizedResult(messagesToKeep: Message[] = []) {
  return {
    boundaryMarker: { ...message('system'), type: 'system' },
    summaryMessages: [],
    attachments: [],
    hookResults: [],
    messagesToKeep,
  }
}

function readyEntry(
  anchor: Message,
  overrides: Partial<PrecomputedCompactEntry> = {},
): PrecomputedCompactEntry & { result: PreparedCompactSummary } {
  return {
    key: 'main',
    status: 'ready',
    sessionId: 'session',
    model: 'model',
    precomputedAtUuid: anchor.uuid,
    preservedUuids: [anchor.uuid],
    preCompactTokens: 1,
    createdAt: Date.now(),
    result: preparedSummary([anchor]),
    ...overrides,
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolvePromise: (value: T) => void = () => {}
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

function memoryStore(initial?: unknown): PrecomputedCompactStore & {
  writes: unknown[]
  clears: number
  reads: number
} {
  let value = initial
  return {
    writes: [],
    clears: 0,
    reads: 0,
    async read() {
      this.reads++
      return value
    },
    async write(next) {
      this.writes.push(next)
      value = next
    },
    async clear() {
      this.clears++
      value = undefined
    },
  }
}

describe('PrecomputedCompactManager state machine', () => {
  test('transitions pending to ready, borrows without removal, then consumes', async () => {
    const anchor = message('user')
    const pending = deferred<
      PrecomputedCompactEntry & { result: PreparedCompactSummary }
    >()
    const manager = new PrecomputedCompactManager('session', false)

    expect(await manager.arm('main', () => pending.promise)).toBe(true)
    expect(manager.get('main')?.status).toBe('pending')
    pending.resolve(readyEntry(anchor))

    expect((await manager.borrow('main'))?.status).toBe('ready')
    expect(manager.get('main')?.status).toBe('ready')
    expect(
      (await manager.consume('main', 'model', [anchor]))?.result
        ?.messagesToKeep,
    ).toEqual([anchor])
    expect(manager.get('main')).toBeUndefined()
  })

  test('emits ready and discarded owner transitions with stable reasons', async () => {
    const anchor = message('user')
    const transitions: PrecomputedCompactTransition[] = []
    const manager = new PrecomputedCompactManager('session', false)

    await manager.arm(
      'main',
      async () => readyEntry(anchor),
      event => transitions.push(event),
    )
    await manager.wait('main')
    await manager.discard('main')

    expect(transitions).toEqual([
      {
        state: 'ready',
        reason: 'precompute_ready',
        preCompactTokens: 1,
      },
      { state: 'discarded', reason: 'precompute_discarded' },
    ])
  })

  test('aborting a borrow stops only the wait and leaves the producer armed', async () => {
    const anchor = message('user')
    const pending = deferred<
      PrecomputedCompactEntry & { result: PreparedCompactSummary }
    >()
    const manager = new PrecomputedCompactManager('session', false)
    const controller = new AbortController()

    await manager.arm('main', () => pending.promise)
    const borrowed = manager.borrow('main', controller.signal)
    controller.abort()

    expect(await borrowed).toBeUndefined()
    expect(manager.get('main')?.status).toBe('pending')
    pending.resolve(readyEntry(anchor))
    expect((await manager.borrow('main'))?.status).toBe('ready')
  })

  test('cleanup aborts work and generation prevents a late write', async () => {
    const anchor = message('user')
    const pending = deferred<
      PrecomputedCompactEntry & { result: PreparedCompactSummary }
    >()
    const store = memoryStore()
    const manager = new PrecomputedCompactManager('session', true, store)

    await manager.arm('main', () => pending.promise)
    await manager.cleanup()
    pending.resolve(readyEntry(anchor))
    await Promise.resolve()
    await Promise.resolve()

    expect(manager.get('main')).toBeUndefined()
    expect(store.writes).toEqual([])
    expect(store.clears).toBe(1)
  })

  test('shutdown aborts active work without deleting a restartable sidecar', async () => {
    const anchor = message('user')
    const store = memoryStore()
    const manager = new PrecomputedCompactManager('session', true, store)

    await manager.arm('main', async () =>
      readyEntry(anchor, { preCompactTokens: 100 }),
    )
    await manager.wait('main')
    expect(store.writes).toHaveLength(1)

    await manager.shutdown()

    expect(manager.get('main')).toBeUndefined()
    expect(store.clears).toBe(0)
  })

  test('records failures and stops arming after three consecutive failures', async () => {
    const manager = new PrecomputedCompactManager('session', false)

    for (let attempt = 0; attempt < 3; attempt++) {
      expect(
        await manager.arm('main', async () => {
          throw new Error(`failure-${attempt}`)
        }),
      ).toBe(true)
      expect((await manager.borrow('main'))?.status).toBe('failed')
      await manager.discard('main')
    }

    expect(
      await manager.arm('main', async () => readyEntry(message('user'))),
    ).toBe(false)
  })

  test('clears persisted state when the producer fails', async () => {
    const store = memoryStore()
    const manager = new PrecomputedCompactManager('session', true, store)

    await manager.arm('main', async () => {
      throw new Error('failed')
    })
    await manager.wait('main')

    expect(store.clears).toBe(1)
  })

  test('keeps subagent entries memory-only', async () => {
    const anchor = message('user')
    const store = memoryStore({ main: 'ready' })
    const manager = new PrecomputedCompactManager('session', true, store)

    await manager.arm('agent-1', async () =>
      readyEntry(anchor, { key: 'agent-1' }),
    )
    await manager.wait('agent-1')
    await manager.discard('agent-1')

    expect(store.writes).toEqual([])
    expect(store.clears).toBe(0)
  })

  test('turns a synchronous producer throw into a failed entry', async () => {
    const manager = new PrecomputedCompactManager('session', false)
    const transitions: PrecomputedCompactTransition[] = []

    expect(
      await manager.arm(
        'main',
        () => {
          throw new Error('synchronous failure')
        },
        event => transitions.push(event),
      ),
    ).toBe(true)
    expect(await manager.borrow('main')).toMatchObject({
      status: 'failed',
      error: 'synchronous failure',
    })
    expect(transitions).toEqual([
      { state: 'failed', reason: 'precompute_failed' },
    ])
  })

  test('treats a sidecar read failure as an absent restart result', async () => {
    const store: PrecomputedCompactStore = {
      async read() {
        throw new Error('read EACCES')
      },
      async write() {},
      async clear() {},
    }
    const manager = new PrecomputedCompactManager('session', true, store)

    expect(await manager.rehydrate('model', [message('user')])).toBe(false)
  })

  test('keeps an in-memory result ready when sidecar persistence fails', async () => {
    const anchor = message('user')
    const store: PrecomputedCompactStore = {
      async read() {},
      async write() {
        throw new Error('write EACCES')
      },
      async clear() {},
    }
    const manager = new PrecomputedCompactManager('session', true, store)

    await manager.arm('main', async () => readyEntry(anchor))

    expect((await manager.wait('main'))?.status).toBe('ready')
    expect(await manager.consume('main', 'model', [anchor])).toBeDefined()
  })

  test('returns a consumed result when sidecar cleanup fails', async () => {
    const anchor = message('user')
    const store: PrecomputedCompactStore = {
      async read() {},
      async write() {},
      async clear() {
        throw new Error('clear EACCES')
      },
    }
    const manager = new PrecomputedCompactManager('session', true, store)

    await manager.arm('main', async () => readyEntry(anchor))
    await manager.wait('main')

    expect(await manager.consume('main', 'model', [anchor])).toBeDefined()
  })
})

describe('PrecomputedCompactManager validation', () => {
  test('rehydrates only a complete matching ready entry', async () => {
    const anchor = message('user', 'x'.repeat(400))
    const stored = readyEntry(anchor, { preCompactTokens: 100 })
    const manager = new PrecomputedCompactManager(
      'session',
      true,
      memoryStore(stored),
    )
    const transitions: PrecomputedCompactTransition[] = []

    expect(
      await manager.rehydrate('model', [anchor], {
        onTransition: event => transitions.push(event),
      }),
    ).toBe(true)
    expect(manager.get('main')).toEqual(stored)
    expect(transitions).toEqual([
      {
        state: 'rehydrated',
        reason: 'precompute_rehydrated',
        preCompactTokens: 100,
      },
    ])
  })

  test('persists summary-only work instead of finalized compact lifecycle output', async () => {
    const anchor = message('user', 'x'.repeat(400))
    const prepared = readyEntry(anchor, { preCompactTokens: 100 })
    const preparedStore = memoryStore(prepared)
    const preparedManager = new PrecomputedCompactManager(
      'session',
      true,
      preparedStore,
    )

    expect(await preparedManager.rehydrate('model', [anchor])).toBe(true)

    const finalizedStore = memoryStore({
      ...readyEntry(anchor, { preCompactTokens: 100 }),
      result: finalizedResult([anchor]),
    })
    const finalizedManager = new PrecomputedCompactManager(
      'session',
      true,
      finalizedStore,
    )

    expect(await finalizedManager.rehydrate('model', [anchor])).toBe(false)
    expect(finalizedStore.clears).toBe(1)
  })

  test('attempts startup rehydration only once', async () => {
    const anchor = message('user', 'x'.repeat(400))
    const store = memoryStore(readyEntry(anchor, { preCompactTokens: 100 }))
    const manager = new PrecomputedCompactManager('session', true, store)

    expect(await manager.rehydrate('model', [anchor])).toBe(true)
    expect(await manager.rehydrate('model', [anchor])).toBe(false)

    expect(store.reads).toBe(1)
  })

  test.each([
    ['wrong session', { sessionId: 'other' }],
    ['wrong model', { model: 'other' }],
    ['failed status', { status: 'failed' as const }],
    ['expired', { createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000 }],
    ['future timestamp', { createdAt: Date.now() + 2 * 60 * 1000 }],
    ['missing result', { result: undefined }],
    ['invalid token count', { preCompactTokens: -1 }],
  ])('discards %s sidecars', async (_name, overrides) => {
    const anchor = message('user', 'x'.repeat(400))
    const store = memoryStore(readyEntry(anchor, overrides))
    const manager = new PrecomputedCompactManager('session', true, store)

    expect(await manager.rehydrate('model', [anchor])).toBe(false)
    expect(store.clears).toBe(1)
  })

  test('rejects missing preserved messages and anchor ambiguity', async () => {
    const anchor = message('user', 'x'.repeat(400))
    const missing = message('user')
    const stored = readyEntry(anchor, {
      preservedUuids: [anchor.uuid, missing.uuid],
      preCompactTokens: 100,
    })
    const store = memoryStore(stored)
    const manager = new PrecomputedCompactManager('session', true, store)

    expect(await manager.rehydrate('model', [anchor, { ...anchor }])).toBe(
      false,
    )
    expect(store.clears).toBe(1)
  })

  test('rejects malformed compaction results and mismatched preserved UUIDs', async () => {
    const anchor = message('user', 'x'.repeat(400))
    const malformedStore = memoryStore({
      ...readyEntry(anchor, { preCompactTokens: 100 }),
      result: {},
    })
    expect(
      await new PrecomputedCompactManager(
        'session',
        true,
        malformedStore,
      ).rehydrate('model', [anchor]),
    ).toBe(false)

    const mismatchStore = memoryStore(
      readyEntry(anchor, {
        preCompactTokens: 100,
        preservedUuids: [],
      }),
    )
    expect(
      await new PrecomputedCompactManager(
        'session',
        true,
        mismatchStore,
      ).rehydrate('model', [anchor]),
    ).toBe(false)
  })

  test('rejects token growth above 150k and shrinkage above 50 percent', async () => {
    const anchor = message('user', 'x'.repeat(700_000))
    const growthStore = memoryStore(
      readyEntry(anchor, {
        preCompactTokens: 1,
        preservedUuids: [anchor.uuid],
      }),
    )
    expect(
      await new PrecomputedCompactManager(
        'session',
        true,
        growthStore,
      ).rehydrate('model', [anchor]),
    ).toBe(false)

    const small = message('user', 'tiny')
    const shrinkStore = memoryStore(
      readyEntry(small, {
        preCompactTokens: 100,
        preservedUuids: [small.uuid],
      }),
    )
    expect(
      await new PrecomputedCompactManager(
        'session',
        true,
        shrinkStore,
      ).rehydrate('model', [small]),
    ).toBe(false)
  })

  test.each([
    ['a duplicate anchor', (anchor: Message) => [anchor, { ...anchor }]],
    [
      'a later compact boundary',
      (anchor: Message) => [
        anchor,
        message('system', 'boundary', {
          subtype: 'compact_boundary',
          compactMetadata: {},
        }),
      ],
    ],
    [
      'a broken parent chain',
      (anchor: Message) => [
        anchor,
        message('user', 'next', { parentUuid: randomUUID() }),
      ],
    ],
    [
      'an orphan tool result',
      (anchor: Message) => [
        anchor,
        message('user', [
          { type: 'tool_result', tool_use_id: 'missing', content: 'nope' },
        ]),
      ],
    ],
    [
      'an unresolved tool use',
      (anchor: Message) => [
        anchor,
        message('assistant', [
          { type: 'tool_use', id: 'pending', name: 'Read', input: {} },
        ]),
      ],
    ],
  ])('discards ready results when the suffix contains %s', async (_name, build) => {
    const anchor = message('user')
    const manager = new PrecomputedCompactManager('session', false)
    await manager.arm('main', async () => readyEntry(anchor))
    await manager.wait('main')

    expect(
      await manager.consume('main', 'model', build(anchor)),
    ).toBeUndefined()
    expect(manager.get('main')).toBeUndefined()
  })

  test('rejects a new assistant round before the prior tool use is resolved', async () => {
    const anchor = message('user')
    const manager = new PrecomputedCompactManager('session', false)
    await manager.arm('main', async () => readyEntry(anchor))
    await manager.wait('main')
    const first = message('assistant', [
      { type: 'tool_use', id: 'tool', name: 'Read', input: {} },
    ])
    first.message = { ...first.message, id: 'assistant-1' }
    const second = message('assistant', 'too early')
    second.message = { ...second.message, id: 'assistant-2' }
    const toolResult = message('user', [
      { type: 'tool_result', tool_use_id: 'tool', content: 'ok' },
    ])
    const final = message('assistant', 'done')
    final.message = { ...final.message, id: 'assistant-3' }

    expect(
      await manager.consume('main', 'model', [
        anchor,
        first,
        second,
        toolResult,
        final,
      ]),
    ).toBeUndefined()
  })

  test('clears persisted state after successful consumption', async () => {
    const anchor = message('user', 'x'.repeat(400))
    const store = memoryStore()
    const manager = new PrecomputedCompactManager('session', true, store)
    await manager.arm('main', async () =>
      readyEntry(anchor, { preCompactTokens: 100 }),
    )

    expect(await manager.consume('main', 'model', [anchor])).toBeDefined()
    expect(store.clears).toBe(1)
  })

  test('clears persisted state when the anchor is lost before consumption', async () => {
    const anchor = message('user', 'x'.repeat(400))
    const store = memoryStore()
    const manager = new PrecomputedCompactManager('session', true, store)
    await manager.arm('main', async () =>
      readyEntry(anchor, { preCompactTokens: 100 }),
    )

    expect(
      await manager.consume('main', 'model', [message('user')]),
    ).toBeUndefined()
    expect(store.clears).toBe(1)
  })

  test('accepts complete tool rounds followed by one terminal user turn', async () => {
    const anchor = message('user')
    const manager = new PrecomputedCompactManager('session', false)
    await manager.arm('main', async () => readyEntry(anchor))
    await manager.wait('main')
    const toolUse = message('assistant', [
      { type: 'tool_use', id: 'tool', name: 'Read', input: {} },
    ])
    toolUse.message = { ...toolUse.message, id: 'assistant-1' }
    const toolResult = message('user', [
      { type: 'tool_result', tool_use_id: 'tool', content: 'ok' },
    ])
    const response = message('assistant', 'done')
    response.message = { ...response.message, id: 'assistant-2' }
    const terminalUser = message('user', 'next')

    expect(
      await manager.consume('main', 'model', [
        anchor,
        toolUse,
        toolResult,
        response,
        terminalUser,
      ]),
    ).toBeDefined()
  })
})

describe('mergePrecomputedResult', () => {
  test('merges preserved messages and suffix in chain order without duplicate UUIDs', () => {
    const preserved = message('user', 'preserved')
    const anchor = message('assistant', 'anchor')
    const overlap = message('user', 'overlap')
    const suffix = message('assistant', 'suffix')
    const entry = readyEntry(anchor, {
      preservedUuids: [preserved.uuid, anchor.uuid, overlap.uuid],
      result: preparedSummary([preserved, anchor, overlap]),
    })

    const merged = mergePrecomputedResult(entry, [
      preserved,
      anchor,
      overlap,
      suffix,
    ])

    expect(merged?.messagesToKeep?.map(item => item.uuid)).toEqual([
      preserved.uuid,
      anchor.uuid,
      overlap.uuid,
      suffix.uuid,
    ])
  })
})
