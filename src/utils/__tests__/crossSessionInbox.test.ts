import { describe, expect, test } from 'bun:test'
import {
  CrossSessionInbox,
  type CrossSessionInboundMessage,
  type PeerReceiptStatus,
} from '../crossSessionInbox.js'

function message(
  msgId: string,
  overrides: Partial<CrossSessionInboundMessage> = {},
): CrossSessionInboundMessage {
  return {
    msgId,
    uuid: msgId,
    from: 'uds:/tmp/sender.sock',
    content: `body ${msgId}`,
    priority: 'next',
    transport: 'uds',
    ...overrides,
  }
}

function harness(heldLimit?: number) {
  let policy: 'accept' | 'hold' | 'refuse' | undefined
  let mode: 'prompting' | 'bypass' = 'prompting'
  const delivered: CrossSessionInboundMessage[] = []
  const receipts: Array<{ msgId: string; status: PeerReceiptStatus }> = []
  const held: string[] = []
  const dropped: string[] = []
  const inbox = new CrossSessionInbox({
    getPolicy: () => policy,
    getPermissionClass: () => mode,
    deliver: item => {
      delivered.push(item)
    },
    sendReceipt: (item, status) => {
      receipts.push({ msgId: item.msgId, status })
    },
    onHeld: item => held.push(item.msgId),
    onDropped: item => {
      dropped.push(item.msgId)
    },
    heldLimit,
  })
  return {
    inbox,
    delivered,
    receipts,
    held,
    dropped,
    setPolicy(value: typeof policy) {
      policy = value
    },
    setMode(value: typeof mode) {
      mode = value
    },
  }
}

describe('CrossSessionInbox', () => {
  test('accepts matching permission classes and holds mismatches', async () => {
    const h = harness()
    h.setMode('bypass')

    expect(await h.inbox.receive(message('same', { fromMode: 'bypass' }))).toBe(
      'delivered',
    )
    expect(
      await h.inbox.receive(message('different', { fromMode: 'prompting' })),
    ).toBe('held')
    expect(await h.inbox.receive(message('missing'))).toBe('held')
    expect(h.delivered.map(item => item.msgId)).toEqual(['same'])
    expect(h.receipts).toEqual([
      { msgId: 'same', status: 'delivered' },
      { msgId: 'different', status: 'held' },
      { msgId: 'missing', status: 'held' },
    ])
  })

  test('explicit policy overrides mode defaults and self-sent messages', async () => {
    const h = harness()
    h.setMode('bypass')
    h.setPolicy('hold')
    expect(
      await h.inbox.receive(
        message('explicit-hold', { selfSent: true, fromMode: 'bypass' }),
      ),
    ).toBe('held')

    h.setPolicy('refuse')
    expect(await h.inbox.receive(message('refused'))).toBe('denied')
    expect(h.delivered).toEqual([])
    expect(h.receipts.at(-1)).toEqual({
      msgId: 'refused',
      status: 'denied',
    })
  })

  test('approves or denies a held message exactly once', async () => {
    const h = harness()
    h.setPolicy('hold')
    await h.inbox.receive(message('approve'))
    await h.inbox.receive(message('deny'))

    expect(await h.inbox.resolveHeld('approve', 'approve')).toBe('delivered')
    expect(await h.inbox.resolveHeld('approve', 'approve')).toBe('gone')
    expect(await h.inbox.resolveHeld('deny', 'deny')).toBe('dropped')
    expect(h.delivered.map(item => item.msgId)).toEqual(['approve'])
    expect(h.receipts).toEqual([
      { msgId: 'approve', status: 'held' },
      { msgId: 'deny', status: 'held' },
      { msgId: 'approve', status: 'delivered' },
      { msgId: 'deny', status: 'denied' },
    ])
  })

  test('re-evaluates held messages when policy changes', async () => {
    const h = harness()
    h.setPolicy('hold')
    await h.inbox.receive(message('release'))
    await h.inbox.receive(message('drop'))

    h.setPolicy('accept')
    expect(await h.inbox.reevaluate()).toBe(2)
    expect(h.delivered.map(item => item.msgId)).toEqual(['release', 'drop'])

    h.setPolicy('hold')
    await h.inbox.receive(message('later-deny'))
    h.setPolicy('refuse')
    expect(await h.inbox.reevaluate()).toBe(0)
    expect(h.receipts.at(-1)).toEqual({
      msgId: 'later-deny',
      status: 'denied',
    })
  })

  test('serializes concurrent held-message reevaluation', async () => {
    let policy: 'accept' | 'hold' = 'hold'
    let releaseDelivery!: () => void
    const deliveryGate = new Promise<void>(resolve => {
      releaseDelivery = resolve
    })
    let deliveries = 0
    const inbox = new CrossSessionInbox({
      getPolicy: () => policy,
      getPermissionClass: () => 'prompting',
      deliver: async () => {
        deliveries += 1
        await deliveryGate
      },
    })

    await inbox.receive(message('concurrent-reevaluate'))
    policy = 'accept'
    const first = inbox.reevaluate()
    await Promise.resolve()
    const second = inbox.reevaluate()
    await Promise.resolve()
    expect(deliveries).toBe(1)

    releaseDelivery()
    expect(await Promise.all([first, second])).toEqual([1, 0])
    expect(deliveries).toBe(1)
  })

  test('serializes reevaluation with manual held-message resolution', async () => {
    let policy: 'accept' | 'hold' = 'hold'
    let releaseDelivery!: () => void
    const deliveryGate = new Promise<void>(resolve => {
      releaseDelivery = resolve
    })
    let deliveries = 0
    const inbox = new CrossSessionInbox({
      getPolicy: () => policy,
      getPermissionClass: () => 'prompting',
      deliver: async () => {
        deliveries += 1
        await deliveryGate
      },
    })

    await inbox.receive(message('reevaluate-and-resolve'))
    policy = 'accept'
    const reevaluate = inbox.reevaluate()
    await Promise.resolve()
    const resolve = inbox.resolveHeld('reevaluate-and-resolve', 'approve')
    await Promise.resolve()
    expect(deliveries).toBe(1)

    releaseDelivery()
    expect(await Promise.all([reevaluate, resolve])).toEqual([1, 'gone'])
    expect(deliveries).toBe(1)
  })

  test('expires the oldest held message at capacity and all held on shutdown', async () => {
    const h = harness(2)
    h.setPolicy('hold')
    await h.inbox.receive(message('one'))
    await h.inbox.receive(message('two'))
    await h.inbox.receive(message('three'))

    expect(h.dropped).toEqual(['one'])
    expect(h.receipts.at(-2)).toEqual({ msgId: 'one', status: 'expired' })
    await h.inbox.shutdown()
    expect(h.receipts.slice(-2)).toEqual([
      { msgId: 'two', status: 'expired' },
      { msgId: 'three', status: 'expired' },
    ])
  })

  test('waits for held-message cleanup before settling a dropped message', async () => {
    let cleaned = false
    let releaseCleanup!: () => void
    const cleanupGate = new Promise<void>(resolve => {
      releaseCleanup = resolve
    })
    const receipts: PeerReceiptStatus[] = []
    const inbox = new CrossSessionInbox({
      getPolicy: () => 'hold',
      getPermissionClass: () => 'prompting',
      deliver: () => undefined,
      onDropped: async () => {
        await cleanupGate
        cleaned = true
      },
      sendReceipt: (_message, status) => {
        receipts.push(status)
      },
    })

    await inbox.receive(message('cleanup'))
    const shutdown = inbox.shutdown()
    await Promise.resolve()
    expect(receipts).toEqual(['held'])
    releaseCleanup()
    await shutdown
    expect(cleaned).toBe(true)
    expect(receipts).toEqual(['held', 'expired'])
  })

  test('deduplicates repeated msg_id values without re-delivery', async () => {
    const h = harness()
    expect(await h.inbox.receive(message('duplicate'))).toBe('delivered')
    expect(await h.inbox.receive(message('duplicate'))).toBe('delivered')
    expect(h.delivered).toHaveLength(1)
    expect(h.receipts).toHaveLength(1)
  })
})
