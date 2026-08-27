import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createConnection, createServer } from 'node:net'
import { join } from 'node:path'
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  drainInbox,
  MAX_UDS_FRAME_BYTES,
  readUdsCapabilityToken,
  setOnAgentFleetAction,
  setOnAgentFleetSnapshot,
  startUdsMessaging,
  stopUdsMessaging,
} from '../udsMessaging.js'
import {
  requestAgentFleetAction,
  requestAgentFleetSnapshot,
} from '../udsClient.js'
import type {
  AgentFleetAction,
  AgentFleetSnapshot,
} from '../../services/agentFleet/types.js'

let previousConfigDir: string | undefined
let tempConfigDir = ''
let tempSocketDir = ''

function socketPath(label: string): string {
  const suffix = `${process.pid}-${Math.random().toString(16).slice(2)}-${label}`
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\claude-fleet-uds-test-${suffix}`
  }
  return join(tempSocketDir, `fu-${suffix}.sock`)
}

beforeEach(async () => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  tempConfigDir = await mkdtemp(join(tmpdir(), 'fleet-uds-home-'))
  tempSocketDir = await mkdtemp('/private/tmp/fu-')
  process.env.CLAUDE_CONFIG_DIR = tempConfigDir
})

afterEach(async () => {
  setOnAgentFleetSnapshot(null)
  setOnAgentFleetAction(null)
  drainInbox()
  await stopUdsMessaging()
  if (previousConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  }
  await rm(tempConfigDir, { recursive: true, force: true })
  await rm(tempSocketDir, { recursive: true, force: true })
})

async function sendRawRequest(
  path: string,
  request: Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>>> {
  const authToken = await readUdsCapabilityToken(path)
  if (!authToken) throw new Error('test capability token missing')

  return new Promise((resolve, reject) => {
    const socket = createConnection(path, () => {
      socket.write(
        `${JSON.stringify({
          ...request,
          meta: { authToken },
        })}\n`,
      )
    })
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      socket.end()
      try {
        resolve(JSON.parse(buffer.slice(0, newline)))
      } catch (error) {
        reject(error)
      }
    })
    socket.on('error', reject)
  })
}

async function writeTestCapability(
  path: string,
  authToken: string,
): Promise<void> {
  const dir = join(tempConfigDir, 'messaging-capabilities')
  const name = `${createHash('sha256').update(path).digest('hex')}.json`
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(
    join(dir, name),
    JSON.stringify({ socketPath: path, authToken }),
    { mode: 0o600 },
  )
}

const snapshot: AgentFleetSnapshot = {
  generatedAt: 10,
  revision: 'fleet-10',
  cwd: '/workspace',
  records: [],
  partial: false,
  unavailableSources: [],
}

describe('Agent Fleet UDS owner protocol', () => {
  test('shutdown clears owner callbacks even when no server is running', async () => {
    const path = socketPath('shutdown-before-start')
    setOnAgentFleetSnapshot(() => snapshot)
    await stopUdsMessaging()
    await startUdsMessaging(path, { isExplicit: true })

    const response = await sendRawRequest(path, {
      type: 'fleet_snapshot',
      request_id: 'shutdown-before-start-1',
    })

    expect(response).toMatchObject({
      type: 'error',
      data: 'fleet snapshot owner unavailable',
    })
  })

  test('routes snapshot requests away from the legacy inbox when owner is unavailable', async () => {
    const path = socketPath('snapshot-owner-unavailable')
    await startUdsMessaging(path, { isExplicit: true })

    const response = await sendRawRequest(path, {
      type: 'fleet_snapshot',
      request_id: 'snapshot-1',
    })

    expect(response).toMatchObject({
      type: 'error',
      data: 'fleet snapshot owner unavailable',
      meta: { request_id: 'snapshot-1' },
    })
    expect(drainInbox()).toEqual([])
  })

  test('returns the owner snapshot with the matching request ID', async () => {
    const path = socketPath('snapshot')
    setOnAgentFleetSnapshot(() => snapshot)
    await startUdsMessaging(path, { isExplicit: true })

    const response = await sendRawRequest(path, {
      type: 'fleet_snapshot',
      request_id: 'snapshot-2',
    })

    expect(response).toEqual({
      type: 'fleet_snapshot_response',
      request_id: 'snapshot-2',
      snapshot,
    })
  })

  test('accepts only the public action union before invoking the owner', async () => {
    const path = socketPath('action-shape')
    const received: AgentFleetAction[] = []
    setOnAgentFleetAction(action => {
      received.push(action)
      return { ok: true, action: action.type, id: action.id }
    })
    await startUdsMessaging(path, { isExplicit: true })

    const invalid = await sendRawRequest(path, {
      type: 'fleet_action',
      request_id: 'action-invalid',
      action: {
        type: 'stop',
        id: 'agent-1',
        revision: 'r1',
        updatedAt: 1,
        command: 'rm -rf /',
      },
    })
    expect(invalid).toMatchObject({
      type: 'error',
      data: 'invalid fleet action request',
      meta: { request_id: 'action-invalid' },
    })
    expect(received).toEqual([])

    const action: AgentFleetAction = {
      type: 'stop',
      id: 'agent-1',
      revision: 'r1',
      updatedAt: 1,
    }
    const valid = await sendRawRequest(path, {
      type: 'fleet_action',
      request_id: 'action-valid',
      action,
    })
    expect(valid).toEqual({
      type: 'fleet_action_response',
      request_id: 'action-valid',
      result: { ok: true, action: 'stop', id: 'agent-1' },
    })
    expect(received).toEqual([action])

    const messageAction: AgentFleetAction = {
      type: 'message',
      id: 'agent-1',
      revision: 'r1',
      updatedAt: 1,
      content: 'status?',
    }
    const messageResult = await sendRawRequest(path, {
      type: 'fleet_action',
      request_id: 'action-message',
      action: messageAction,
    })
    expect(messageResult).toMatchObject({
      type: 'fleet_action_response',
      result: { ok: true, action: 'message', id: 'agent-1' },
    })
    expect(received).toEqual([action, messageAction])
  })

  test('executes a duplicate action request ID only once across connections', async () => {
    const path = socketPath('duplicate')
    let calls = 0
    let releaseFirst: (() => void) | undefined
    let markStarted: (() => void) | undefined
    const firstMayFinish = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    const ownerStarted = new Promise<void>(resolve => {
      markStarted = resolve
    })
    setOnAgentFleetAction(async action => {
      calls++
      if (calls === 1) {
        markStarted?.()
        await firstMayFinish
      }
      return { ok: true, action: action.type, id: action.id }
    })
    await startUdsMessaging(path, { isExplicit: true })
    const request = {
      type: 'fleet_action',
      request_id: 'same-action-id',
      action: {
        type: 'stop',
        id: 'agent-1',
        revision: 'r1',
        updatedAt: 1,
      },
    }

    const first = sendRawRequest(path, request)
    await ownerStarted
    const duplicate = await sendRawRequest(path, request)
    releaseFirst?.()

    expect(duplicate).toMatchObject({
      type: 'error',
      data: 'duplicate request ID',
      meta: { request_id: 'same-action-id' },
    })
    expect((await first).type).toBe('fleet_action_response')
    expect(calls).toBe(1)
  })

  test('client matches snapshot responses by request ID', async () => {
    const path = socketPath('client-snapshot')
    setOnAgentFleetSnapshot(() => snapshot)
    await startUdsMessaging(path, { isExplicit: true })

    const result = await requestAgentFleetSnapshot(path, {
      requestId: 'client-snapshot-1',
      timeoutMs: 200,
    })

    expect(result).toEqual(snapshot)
  })

  test('client ignores a snapshot response with a different request ID', async () => {
    const path = socketPath('mismatched-response')
    await writeTestCapability(path, 'test-token')
    const receiver = createServer(socket => {
      socket.once('data', () => {
        socket.write(
          `${JSON.stringify({
            type: 'fleet_snapshot_response',
            request_id: 'wrong-id',
            snapshot: { ...snapshot, revision: 'wrong' },
          })}\n${JSON.stringify({
            type: 'fleet_snapshot_response',
            request_id: 'expected-id',
            snapshot,
          })}\n`,
        )
      })
    })
    await new Promise<void>((resolve, reject) => {
      receiver.once('error', reject)
      receiver.listen(path, resolve)
    })

    try {
      await expect(
        requestAgentFleetSnapshot(path, {
          requestId: 'expected-id',
          timeoutMs: 200,
        }),
      ).resolves.toEqual(snapshot)
    } finally {
      await new Promise<void>(resolve => receiver.close(() => resolve()))
      if (process.platform !== 'win32')
        await unlink(path).catch(() => undefined)
    }
  })

  test('late snapshot responses after timeout do not affect the next request', async () => {
    const path = socketPath('late-response')
    let release: (() => void) | undefined
    const ownerMayFinish = new Promise<void>(resolve => {
      release = resolve
    })
    setOnAgentFleetSnapshot(async () => {
      await ownerMayFinish
      return snapshot
    })
    await startUdsMessaging(path, { isExplicit: true })

    await expect(
      requestAgentFleetSnapshot(path, {
        requestId: 'timed-out-snapshot',
        timeoutMs: 10,
      }),
    ).rejects.toThrow('timed out')
    release?.()
    setOnAgentFleetSnapshot(() => snapshot)

    await expect(
      requestAgentFleetSnapshot(path, {
        requestId: 'next-snapshot',
        timeoutMs: 200,
      }),
    ).resolves.toEqual(snapshot)
  })

  test('owner callback can atomically reject an action after snapshot state changes', async () => {
    const path = socketPath('stale-action')
    let currentRevision = 'r1'
    setOnAgentFleetSnapshot(() => snapshot)
    setOnAgentFleetAction(action => {
      if (action.revision !== currentRevision) {
        return { ok: false, code: 'stale', message: 'owner state changed' }
      }
      return { ok: true, action: action.type, id: action.id }
    })
    await startUdsMessaging(path, { isExplicit: true })
    currentRevision = 'r2'

    const result = await requestAgentFleetAction(
      path,
      {
        type: 'stop',
        id: 'agent-1',
        revision: 'r1',
        updatedAt: 1,
      },
      { requestId: 'stale-action-1', timeoutMs: 200 },
    )

    expect(result).toEqual({
      ok: false,
      code: 'stale',
      message: 'owner state changed',
    })
  })

  test('owner shutdown rejects an in-flight snapshot request', async () => {
    const path = socketPath('owner-shutdown')
    let markStarted: (() => void) | undefined
    let release: (() => void) | undefined
    const ownerStarted = new Promise<void>(resolve => {
      markStarted = resolve
    })
    const ownerMayFinish = new Promise<void>(resolve => {
      release = resolve
    })
    setOnAgentFleetSnapshot(async () => {
      markStarted?.()
      await ownerMayFinish
      return snapshot
    })
    await startUdsMessaging(path, { isExplicit: true })
    const pending = requestAgentFleetSnapshot(path, {
      requestId: 'owner-shutdown-1',
      timeoutMs: 200,
    })
    await ownerStarted

    const stopping = stopUdsMessaging()
    await expect(pending).rejects.toThrow('before response')
    release?.()
    await stopping
  })

  test('requester disconnect before action completion leaves the owner usable', async () => {
    const path = socketPath('requester-disconnect')
    let markStarted: (() => void) | undefined
    let release: (() => void) | undefined
    const ownerStarted = new Promise<void>(resolve => {
      markStarted = resolve
    })
    const ownerMayFinish = new Promise<void>(resolve => {
      release = resolve
    })
    setOnAgentFleetAction(async action => {
      markStarted?.()
      await ownerMayFinish
      return { ok: true, action: action.type, id: action.id }
    })
    await startUdsMessaging(path, { isExplicit: true })
    const authToken = await readUdsCapabilityToken(path)
    if (!authToken) throw new Error('test capability token missing')
    const socket = createConnection(path)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    socket.write(
      `${JSON.stringify({
        type: 'fleet_action',
        request_id: 'disconnected-action',
        action: {
          type: 'stop',
          id: 'agent-1',
          revision: 'r1',
          updatedAt: 1,
        },
        meta: { authToken },
      })}\n`,
    )
    await ownerStarted
    socket.destroy()
    release?.()
    setOnAgentFleetSnapshot(() => snapshot)

    await expect(
      requestAgentFleetSnapshot(path, {
        requestId: 'after-disconnect',
        timeoutMs: 200,
      }),
    ).resolves.toEqual(snapshot)
  })

  test('rejects an oversized fleet response frame', async () => {
    const path = socketPath('oversized-response')
    setOnAgentFleetSnapshot(() => ({
      ...snapshot,
      revision: 'x'.repeat(MAX_UDS_FRAME_BYTES),
    }))
    await startUdsMessaging(path, { isExplicit: true })

    await expect(
      requestAgentFleetSnapshot(path, {
        requestId: 'oversized-response-1',
        timeoutMs: 200,
      }),
    ).rejects.toThrow('frame exceeded size limit')
  })
})
