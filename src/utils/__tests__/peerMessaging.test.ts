import { describe, expect, test } from 'bun:test'
import type { PeerCandidate, PeerRoster } from '../peerRegistry.js'
import {
  derivePeerMessageSummary,
  OutstandingPeerSendRegistry,
  peerTargetRequiresIsolation,
  sendPeerMessage,
  type PeerTransportSender,
} from '../peerMessaging.js'

const peer = (overrides: Partial<PeerCandidate> = {}): PeerCandidate => ({
  kind: 'local-session',
  transport: 'uds',
  id: 'session-1',
  name: 'worker',
  address: 'uds:/tmp/worker.sock',
  ref: 'abcd',
  mirroredTransports: [],
  ...overrides,
})

const roster = (candidates: PeerCandidate[]): PeerRoster => {
  const byName = new Map<string, PeerCandidate[]>()
  for (const candidate of candidates) {
    const name = candidate.name.toLowerCase()
    byName.set(name, [...(byName.get(name) ?? []), candidate])
  }
  return { candidates, byName, unavailable: {} }
}

function sender(
  calls: Array<{ peer: PeerCandidate; msgId: string; summary: string }>,
): PeerTransportSender {
  return async (candidate, message) => {
    calls.push({
      peer: candidate,
      msgId: message.msgId,
      summary: message.summary,
    })
    return { status: 'delivered' }
  }
}

describe('derivePeerMessageSummary', () => {
  test('uses the first non-empty line and bounds its length', () => {
    expect(derivePeerMessageSummary('\n  First line\nSecond line')).toBe(
      'First line',
    )
    expect(derivePeerMessageSummary('x'.repeat(120))).toHaveLength(80)
  })
})

describe('peerTargetRequiresIsolation', () => {
  test('requires approval only for remote or uncertain remote targets', () => {
    expect(peerTargetRequiresIsolation('bridge:session-1')).toBeTrue()
    expect(peerTargetRequiresIsolation('cloud:session-1')).toBeTrue()
    expect(peerTargetRequiresIsolation('uds:/tmp/local.sock')).toBeFalse()
    expect(
      peerTargetRequiresIsolation(
        'worker',
        roster([peer({ transport: 'bridge', kind: 'bridge-session' })]),
      ),
    ).toBeTrue()
    expect(
      peerTargetRequiresIsolation('missing', {
        ...roster([]),
        unavailable: { cloud: 'fetch_failed' },
      }),
    ).toBeTrue()
    expect(peerTargetRequiresIsolation('worker', roster([peer()]))).toBeFalse()
  })
})

describe('OutstandingPeerSendRegistry', () => {
  test('accepts only the expected peer and legal receipt transitions', () => {
    const registry = new OutstandingPeerSendRegistry()
    registry.register('uds-message', peer())

    expect(
      registry.accept({
        msgId: 'unknown',
        status: 'delivered',
        from: 'uds:/tmp/worker.sock',
      }),
    ).toBeFalse()
    expect(
      registry.accept({
        msgId: 'uds-message',
        status: 'held',
        from: 'uds:/tmp/impostor.sock',
      }),
    ).toBeFalse()
    expect(
      registry.accept({ msgId: 'uds-message', status: 'held' }),
    ).toBeFalse()
    expect(
      registry.accept({
        msgId: 'uds-message',
        status: 'held',
        from: '/tmp/worker.sock',
      }),
    ).toBeTrue()
    expect(
      registry.accept({
        msgId: 'uds-message',
        status: 'held',
        from: 'uds:/tmp/worker.sock',
      }),
    ).toBeFalse()
    expect(
      registry.accept({
        msgId: 'uds-message',
        status: 'delivered',
        from: 'uds:/tmp/worker.sock',
      }),
    ).toBeTrue()
    expect(
      registry.accept({
        msgId: 'uds-message',
        status: 'expired',
        from: 'uds:/tmp/worker.sock',
      }),
    ).toBeFalse()
  })

  test('binds bridge and cloud receipts to their target identities', () => {
    const registry = new OutstandingPeerSendRegistry()
    registry.register(
      'bridge-message',
      peer({
        transport: 'bridge',
        kind: 'bridge-session',
        id: 'bridge-session',
        sessionId: 'bridge-session',
        address: 'bridge:bridge-session',
      }),
    )
    registry.register(
      'cloud-message',
      peer({
        transport: 'cloud',
        kind: 'cloud-session',
        id: 'cloud-session',
        sessionId: 'cloud-session',
        address: 'cloud:cloud-session',
      }),
    )

    expect(
      registry.accept({
        msgId: 'bridge-message',
        status: 'delivered',
        from: 'cloud:bridge-session',
      }),
    ).toBeFalse()
    expect(
      registry.accept({
        msgId: 'bridge-message',
        status: 'delivered',
        from: 'bridge:bridge-session',
      }),
    ).toBeTrue()
    expect(
      registry.accept({
        msgId: 'cloud-message',
        status: 'denied',
        from: 'cloud:cloud-session',
      }),
    ).toBeTrue()
  })

  test('evicts the oldest outstanding send at its configured bound', () => {
    const registry = new OutstandingPeerSendRegistry(2)
    registry.register('first', peer())
    registry.register('second', peer())
    registry.register('third', peer())

    expect(
      registry.accept({
        msgId: 'first',
        status: 'delivered',
        from: 'uds:/tmp/worker.sock',
      }),
    ).toBeFalse()
    expect(
      registry.accept({
        msgId: 'second',
        status: 'delivered',
        from: 'uds:/tmp/worker.sock',
      }),
    ).toBeTrue()
  })
})

describe('sendPeerMessage', () => {
  test('resolves listed names and preserves one stable msg_id', async () => {
    const calls: Array<{
      peer: PeerCandidate
      msgId: string
      summary: string
    }> = []
    const result = await sendPeerMessage(
      { to: 'worker [abcd]', content: 'hello\nthere' },
      {
        discover: async () => roster([peer()]),
        send: sender(calls),
        createMessageId: () => 'msg-1',
      },
    )

    expect(result).toEqual({
      success: true,
      message: 'Message delivered to worker [abcd] via uds',
      msg_id: 'msg-1',
      status: 'delivered',
      target: peer(),
    })
    expect(calls).toEqual([{ peer: peer(), msgId: 'msg-1', summary: 'hello' }])
  })

  test('routes explicit UDS and cloud addresses without discovery', async () => {
    const calls: Array<{
      peer: PeerCandidate
      msgId: string
      summary: string
    }> = []
    const deps = {
      discover: async () => {
        throw new Error('must not discover')
      },
      send: sender(calls),
      createMessageId: () => `msg-${calls.length + 1}`,
    }

    expect(
      await sendPeerMessage(
        { to: 'uds:/tmp/a.sock', content: 'local', summary: 'local peer' },
        deps,
      ),
    ).toMatchObject({ success: true, msg_id: 'msg-1' })
    expect(
      await sendPeerMessage({ to: 'cloud:session-2', content: 'remote' }, deps),
    ).toMatchObject({ success: true, msg_id: 'msg-2' })
    expect(calls.map(call => call.peer.transport)).toEqual(['uds', 'cloud'])
  })

  test('returns bounded ambiguity choices and does not send', async () => {
    const calls: Array<{
      peer: PeerCandidate
      msgId: string
      summary: string
    }> = []
    const result = await sendPeerMessage(
      { to: 'worker', content: 'hello' },
      {
        discover: async () =>
          roster([
            peer(),
            peer({
              id: 'session-2',
              address: 'uds:/tmp/other.sock',
              ref: 'ef01',
            }),
          ]),
        send: sender(calls),
        createMessageId: () => 'msg-1',
      },
    )

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected ambiguous target failure')
    expect(result.error_code).toBe('ambiguous_target')
    expect(result.message).toContain('worker [abcd]')
    expect(result.message).toContain('worker [ef01]')
    expect(calls).toEqual([])
  })

  test('reports discovery failures and rejects retired tcp addressing', async () => {
    const failed = await sendPeerMessage(
      { to: 'missing', content: 'hello' },
      {
        discover: async () => ({
          ...roster([]),
          unavailable: { cloud: 'fetch_failed' },
        }),
        send: async () => ({ status: 'delivered' }),
        createMessageId: () => 'msg-1',
      },
    )
    const tcp = await sendPeerMessage(
      { to: 'tcp:127.0.0.1:9000', content: 'hello' },
      {
        discover: async () => roster([]),
        send: async () => ({ status: 'delivered' }),
        createMessageId: () => 'msg-2',
      },
    )

    if (failed.success || tcp.success)
      throw new Error('expected routing failures')
    expect(failed.error_code).toBe('discovery_unavailable')
    expect(failed.message).toContain('cloud')
    expect(tcp.error_code).toBe('unsupported_transport')
  })

  test('normalizes transport failures without losing msg_id', async () => {
    const result = await sendPeerMessage(
      { to: 'worker', content: 'hello' },
      {
        discover: async () => roster([peer()]),
        send: async () => {
          throw new Error('socket closed')
        },
        createMessageId: () => 'msg-1',
      },
    )

    expect(result).toMatchObject({
      success: false,
      error_code: 'delivery_failed',
      msg_id: 'msg-1',
    })
    expect(result.message).toContain('socket closed')
  })

  test('rejects a bare name when its pinned peer identity changes', async () => {
    const calls: Array<{
      peer: PeerCandidate
      msgId: string
      summary: string
    }> = []
    const result = await sendPeerMessage(
      { to: 'worker', content: 'hello' },
      {
        discover: async () => roster([peer({ id: 'replacement' })]),
        send: sender(calls),
        verifyTarget: () =>
          'Agent "worker" now resolves to a different session; use ListAgents and an exact ref.',
      },
    )

    expect(result).toMatchObject({
      success: false,
      error_code: 'stale_target',
    })
    expect(calls).toEqual([])
  })
})
