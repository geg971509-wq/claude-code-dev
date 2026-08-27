import { describe, expect, test } from 'bun:test'
import {
  buildPeerRoster,
  formatPeerAddress,
  normalizePeerName,
  resolvePeerTarget,
  type PeerSourceRecord,
} from '../peerRegistry.js'

const peer = (
  overrides: Partial<PeerSourceRecord> & Pick<PeerSourceRecord, 'id' | 'name'>,
): PeerSourceRecord => ({
  kind: 'local-session',
  transport: 'uds',
  address: `uds:/tmp/${overrides.id}.sock`,
  status: 'idle',
  ...overrides,
})

describe('normalizePeerName', () => {
  test('normalizes Unicode, control characters, casing, and whitespace', () => {
    expect(normalizePeerName('  Ａlice\u0000\n Smith  ')).toBe('alice-smith')
  })
})

describe('buildPeerRoster', () => {
  test('includes main for child-agent discovery when requested', () => {
    const roster = buildPeerRoster({
      main: [
        {
          id: 'main',
          name: 'main',
          kind: 'main',
          transport: 'in-process',
        },
      ],
    })

    expect(resolvePeerTarget(roster, 'main')).toMatchObject({
      kind: 'resolved',
      candidate: { kind: 'main', transport: 'in-process' },
    })
  })

  test('keeps distinct same-name sessions and assigns unique refs', () => {
    const roster = buildPeerRoster({
      local: [
        peer({ id: 'session-a', name: 'worker' }),
        peer({ id: 'session-b', name: 'worker' }),
      ],
    })

    expect(roster.candidates).toHaveLength(2)
    expect(
      new Set(roster.candidates.map(candidate => candidate.ref)).size,
    ).toBe(2)
    expect(
      roster.candidates.every(candidate => candidate.ref.length >= 4),
    ).toBe(true)
  })

  test('deduplicates the same local session by normalized name and socket', () => {
    const first = peer({ id: 'session-a', name: 'Worker One' })
    const duplicate = peer({ id: 'session-a-copy', name: 'worker one' })
    duplicate.address = first.address

    const roster = buildPeerRoster({ local: [first, duplicate] })

    expect(roster.candidates).toHaveLength(1)
  })

  test('prefers local UDS when it mirrors a bridge or cloud session', () => {
    const roster = buildPeerRoster({
      local: [
        peer({
          id: 'local-a',
          name: 'local worker',
          bridgeSessionId: 'session_shared',
        }),
      ],
      cloud: [
        peer({
          id: 'session_shared',
          sessionId: 'session_shared',
          name: 'cloud worker',
          kind: 'cloud-session',
          transport: 'cloud',
          address: 'cloud:session_shared',
        }),
      ],
      bridge: [
        peer({
          id: 'session_shared',
          sessionId: 'session_shared',
          name: 'bridge worker',
          kind: 'bridge-session',
          transport: 'bridge',
          address: 'bridge:session_shared',
        }),
      ],
    })

    expect(roster.candidates).toHaveLength(1)
    expect(roster.candidates[0]?.transport).toBe('uds')
    expect(roster.candidates[0]?.mirroredTransports).toEqual([
      'cloud',
      'bridge',
    ])
  })

  test('prefers cloud over bridge for the same remote session', () => {
    const roster = buildPeerRoster({
      cloud: [
        peer({
          id: 'session_shared',
          sessionId: 'session_shared',
          name: 'cloud worker',
          kind: 'cloud-session',
          transport: 'cloud',
          address: 'cloud:session_shared',
        }),
      ],
      bridge: [
        peer({
          id: 'session_shared',
          sessionId: 'session_shared',
          name: 'bridge worker',
          kind: 'bridge-session',
          transport: 'bridge',
          address: 'bridge:session_shared',
        }),
      ],
    })

    expect(roster.candidates).toHaveLength(1)
    expect(roster.candidates[0]?.transport).toBe('cloud')
    expect(roster.candidates[0]?.mirroredTransports).toEqual(['bridge'])
  })

  test('preserves provider failures without dropping available peers', () => {
    const roster = buildPeerRoster({
      local: [peer({ id: 'session-a', name: 'worker' })],
      unavailable: { cloud: 'fetch_failed', bridge: 'timeout' },
    })

    expect(roster.candidates).toHaveLength(1)
    expect(roster.unavailable).toEqual({
      cloud: 'fetch_failed',
      bridge: 'timeout',
    })
  })

  test('replaces unsafe source names with a deterministic kind/id fallback', () => {
    const roster = buildPeerRoster({
      local: [peer({ id: 'session-abcdef', name: 'uds:/tmp/forged.sock' })],
    })

    expect(roster.candidates[0]?.name).toBe('local-session-abcdef')
  })

  test('excludes the current process and session identities', () => {
    const roster = buildPeerRoster({
      local: [
        peer({ id: 'self-pid', sessionId: 'session_self', name: 'self' }),
        peer({ id: 'other', sessionId: 'session_other', name: 'other' }),
      ],
      selfIds: ['self-pid', 'session_self'],
    })

    expect(roster.candidates.map(candidate => candidate.name)).toEqual([
      'other',
    ])
  })
})

describe('resolvePeerTarget', () => {
  test('preserves direct in-process agent ID addressing', () => {
    const roster = buildPeerRoster({
      inProcess: [
        peer({
          id: 'agent-123',
          name: 'worker',
          kind: 'subagent',
          transport: 'in-process',
          address: undefined,
        }),
      ],
    })

    expect(resolvePeerTarget(roster, 'agent-123')).toMatchObject({
      kind: 'resolved',
      candidate: { id: 'agent-123' },
    })
  })

  test('gives an exact in-process name precedence over remote duplicates', () => {
    const roster = buildPeerRoster({
      inProcess: [
        peer({
          id: 'agent-a',
          name: 'worker',
          kind: 'subagent',
          transport: 'in-process',
          address: undefined,
        }),
      ],
      local: [peer({ id: 'session-a', name: 'worker' })],
    })

    const result = resolvePeerTarget(roster, 'worker')

    expect(result.kind).toBe('resolved')
    if (result.kind === 'resolved') {
      expect(result.candidate.transport).toBe('in-process')
    }
  })

  test('requires a ref when an exact remote name is ambiguous', () => {
    const roster = buildPeerRoster({
      local: [
        peer({ id: 'session-a', name: 'worker' }),
        peer({ id: 'session-b', name: 'worker' }),
      ],
    })

    const result = resolvePeerTarget(roster, 'worker')

    expect(result.kind).toBe('ambiguous')
    if (result.kind === 'ambiguous') {
      expect(result.candidates).toHaveLength(2)
      expect(result.candidates.every(candidate => candidate.ref)).toBe(true)
    }
  })

  test('resolves a listed name and ref to exactly one peer', () => {
    const roster = buildPeerRoster({
      local: [
        peer({ id: 'session-a', name: 'worker' }),
        peer({ id: 'session-b', name: 'worker' }),
      ],
    })
    const wanted = roster.candidates[1]!

    const result = resolvePeerTarget(
      roster,
      formatPeerAddress(wanted.name, wanted.ref),
    )

    expect(result).toEqual({ kind: 'resolved', candidate: wanted })
  })

  test('resolves a unique name prefix of at least three characters', () => {
    const roster = buildPeerRoster({
      local: [
        peer({ id: 'session-a', name: 'builder' }),
        peer({ id: 'session-b', name: 'reviewer' }),
      ],
    })

    const result = resolvePeerTarget(roster, 'bui')

    expect(result.kind).toBe('resolved')
    if (result.kind === 'resolved')
      expect(result.candidate.name).toBe('builder')
  })

  test('does not prefix-resolve fewer than three characters', () => {
    const roster = buildPeerRoster({
      local: [peer({ id: 'session-a', name: 'builder' })],
    })

    expect(resolvePeerTarget(roster, 'bu')).toEqual({
      kind: 'not-found',
      unavailable: {},
    })
  })

  test('bounds ambiguity suggestions to three candidates', () => {
    const roster = buildPeerRoster({
      local: [
        peer({ id: 'a', name: 'builder-a' }),
        peer({ id: 'b', name: 'builder-b' }),
        peer({ id: 'c', name: 'builder-c' }),
        peer({ id: 'd', name: 'builder-d' }),
      ],
    })

    const result = resolvePeerTarget(roster, 'bui')

    expect(result.kind).toBe('ambiguous')
    if (result.kind === 'ambiguous') expect(result.candidates).toHaveLength(3)
  })

  test('reports unavailable sources with not-found results', () => {
    const roster = buildPeerRoster({
      unavailable: { local: 'unreadable', cloud: 'fetch_failed' },
    })

    expect(resolvePeerTarget(roster, 'missing')).toEqual({
      kind: 'not-found',
      unavailable: { local: 'unreadable', cloud: 'fetch_failed' },
    })
  })
})
