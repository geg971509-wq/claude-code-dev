import { describe, expect, test } from 'bun:test'
import { buildPeerRoster } from '../../../utils/peerRegistry.js'
import {
  buildAgentFleetSnapshot,
  findFleetRecord,
  type AgentFleetSnapshotDeps,
} from '../roster.js'
import type { AgentFleetSnapshot } from '../types.js'

const session = (overrides: Record<string, unknown> = {}) => ({
  pid: 42,
  sessionId: 'session-a',
  cwd: '/real/project',
  startedAt: 10,
  updatedAt: 20,
  status: 'running',
  alive: true,
  ...overrides,
})

const deps = (
  overrides: Partial<AgentFleetSnapshotDeps> = {},
): AgentFleetSnapshotDeps => ({
  listSessions: async () => [],
  canonicalizeCwd: async cwd =>
    cwd === '/alias/project' ? '/real/project' : cwd,
  now: () => 100,
  ...overrides,
})

describe('agent Fleet roster', () => {
  test('merges session sidecars, AppState tasks, and a PeerRoster', async () => {
    const peerRoster = buildPeerRoster({
      local: [
        {
          kind: 'local-session',
          transport: 'uds',
          id: 'peer-b',
          name: 'peer worker',
          cwd: '/real/project',
          status: 'reachable',
          canReply: true,
        },
      ],
    })
    const snapshot = await buildAgentFleetSnapshot(
      '/alias/project',
      {},
      deps({
        listSessions: async () => [session()],
        getTaskRecords: () => ({
          task1: {
            id: 'task1',
            type: 'local_agent',
            status: 'running',
            description: 'local worker',
            agentId: 'agent-1',
            startTime: 30,
            outputFile: '/tmp/task1.log',
          },
        }),
        getPeerRoster: async () => peerRoster,
        ownerSessionId: 'owner-1',
      }),
    )

    expect(snapshot.cwd).toBe('/real/project')
    expect(snapshot.records).toHaveLength(3)
    expect(snapshot.records.map(record => record.source)).toEqual([
      'background',
      'peer',
      'peer',
    ])
    expect(findFleetRecord(snapshot, 'task:owner-1:task1')).toMatchObject({
      state: 'working',
      capabilities: ['message', 'logs', 'stop'],
      ownerSessionId: 'owner-1',
    })
  })

  test('filters by canonical cwd by default and includes every cwd with all', async () => {
    const source = deps({
      listSessions: async () => [
        session(),
        session({ pid: 43, sessionId: 'session-b', cwd: '/other' }),
      ],
    })

    const local = await buildAgentFleetSnapshot('/alias/project', {}, source)
    const all = await buildAgentFleetSnapshot(
      '/alias/project',
      { all: true },
      source,
    )

    expect(local.records.map(record => record.sessionId)).toEqual(['session-a'])
    expect(all.records.map(record => record.sessionId)).toEqual([
      'session-a',
      'session-b',
    ])
  })

  test('returns stable ordering and revisions for unchanged inputs', async () => {
    const source = deps({
      listSessions: async () => [
        session({ pid: 43, sessionId: 'z', startedAt: 10 }),
        session({ pid: 42, sessionId: 'a', startedAt: 10 }),
      ],
    })

    const first = await buildAgentFleetSnapshot('/real/project', {}, source)
    const second = await buildAgentFleetSnapshot('/real/project', {}, source)

    expect(first.records.map(record => record.id)).toEqual([
      'session:a',
      'session:z',
    ])
    expect(second.records).toEqual(first.records)
    expect(second.revision).toBe(first.revision)
  })

  test('classifies detached owners as background and changes task revisions with status', async () => {
    const source = deps({
      listSessions: async () => [session({ kind: 'bg' })],
      getTaskRecords: () => ({
        task1: {
          id: 'task1',
          type: 'local_agent',
          status: 'running',
          startTime: 30,
        },
      }),
      ownerSessionId: 'owner-1',
    })

    const running = await buildAgentFleetSnapshot('/real/project', {}, source)
    const completed = await buildAgentFleetSnapshot(
      '/real/project',
      {},
      {
        ...source,
        getTaskRecords: () => ({
          task1: {
            id: 'task1',
            type: 'local_agent',
            status: 'completed',
            startTime: 30,
          },
        }),
      },
    )

    expect(
      running.records.find(record => record.sessionId === 'session-a')?.source,
    ).toBe('background')
    expect(
      completed.records.find(record => record.id.includes('task1'))?.revision,
    ).not.toBe(
      running.records.find(record => record.id.includes('task1'))?.revision,
    )
  })

  test('deduplicates one session across UDS, cloud, and bridge transports', async () => {
    const peerRoster = buildPeerRoster({
      local: [
        {
          kind: 'local-session',
          transport: 'uds',
          id: 'local-copy',
          sessionId: 'session-shared',
          bridgeSessionId: 'session_shared',
          name: 'local worker',
          cwd: '/real/project',
        },
      ],
      cloud: [
        {
          kind: 'cloud-session',
          transport: 'cloud',
          id: 'session_shared',
          sessionId: 'session_shared',
          name: 'cloud worker',
        },
      ],
      bridge: [
        {
          kind: 'bridge-session',
          transport: 'bridge',
          id: 'session_shared',
          sessionId: 'session_shared',
          name: 'bridge worker',
        },
      ],
    })
    const snapshot = await buildAgentFleetSnapshot(
      '/real/project',
      {},
      deps({
        listSessions: async () => [session({ sessionId: 'session_shared' })],
        getPeerRoster: async () => peerRoster,
      }),
    )

    expect(snapshot.records).toHaveLength(1)
    expect(snapshot.records[0]).toMatchObject({
      id: 'session:session_shared',
      source: 'peer',
      mirroredTransports: ['uds', 'cloud', 'bridge'],
    })
  })

  test('keeps same-name agents with different stable IDs separate', async () => {
    const peerRoster = buildPeerRoster({
      inProcess: [
        {
          kind: 'subagent',
          transport: 'in-process',
          id: 'agent-a',
          name: 'worker',
        },
        {
          kind: 'subagent',
          transport: 'in-process',
          id: 'agent-b',
          name: 'worker',
        },
      ],
    })
    const snapshot = await buildAgentFleetSnapshot(
      '/real/project',
      { all: true },
      deps({ getPeerRoster: async () => peerRoster }),
    )

    expect(snapshot.records.map(record => record.id)).toEqual([
      'peer:subagent:agent-a',
      'peer:subagent:agent-b',
    ])
    expect(snapshot.records[0]?.ref).not.toBe(snapshot.records[1]?.ref)
  })

  test('advertises message only for PeerRoster transports with an executable route', async () => {
    const peerRoster = buildPeerRoster({
      inProcess: [
        {
          kind: 'subagent',
          transport: 'in-process',
          id: 'agent-a',
          name: 'local worker',
          canReply: true,
        },
      ],
      local: [
        {
          kind: 'local-session',
          transport: 'uds',
          id: 'peer-b',
          name: 'peer worker',
          address: 'uds:/tmp/peer.sock',
          canReply: true,
        },
      ],
    })
    const snapshot = await buildAgentFleetSnapshot(
      '/real/project',
      { all: true },
      deps({ getPeerRoster: async () => peerRoster }),
    )

    expect(
      snapshot.records.find(record => record.rawId === 'agent-a')?.capabilities,
    ).not.toContain('message')
    expect(
      snapshot.records.find(record => record.rawId === 'peer-b')?.capabilities,
    ).toContain('message')
  })

  test('returns available records with partial source failures', async () => {
    const snapshot = await buildAgentFleetSnapshot(
      '/real/project',
      { all: true },
      deps({
        listSessions: () => {
          throw new Error('corrupt sidecar')
        },
        getTaskRecords: () => ({
          task1: {
            id: 'task1',
            type: 'remote_agent',
            status: 'failed',
            title: 'remote worker',
            sessionId: 'remote-1',
            startTime: 1,
          },
        }),
        getPeerRoster: async () =>
          buildPeerRoster({ unavailable: { cloud: 'timeout' } }),
      }),
    )

    expect(snapshot.records).toHaveLength(1)
    expect(snapshot.records[0]).toMatchObject({
      source: 'background',
      state: 'failed',
    })
    expect(snapshot.partial).toBe(true)
    expect(snapshot.unavailableSources).toEqual(['background', 'peer'])
  })

  test('merges owner-exported child records and preserves owner partial state', async () => {
    const snapshot = await buildAgentFleetSnapshot(
      '/real/project',
      {},
      deps({
        listSessions: async () => [
          session({ messagingSocketPath: '/tmp/owner.sock' }),
        ],
        getOwnerSnapshots: async () => ({
          snapshots: [
            {
              generatedAt: 50,
              revision: 'owner-r1',
              cwd: '/real/project',
              records: [
                {
                  id: 'task:owner:child',
                  rawId: 'child',
                  cwd: '/real/project',
                  startedAt: 30,
                  updatedAt: 40,
                  revision: 'child:running:40',
                  state: 'working',
                  source: 'background',
                  capabilities: ['message', 'stop'],
                },
              ],
              partial: true,
              unavailableSources: ['peer'],
            },
          ],
          failed: false,
        }),
      }),
    )

    expect(snapshot.records.map(record => record.id)).toContain(
      'task:owner:child',
    )
    expect(snapshot.partial).toBe(true)
    expect(snapshot.unavailableSources).toContain('peer')
  })

  test('resolves stable id, session id, and pid references', () => {
    const snapshot: AgentFleetSnapshot = {
      generatedAt: 1,
      revision: 'r',
      cwd: '/tmp/project',
      partial: false,
      unavailableSources: [],
      records: [
        {
          id: 'session:s1',
          pid: 42,
          sessionId: 's1',
          startedAt: 1,
          updatedAt: 2,
          revision: 's1:2',
          state: 'working',
          source: 'background',
          capabilities: ['stop'],
        },
      ],
    }
    expect(findFleetRecord(snapshot, 'session:s1')?.pid).toBe(42)
    expect(findFleetRecord(snapshot, 's1')?.id).toBe('session:s1')
    expect(findFleetRecord(snapshot, '42')?.sessionId).toBe('s1')
  })
})
