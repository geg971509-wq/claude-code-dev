import { describe, expect, mock, test } from 'bun:test'
import { buildPeerRoster } from '../../../utils/peerRegistry.js'
import { dispatchAgentFleetAction } from '../actions.js'
import { recordFromSession, recordsFromPeerRoster } from '../adapters.js'
import type { AgentFleetAction, AgentFleetRecord } from '../types.js'

const record: AgentFleetRecord = {
  id: 'session:s1',
  pid: 42,
  sessionId: 's1',
  startedAt: 1,
  updatedAt: 2,
  revision: 's1:2',
  state: 'working',
  source: 'background',
  capabilities: ['stop'],
}

describe('agent Fleet actions', () => {
  test('rejects stale destructive actions before touching the owner', async () => {
    const owners = {
      stop: mock(async () => {}),
      logs: mock(async () => {}),
      attach: mock(async () => {}),
      listLive: mock(async () => []),
    }
    const staleRecord = {
      ...record,
      capabilities: ['stop', 'logs', 'attach', 'cleanup'] as const,
    }

    for (const type of ['stop', 'logs', 'attach', 'cleanup'] as const) {
      const result = await dispatchAgentFleetAction(
        staleRecord,
        {
          type,
          id: record.id,
          revision: 'old',
          updatedAt: record.updatedAt,
        },
        owners,
      )
      expect(result).toEqual({
        ok: false,
        code: 'stale',
        message: expect.stringContaining('changed'),
      })
    }

    expect(owners.stop).toHaveBeenCalledTimes(0)
    expect(owners.logs).toHaveBeenCalledTimes(0)
    expect(owners.attach).toHaveBeenCalledTimes(0)
    expect(owners.listLive).toHaveBeenCalledTimes(0)
  })

  test('delegates a current action to its owner', async () => {
    const owners = {
      stop: mock(async () => {}),
      logs: mock(async () => {}),
      attach: mock(async () => {}),
      listLive: mock(async () => []),
    }
    const result = await dispatchAgentFleetAction(
      record,
      {
        type: 'stop',
        id: record.id,
        revision: record.revision,
        updatedAt: record.updatedAt,
      },
      owners,
    )

    expect(result).toEqual({ ok: true, action: 'stop', id: record.id })
    expect(owners.stop).toHaveBeenCalledWith('s1')
  })

  test('reloads owner state before dispatching a destructive action', async () => {
    const owners = {
      stop: mock(async () => {}),
      logs: mock(async () => {}),
      attach: mock(async () => {}),
      listLive: mock(async () => []),
      reload: mock(async () => ({ ...record, revision: 'r2' })),
    }

    const result = await dispatchAgentFleetAction(
      record,
      {
        type: 'stop',
        id: record.id,
        revision: record.revision,
        updatedAt: record.updatedAt,
      },
      owners,
    )

    expect(result).toMatchObject({ ok: false, code: 'stale' })
    expect(owners.stop).toHaveBeenCalledTimes(0)
  })

  test('routes message, resume, retry, task output, and cleanup through record owners', async () => {
    const message = mock(async () => {})
    const resume = mock(async () => {})
    const retry = mock(async () => {})
    const logsRecord = mock(async () => 'recent output')
    const cleanupRecord = mock(async () => {})
    const owners = {
      stop: mock(async () => {}),
      logs: mock(async () => {}),
      attach: mock(async () => {}),
      listLive: mock(async () => []),
      message,
      resume,
      retry,
      logsRecord,
      cleanupRecord,
    }
    const owned = {
      ...record,
      capabilities: ['message', 'resume', 'retry', 'logs', 'cleanup'] as const,
    }

    const base = {
      id: owned.id,
      revision: owned.revision,
      updatedAt: owned.updatedAt,
    }
    await expect(
      dispatchAgentFleetAction(
        owned,
        { ...base, type: 'message', content: 'status?' },
        owners,
      ),
    ).resolves.toMatchObject({ ok: true, action: 'message' })
    await expect(
      dispatchAgentFleetAction(
        owned,
        { ...base, type: 'resume', prompt: 'continue' },
        owners,
      ),
    ).resolves.toMatchObject({ ok: true, action: 'resume' })
    await expect(
      dispatchAgentFleetAction(
        owned,
        { ...base, type: 'retry', prompt: 'retry' },
        owners,
      ),
    ).resolves.toMatchObject({ ok: true, action: 'retry' })
    await expect(
      dispatchAgentFleetAction(owned, { ...base, type: 'logs' }, owners),
    ).resolves.toEqual({
      ok: true,
      action: 'logs',
      id: owned.id,
      output: 'recent output',
    })
    await expect(
      dispatchAgentFleetAction(owned, { ...base, type: 'cleanup' }, owners),
    ).resolves.toMatchObject({ ok: true, action: 'cleanup' })

    expect(message).toHaveBeenCalledWith(owned, 'status?')
    expect(resume).toHaveBeenCalledWith(owned, 'continue')
    expect(retry).toHaveBeenCalledWith(owned, 'retry')
    expect(cleanupRecord).toHaveBeenCalledWith(owned)
  })

  test('rejects unsupported actions from the capability contract', async () => {
    const result = await dispatchAgentFleetAction(record, {
      type: 'attach',
      id: record.id,
      revision: record.revision,
      updatedAt: record.updatedAt,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('unsupported')
  })

  test('executes an advertised peer message through the existing peer transport', async () => {
    const roster = buildPeerRoster({
      local: [
        {
          kind: 'local-session',
          transport: 'uds',
          id: 'peer-1',
          sessionId: 'peer-session',
          name: 'peer worker',
          address: 'uds:/tmp/peer.sock',
          lastActive: 20,
          canReply: true,
        },
      ],
    })
    const peer = recordsFromPeerRoster(roster)[0]
    expect(peer?.capabilities).toContain('message')
    if (!peer) throw new Error('Expected peer record')
    const sendPeer = mock(async () => ({ status: 'queued' as const }))
    const owners = {
      stop: mock(async () => {}),
      logs: mock(async () => {}),
      attach: mock(async () => {}),
      listLive: mock(async () => []),
      discover: mock(async () => roster),
      sendPeer,
      requestOwnerAction: mock(async () => ({
        ok: false as const,
        code: 'owner-unavailable' as const,
        message: 'not used',
      })),
      createMessageId: () => 'msg-1',
      getSessionId: () => 'sender-session',
    }

    const result = await dispatchAgentFleetAction(
      peer,
      {
        type: 'message',
        id: peer.id,
        revision: peer.revision,
        updatedAt: peer.updatedAt,
        content: 'status?',
      },
      owners,
    )

    expect(result).toEqual({ ok: true, action: 'message', id: peer.id })
    expect(sendPeer).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: 'uds',
        address: 'uds:/tmp/peer.sock',
      }),
      expect.objectContaining({
        content: 'status?',
        msgId: 'msg-1',
        sessionId: 'sender-session',
      }),
    )
  })

  test('executes an advertised session message through the existing peer transport', async () => {
    const session = {
      pid: 43,
      sessionId: 'session-2',
      messagingSocketPath: '/tmp/session-2.sock',
      cwd: '/workspace',
      kind: 'bg' as const,
      startedAt: 10,
      updatedAt: 20,
      alive: true,
    }
    const current = recordFromSession(session)
    const roster = buildPeerRoster({
      local: [
        {
          kind: 'local-session',
          transport: 'uds',
          id: 'session-2',
          sessionId: 'session-2',
          address: 'uds:/tmp/session-2.sock',
          lastActive: 20,
          canReply: true,
        },
      ],
    })
    const sendPeer = mock(async () => ({ status: 'queued' as const }))
    const owners = {
      stop: mock(async () => {}),
      logs: mock(async () => {}),
      attach: mock(async () => {}),
      listLive: mock(async () => [session]),
      discover: mock(async () => roster),
      sendPeer,
      requestOwnerAction: mock(async () => ({
        ok: false as const,
        code: 'owner-unavailable' as const,
        message: 'not used',
      })),
      createMessageId: () => 'msg-2',
      getSessionId: () => 'sender-session',
    }

    const result = await dispatchAgentFleetAction(
      current,
      {
        type: 'message',
        id: current.id,
        revision: current.revision,
        updatedAt: current.updatedAt,
        content: 'hello',
      },
      owners,
    )

    expect(result).toEqual({ ok: true, action: 'message', id: current.id })
    expect(sendPeer).toHaveBeenCalledTimes(1)
  })

  test('forwards every task-advertised action to its owner', async () => {
    const roster = buildPeerRoster({
      local: [
        {
          kind: 'local-session',
          transport: 'uds',
          id: 'owner-session',
          sessionId: 'owner-session',
          address: 'uds:/tmp/owner.sock',
          canReply: true,
        },
      ],
    })
    const requestOwnerAction = mock(
      async (_target: string, action: AgentFleetAction) => ({
        ok: true as const,
        action: action.type,
        id: action.id,
      }),
    )
    const owners = {
      stop: mock(async () => {}),
      logs: mock(async () => {}),
      attach: mock(async () => {}),
      listLive: mock(async () => []),
      discover: mock(async () => roster),
      sendPeer: mock(async () => ({ status: 'queued' as const })),
      requestOwnerAction,
      createMessageId: () => 'msg-1',
      getSessionId: () => 'sender-session',
    }
    const owned: AgentFleetRecord = {
      ...record,
      id: 'task:owner-session:child',
      ownerSessionId: 'owner-session',
      capabilities: ['message', 'resume', 'retry', 'stop', 'logs', 'cleanup'],
    }
    const base = {
      id: owned.id,
      revision: owned.revision,
      updatedAt: owned.updatedAt,
    }
    const actions: AgentFleetAction[] = [
      { ...base, type: 'message', content: 'status?' },
      { ...base, type: 'resume', prompt: 'continue' },
      { ...base, type: 'retry', prompt: 'retry' },
      { ...base, type: 'stop' },
      { ...base, type: 'logs' },
      { ...base, type: 'cleanup' },
    ]

    for (const action of actions) {
      await expect(
        dispatchAgentFleetAction(owned, action, owners),
      ).resolves.toMatchObject({ ok: true, action: action.type })
    }
    expect(requestOwnerAction).toHaveBeenCalledTimes(actions.length)
  })

  test('forwards owner-owned actions and preserves a fresh owner stale result', async () => {
    const roster = buildPeerRoster({
      local: [
        {
          kind: 'local-session',
          transport: 'uds',
          id: 'owner-session',
          sessionId: 'owner-session',
          name: 'owner',
          address: 'uds:/tmp/owner.sock',
          canReply: true,
        },
      ],
    })
    const requestOwnerAction = mock(async () => ({
      ok: false as const,
      code: 'stale' as const,
      message: 'owner state changed',
    }))
    const stop = mock(async () => {})
    const owners = {
      stop,
      logs: mock(async () => {}),
      attach: mock(async () => {}),
      listLive: mock(async () => []),
      discover: mock(async () => roster),
      sendPeer: mock(async () => ({ status: 'queued' as const })),
      requestOwnerAction,
      createMessageId: () => 'msg-1',
      getSessionId: () => 'sender-session',
    }
    const owned: AgentFleetRecord = {
      ...record,
      id: 'task:owner-session:child',
      ownerSessionId: 'owner-session',
      capabilities: ['stop'],
    }
    const action = {
      type: 'stop' as const,
      id: owned.id,
      revision: owned.revision,
      updatedAt: owned.updatedAt,
    }

    const result = await dispatchAgentFleetAction(owned, action, owners)

    expect(result).toEqual({
      ok: false,
      code: 'stale',
      message: 'owner state changed',
    })
    expect(requestOwnerAction).toHaveBeenCalledWith(
      'uds:/tmp/owner.sock',
      action,
    )
    expect(stop).toHaveBeenCalledTimes(0)
  })
})
