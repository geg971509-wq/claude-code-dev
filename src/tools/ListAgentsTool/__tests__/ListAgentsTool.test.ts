import { describe, expect, test } from 'bun:test'
import { toolMatchesName } from '../../../Tool.js'
import {
  discoverPeerRoster,
  discoverPeerRosterForTarget,
  formatPeerListing,
  type PeerDiscoveryDeps,
} from '../../../utils/peerDiscovery.js'
import type { PeerSourceRecord } from '../../../utils/peerRegistry.js'
import { ListAgentsTool, listAgents } from '../ListAgentsTool.js'

const source = (
  overrides: Partial<PeerSourceRecord> & Pick<PeerSourceRecord, 'id' | 'name'>,
): PeerSourceRecord => ({
  kind: 'local-session',
  transport: 'uds',
  address: `uds:/tmp/${overrides.id}.sock`,
  status: 'idle',
  ...overrides,
})

function deps(overrides: Partial<PeerDiscoveryDeps> = {}): PeerDiscoveryDeps {
  return {
    listLocal: async () => [],
    listCloud: async () => [],
    listBridge: async () => [],
    getSelfIds: () => ['self-session', String(process.pid)],
    ...overrides,
  }
}

describe('discoverPeerRoster', () => {
  test('combines in-process, UDS, cloud, and bridge peers', async () => {
    const roster = await discoverPeerRoster(
      {
        agentNameRegistry: new Map([['researcher', 'agent-1']]),
        tasks: { 'agent-1': { status: 'running' } },
      },
      deps({
        listLocal: async () => [source({ id: 'local-1', name: 'local' })],
        listCloud: async () => [
          source({
            id: 'session_cloud',
            sessionId: 'session_cloud',
            name: 'cloud',
            kind: 'cloud-session',
            transport: 'cloud',
            address: 'cloud:session_cloud',
          }),
        ],
        listBridge: async () => [
          source({
            id: 'session_bridge',
            sessionId: 'session_bridge',
            name: 'bridge',
            kind: 'bridge-session',
            transport: 'bridge',
            address: 'bridge:session_bridge',
          }),
        ],
      }),
    )

    expect(roster.candidates.map(candidate => candidate.transport)).toEqual([
      'in-process',
      'uds',
      'cloud',
      'bridge',
    ])
  })

  test('excludes the current session from every provider', async () => {
    const roster = await discoverPeerRoster(
      { agentNameRegistry: new Map(), tasks: {} },
      deps({
        listLocal: async () => [
          source({
            id: 'local-self',
            sessionId: 'self-session',
            name: 'self',
          }),
        ],
        listCloud: async () => [
          source({
            id: 'self-session',
            sessionId: 'self-session',
            name: 'self cloud',
            kind: 'cloud-session',
            transport: 'cloud',
            address: 'cloud:self-session',
          }),
        ],
      }),
    )

    expect(roster.candidates).toEqual([])
  })

  test('keeps available peers and marks only the failed provider unavailable', async () => {
    const roster = await discoverPeerRoster(
      { agentNameRegistry: new Map(), tasks: {} },
      deps({
        listLocal: async () => [source({ id: 'local-1', name: 'local' })],
        listBridge: async () => {
          throw new Error('offline')
        },
      }),
    )

    expect(roster.candidates.map(candidate => candidate.name)).toEqual([
      'local',
    ])
    expect(roster.unavailable).toEqual({ bridge: 'fetch_failed' })
  })

  test('keeps discovered local peers when this session cannot receive', async () => {
    const roster = await discoverPeerRoster(
      { agentNameRegistry: new Map(), tasks: {} },
      deps({
        listLocal: async () => [source({ id: 'local-1', name: 'local' })],
        getUnavailable: async () => ({ local: 'unreadable' }),
      }),
    )

    expect(roster.candidates.map(candidate => candidate.name)).toEqual([
      'local',
    ])
    expect(roster.unavailable).toEqual({ local: 'unreadable' })
  })

  test('does not merge distinct sessions that share a name', async () => {
    const roster = await discoverPeerRoster(
      { agentNameRegistry: new Map(), tasks: {} },
      deps({
        listLocal: async () => [
          source({ id: 'local-1', name: 'worker' }),
          source({ id: 'local-2', name: 'worker' }),
        ],
      }),
    )

    expect(roster.candidates).toHaveLength(2)
  })

  test('includes team mailbox members without duplicating in-process agents', async () => {
    const roster = await discoverPeerRoster(
      {
        agentNameRegistry: new Map([['local-worker', 'agent-1']]),
        tasks: {},
        teamContext: {
          selfAgentId: 'self-agent',
          selfAgentName: 'team-lead',
          teammates: {
            'agent-1': { name: 'local-worker', cwd: '/repo/local' },
            'agent-2': { name: 'mailbox-worker', cwd: '/repo/remote' },
            'self-agent': { name: 'team-lead', cwd: '/repo' },
          },
        },
      },
      deps(),
    )

    expect(roster.candidates.map(candidate => candidate.transport)).toEqual([
      'in-process',
      'mailbox',
    ])
    expect(roster.candidates.map(candidate => candidate.name)).toEqual([
      'local-worker',
      'mailbox-worker',
    ])
  })

  test('includes unnamed local agent tasks by their task description', async () => {
    const roster = await discoverPeerRoster(
      {
        agentNameRegistry: new Map(),
        tasks: {
          'agent-1': {
            type: 'local_agent',
            agentId: 'agent-1',
            agentType: 'general-purpose',
            description: 'Repository reviewer',
            status: 'running',
          },
        },
      },
      deps(),
    )

    expect(roster.candidates).toContainEqual(
      expect.objectContaining({
        id: 'agent-1',
        name: 'Repository reviewer',
        transport: 'in-process',
      }),
    )
  })

  test('resolves in-memory agents without starting remote discovery', async () => {
    let remoteCalls = 0
    const roster = await discoverPeerRosterForTarget(
      {
        agentNameRegistry: new Map([['researcher', 'agent-1']]),
        tasks: { 'agent-1': { status: 'running' } },
      },
      'researcher',
      deps({
        listCloud: async () => {
          remoteCalls++
          return []
        },
        listBridge: async () => {
          remoteCalls++
          return []
        },
      }),
    )

    expect(remoteCalls).toBe(0)
    expect(roster.candidates[0]?.name).toBe('researcher')
  })

  test('bounds unavailable remote discovery by a deadline', async () => {
    const roster = await discoverPeerRosterForTarget(
      { agentNameRegistry: new Map(), tasks: {} },
      'remote-worker',
      deps({
        listCloud: () => new Promise(() => {}),
      }),
      { remoteTimeoutMs: 5 },
    )

    expect(roster.unavailable.cloud).toBe('timeout')
  })
})

describe('formatPeerListing', () => {
  test('formats model-usable names, refs, transports, states, and warnings', async () => {
    const roster = await discoverPeerRoster(
      {
        agentNameRegistry: new Map([['researcher', 'agent-1']]),
        tasks: { 'agent-1': { status: 'running' } },
      },
      deps({
        listLocal: async () => [
          source({ id: 'local-1', name: 'worker', cwd: '/repo' }),
        ],
        listCloud: async () => {
          throw new Error('offline')
        },
      }),
    )

    const listing = formatPeerListing(roster)

    expect(listing).toContain('Subagents')
    expect(listing).toMatch(/researcher \[[a-f0-9]+\]/)
    expect(listing).toContain('Peer sessions')
    expect(listing).toMatch(/worker \[[a-f0-9]+\]/)
    expect(listing).toContain('uds')
    expect(listing).toContain('/repo')
    expect(listing).toContain('cloud: unavailable (fetch_failed)')
  })

  test('returns the official empty-state wording', () => {
    expect(
      formatPeerListing({
        candidates: [],
        byName: new Map(),
        unavailable: {},
      }),
    ).toBe('No reachable agents.')
  })
})

describe('ListAgentsTool', () => {
  test('is a read-only concurrency-safe tool with the ListPeers alias', () => {
    expect(ListAgentsTool.name).toBe('ListAgents')
    expect(toolMatchesName(ListAgentsTool, 'ListPeers')).toBe(true)
    expect(ListAgentsTool.isReadOnly()).toBe(true)
    expect(ListAgentsTool.isConcurrencySafe()).toBe(true)
  })

  test('returns the shared listing implementation', async () => {
    const result = await listAgents(
      { agentNameRegistry: new Map(), tasks: {} },
      deps({
        listLocal: async () => [source({ id: 'local-1', name: 'worker' })],
      }),
    )

    expect(result.listing).toMatch(/worker \[[a-f0-9]+\]/)
  })
})
