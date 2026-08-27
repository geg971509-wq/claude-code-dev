import { describe, expect, test } from 'bun:test'
import type { QueuedCommand } from '../../types/textInputTypes.js'
import {
  PeerInboundRuntime,
  type PeerInboundRuntimeDeps,
} from '../peerInboundRuntime.js'
import type { UdsPeerUserMessage } from '../peerMessageEnvelope.js'

function udsMessage(
  overrides: Partial<UdsPeerUserMessage> = {},
): UdsPeerUserMessage {
  return {
    type: 'user',
    uuid: 'message-1',
    message: { role: 'user', content: 'review the release' },
    priority: 'next',
    from: 'uds:/tmp/sender.sock',
    msg_id: 'message-1',
    fromMode: 'prompting',
    ...overrides,
  }
}

function createHarness(overrides: Partial<PeerInboundRuntimeDeps> = {}): {
  runtime: PeerInboundRuntime
  queued: QueuedCommand[]
  receipts: Array<[string, string]>
} {
  const queued: QueuedCommand[] = []
  const receipts: Array<[string, string]> = []
  const runtime = new PeerInboundRuntime({
    getPolicy: () => undefined,
    getPermissionClass: () => 'prompting',
    enqueue: command => {
      queued.push(command)
    },
    sendReceipt: async (message, status) => {
      receipts.push([message.msgId, status])
    },
    materializeAttachments: async () => ({ prefix: '', paths: [] }),
    materializeRemoteAttachments: async () => ({ prefix: '', paths: [] }),
    cleanupAttachments: async () => undefined,
    ...overrides,
  })
  return { runtime, queued, receipts }
}

describe('PeerInboundRuntime', () => {
  test('delivers an accepted UDS peer message once with structured provenance', async () => {
    const { runtime, queued, receipts } = createHarness()

    expect(await runtime.receiveUds(udsMessage())).toBe('delivered')
    expect(await runtime.receiveUds(udsMessage())).toBe('delivered')

    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({
      mode: 'prompt',
      priority: 'next',
      isMeta: true,
      skipSlashCommands: true,
      origin: {
        kind: 'cross-session',
        transport: 'uds',
        from: 'uds:/tmp/sender.sock',
        msgId: 'message-1',
      },
    })
    expect(queued[0]?.value).toContain(
      '<cross-session-message from="uds:/tmp/sender.sock"',
    )
    expect(receipts).toEqual([['message-1', 'delivered']])
  })

  test('coalesces concurrent duplicate message delivery', async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    let deliveries = 0
    const { runtime, queued } = createHarness({
      enqueue: async command => {
        deliveries++
        await blocked
        queued.push(command)
      },
    })

    const first = runtime.receiveUds(udsMessage())
    const duplicate = runtime.receiveUds(udsMessage())
    release()

    expect(await Promise.all([first, duplicate])).toEqual([
      'delivered',
      'delivered',
    ])
    expect(deliveries).toBe(1)
    expect(queued).toHaveLength(1)
  })

  test('holds a permission mismatch and delivers it after approval', async () => {
    const { runtime, queued, receipts } = createHarness({
      getPermissionClass: () => 'bypass',
    })

    expect(await runtime.receiveUds(udsMessage())).toBe('held')
    expect(runtime.getHeld()).toMatchObject([
      { cause: 'mode-mismatch', message: { msgId: 'message-1' } },
    ])
    expect(queued).toEqual([])

    expect(await runtime.resolveHeld('message-1', 'approve')).toBe('delivered')
    expect(queued).toHaveLength(1)
    expect(receipts).toEqual([
      ['message-1', 'held'],
      ['message-1', 'delivered'],
    ])
  })

  test('materializes UDS attachments before enqueueing their safe paths', async () => {
    const { runtime, queued } = createHarness({
      materializeAttachments: async attachments => {
        expect(attachments).toEqual([{ path: '/spool/a.txt' }])
        return { prefix: '@"/uploads/a.txt" ', paths: ['/uploads/a.txt'] }
      },
    })

    await runtime.receiveUds(
      udsMessage({ file_attachments: [{ path: '/spool/a.txt' }] as never }),
    )

    expect(queued[0]?.value).toContain('@"/uploads/a.txt" review the release')
  })

  test('does not materialize remote attachments until a held message is approved', async () => {
    let policy: 'hold' | 'accept' = 'hold'
    const materialized: unknown[] = []
    const attachments = [{ file_uuid: 'remote-1', file_name: 'report.txt' }]
    const { runtime, queued } = createHarness({
      getPolicy: () => policy,
      materializeRemoteAttachments: async input => {
        materialized.push(input)
        return {
          prefix: '@"/uploads/report.txt" ',
          paths: ['/uploads/report.txt'],
        }
      },
    })

    expect(
      await runtime.receive({
        msgId: 'remote-held',
        uuid: 'remote-held',
        from: 'bridge:sender',
        content: 'review it',
        priority: 'next',
        transport: 'bridge',
        attachments,
      }),
    ).toBe('held')
    expect(materialized).toEqual([])
    expect(queued).toEqual([])

    policy = 'accept'
    expect(await runtime.resolveHeld('remote-held', 'approve')).toBe(
      'delivered',
    )
    expect(materialized).toEqual([attachments])
    expect(queued[0]?.value).toContain('@"/uploads/report.txt" review it')
  })

  test('cleans local spool attachments on deny and shutdown without materializing them', async () => {
    const cleaned: unknown[] = []
    let materializeCalls = 0
    const { runtime } = createHarness({
      getPolicy: () => 'hold',
      materializeAttachments: async () => {
        materializeCalls++
        return { prefix: '', paths: [] }
      },
      cleanupAttachments: async attachments => {
        cleaned.push(attachments)
      },
    })
    const first = [{ path: '/spool/first.txt' }]
    const second = [{ path: '/spool/second.txt' }]

    await runtime.receiveUds(
      udsMessage({
        msg_id: 'deny',
        uuid: 'deny',
        file_attachments: first as never,
      }),
    )
    await runtime.receiveUds(
      udsMessage({
        msg_id: 'shutdown',
        uuid: 'shutdown',
        file_attachments: second as never,
      }),
    )
    await runtime.resolveHeld('deny', 'deny')
    await runtime.shutdown()

    expect(materializeCalls).toBe(0)
    expect(cleaned).toEqual([first, second])
  })

  test('cleans refused and evicted local spool attachments', async () => {
    let policy: 'hold' | 'refuse' = 'refuse'
    const cleaned: unknown[] = []
    const { runtime } = createHarness({
      getPolicy: () => policy,
      cleanupAttachments: async attachments => {
        cleaned.push(attachments)
      },
    })
    const refused = [{ path: '/spool/refused.txt' }]
    expect(
      await runtime.receiveUds(
        udsMessage({ file_attachments: refused as never }),
      ),
    ).toBe('denied')

    policy = 'hold'
    for (let index = 0; index <= 100; index++) {
      await runtime.receiveUds(
        udsMessage({
          msg_id: `held-${index}`,
          uuid: `held-${index}`,
          file_attachments: [{ path: `/spool/${index}.txt` }] as never,
        }),
      )
    }
    expect(cleaned).toEqual([refused, [{ path: '/spool/0.txt' }]])
  })

  test('never downloads remote attachments that are refused, denied, or expired', async () => {
    let policy: 'hold' | 'refuse' = 'refuse'
    let downloads = 0
    const { runtime } = createHarness({
      getPolicy: () => policy,
      materializeRemoteAttachments: async () => {
        downloads++
        return { prefix: '', paths: [] }
      },
    })
    const remote = (
      msgId: string,
    ): Parameters<PeerInboundRuntime['receive']>[0] => ({
      msgId,
      uuid: msgId,
      from: 'cloud:sender',
      content: 'review it',
      priority: 'next',
      transport: 'cloud',
      attachments: [{ file_uuid: msgId, file_name: 'report.txt' }],
    })

    expect(await runtime.receive(remote('refused'))).toBe('denied')
    policy = 'hold'
    await runtime.receive(remote('denied'))
    await runtime.resolveHeld('denied', 'deny')
    await runtime.receive(remote('expired'))
    await runtime.shutdown()
    expect(downloads).toBe(0)
  })

  test('expires and cleans attachments received after shutdown', async () => {
    let materialized = 0
    const cleaned: unknown[] = []
    const attachments = [{ path: '/spool/late.txt' }]
    const { runtime, queued } = createHarness({
      getPolicy: () => 'accept',
      materializeAttachments: async () => {
        materialized++
        return { prefix: '', paths: [] }
      },
      cleanupAttachments: async input => {
        cleaned.push(input)
      },
    })

    await runtime.shutdown()
    expect(
      await runtime.receiveUds(
        udsMessage({ file_attachments: attachments as never }),
      ),
    ).toBe('expired')
    expect(materialized).toBe(0)
    expect(cleaned).toEqual([attachments])
    expect(queued).toEqual([])
  })
})
