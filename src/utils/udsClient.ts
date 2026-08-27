/**
 * UDS Client — connect to peer Claude Code sessions via Unix Domain Sockets.
 *
 * Peers are discovered by reading the PID-file registry in ~/.claude/sessions/
 * (written by concurrentSessions.ts) and checking each entry's
 * `messagingSocketPath` field. A peer is "alive" if its PID is running and
 * its socket accepts a ping/pong round-trip.
 */

import { randomUUID } from 'node:crypto'
import { createConnection, type Socket } from 'net'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { logForDebugging } from './debug.js'
import { errorMessage, isFsInaccessible } from './errors.js'
import { isProcessRunning } from './genericProcessUtils.js'
import { jsonParse, jsonStringify } from './slowOperations.js'
import type { SessionKind } from './concurrentSessions.js'
import { MAX_UDS_FRAME_BYTES, type UdsMessage } from './udsMessaging.js'
import { attachUdsResponseReader, getChunkBytes } from './udsResponseReader.js'
import type {
  PeerEnvelopeMetadata,
  PeerReceipt,
} from './peerMessageEnvelope.js'
import {
  buildUdsPeerReceipt,
  buildUdsPeerUserMessage,
  isUdsFleetActionResponse,
  isUdsFleetSnapshotResponse,
} from './peerMessageEnvelope.js'
import type {
  AgentFleetAction,
  AgentFleetActionResult,
  AgentFleetSnapshot,
} from '../services/agentFleet/types.js'
import type { LocalPeerFile } from './peerFileTransfer.js'
import {
  cancelOutstandingPeerSend,
  registerOutstandingPeerSend,
} from './peerMessaging.js'
import type { QueuePriority } from '../types/textInputTypes.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PeerSession = {
  pid: number
  sessionId?: string
  cwd?: string
  startedAt?: number
  kind?: SessionKind
  name?: string
  messagingSocketPath?: string
  entrypoint?: string
  bridgeSessionId?: string | null
  status?: string
  waitingFor?: string
  logPath?: string
  engine?: 'tmux' | 'detached' | 'pty'
  ptySocketPath?: string
  ptyTokenPath?: string
  updatedAt?: number
  alive: boolean
}

export class UdsPeerConnectionError extends Error {
  readonly socketPath: string

  constructor(socketPath: string, cause: unknown) {
    super(
      `Failed to connect to peer at ${socketPath}: ${errorMessage(cause)}`,
      { cause },
    )
    this.name = 'UdsPeerConnectionError'
    this.socketPath = socketPath
  }
}

type UdsPeerSendInput = {
  content: string
  msg_id?: string
  summary?: string
  fromMode?: PeerEnvelopeMetadata['fromMode']
  priority?: QueuePriority
  attachments?: LocalPeerFile[]
  sessionId?: string
}

type UdsPeerSendResult = {
  msgId: string
  status: PeerReceipt['status']
}

export type AgentFleetUdsRequestOptions = {
  readonly requestId?: string
  readonly timeoutMs?: number
}

export const AGENT_FLEET_UDS_TIMEOUT_MS = 1_500

// ---------------------------------------------------------------------------
// Session directory
// ---------------------------------------------------------------------------

function getSessionsDir(): string {
  return join(getClaudeConfigHomeDir(), 'sessions')
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * List all live sessions from the PID registry, optionally probing their
 * UDS sockets for liveness. Sessions whose PID is no longer running are
 * excluded (and their stale files cleaned up).
 */
export async function listAllLiveSessions(): Promise<PeerSession[]> {
  const dir = getSessionsDir()
  let files: string[]
  try {
    files = await readdir(dir)
  } catch (e) {
    if (!isFsInaccessible(e)) {
      logForDebugging(`[udsClient] readdir failed: ${errorMessage(e)}`)
    }
    return []
  }

  const results: PeerSession[] = []

  for (const file of files) {
    if (!/^\d+\.json$/.test(file)) continue
    const pid = parseInt(file.slice(0, -5), 10)

    if (!isProcessRunning(pid)) {
      // Stale — skip (concurrentSessions handles cleanup)
      continue
    }

    try {
      const raw = await readFile(join(dir, file), 'utf8')
      const data = jsonParse(raw) as Record<string, unknown>
      results.push({
        pid,
        sessionId: data.sessionId as string | undefined,
        cwd: data.cwd as string | undefined,
        startedAt: data.startedAt as number | undefined,
        kind: data.kind as SessionKind | undefined,
        name: data.name as string | undefined,
        messagingSocketPath: data.messagingSocketPath as string | undefined,
        entrypoint: data.entrypoint as string | undefined,
        bridgeSessionId: data.bridgeSessionId as string | null | undefined,
        status: data.status as string | undefined,
        waitingFor: data.waitingFor as string | undefined,
        logPath: data.logPath as string | undefined,
        engine: data.engine as PeerSession['engine'],
        updatedAt: data.updatedAt as number | undefined,
        alive: true,
      })
    } catch {
      // Corrupted file — skip
    }
  }

  return results
}

/**
 * List peer sessions that have a UDS messaging socket (i.e. can receive
 * messages). Excludes the current process.
 */
export async function listPeers(): Promise<PeerSession[]> {
  const all = await listAllLiveSessions()
  return all.filter(s => s.pid !== process.pid && s.messagingSocketPath != null)
}

async function findAuthTokenForSocketPath(
  socketPath: string,
): Promise<string | undefined> {
  const { readUdsCapabilityToken } = await import('./udsMessaging.js')
  return readUdsCapabilityToken(socketPath)
}

// ---------------------------------------------------------------------------
// Connection helpers
// ---------------------------------------------------------------------------

/**
 * Probe a UDS socket to check if a server is listening (ping/pong).
 * Returns true if the peer responds within the timeout.
 */
export async function isPeerAlive(
  socketPath: string,
  timeoutMs = 3000,
  authToken?: string,
): Promise<boolean> {
  const token = authToken ?? (await findAuthTokenForSocketPath(socketPath))
  if (!token) return false

  return new Promise<boolean>(resolve => {
    const conn = createConnection(socketPath, () => {
      const ping: UdsMessage = {
        type: 'ping',
        ts: new Date().toISOString(),
        meta: { authToken: token },
      }
      conn.write(jsonStringify(ping) + '\n')
    })

    let resolved = false

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        conn.destroy()
        resolve(false)
      }
    }, timeoutMs)

    let buffer = ''
    conn.on('data', chunk => {
      if (
        Buffer.byteLength(buffer, 'utf8') + getChunkBytes(chunk) >
        MAX_UDS_FRAME_BYTES
      ) {
        if (!resolved) {
          resolved = true
          clearTimeout(timer)
          conn.destroy()
          resolve(false)
        }
        return
      }
      buffer += chunk.toString()
      if (buffer.includes('"pong"')) {
        if (!resolved) {
          resolved = true
          clearTimeout(timer)
          conn.end()
          resolve(true)
        }
      }
    })

    conn.on('error', () => {
      if (!resolved) {
        resolved = true
        clearTimeout(timer)
        resolve(false)
      }
    })
  })
}

/**
 * Send a text message to a peer's UDS socket. This is the high-level helper
 * used by SendMessageTool for `uds:<path>` addresses.
 */
async function sendAuthenticatedMessage(
  targetSocketPath: string,
  message: UdsMessage,
  timeoutMs = 5000,
  acceptResponse?: (response: UdsMessage) => boolean,
): Promise<UdsMessage> {
  const { parseUdsTarget } = await import('./udsMessaging.js')
  const target = parseUdsTarget(targetSocketPath)
  const authToken = await findAuthTokenForSocketPath(target.socketPath)
  if (!authToken) {
    throw new Error(`No auth token found for peer at ${target.socketPath}`)
  }

  return new Promise<UdsMessage>((resolve, reject) => {
    let settled = false
    let conn: ReturnType<typeof createConnection>
    const finish = (error?: Error, response?: UdsMessage): void => {
      if (settled) return
      settled = true
      if (error) {
        conn.destroy(error)
        reject(error)
      } else {
        conn.end()
        if (!response) {
          reject(new Error('UDS receiver returned no response'))
          return
        }
        resolve(response)
      }
    }

    conn = createConnection(target.socketPath, () => {
      const outbound = {
        ...message,
        meta: { ...message.meta, authToken },
      }
      conn.write(jsonStringify(outbound) + '\n', err => {
        if (err) finish(err)
      })
    })
    attachUdsResponseReader(conn, {
      maxFrameBytes: MAX_UDS_FRAME_BYTES,
      onSettled: finish,
      acceptResponse,
      formatSocketError: err =>
        new UdsPeerConnectionError(target.socketPath, err),
    })
    conn.setTimeout(timeoutMs, () => {
      finish(
        new UdsPeerConnectionError(
          target.socketPath,
          new Error('Connection timed out'),
        ),
      )
    })
  })
}

function isFleetResponseFor(
  response: UdsMessage,
  requestId: string,
  responseType: 'fleet_snapshot_response' | 'fleet_action_response',
): boolean {
  if (response.type === 'error') {
    return response.meta?.request_id === requestId
  }
  return response.type === responseType && response.request_id === requestId
}

export async function requestAgentFleetSnapshot(
  targetSocketPath: string,
  options: AgentFleetUdsRequestOptions = {},
): Promise<AgentFleetSnapshot> {
  const requestId = options.requestId ?? randomUUID()
  const response = await sendAuthenticatedMessage(
    targetSocketPath,
    { type: 'fleet_snapshot', request_id: requestId },
    options.timeoutMs ?? AGENT_FLEET_UDS_TIMEOUT_MS,
    value => isFleetResponseFor(value, requestId, 'fleet_snapshot_response'),
  )
  if (!isUdsFleetSnapshotResponse(response)) {
    throw new Error('UDS owner returned an invalid fleet snapshot')
  }
  return response.snapshot
}

export async function requestAgentFleetAction(
  targetSocketPath: string,
  action: AgentFleetAction,
  options: AgentFleetUdsRequestOptions = {},
): Promise<AgentFleetActionResult> {
  const requestId = options.requestId ?? randomUUID()
  const response = await sendAuthenticatedMessage(
    targetSocketPath,
    { type: 'fleet_action', request_id: requestId, action },
    options.timeoutMs ?? AGENT_FLEET_UDS_TIMEOUT_MS,
    value => isFleetResponseFor(value, requestId, 'fleet_action_response'),
  )
  if (!isUdsFleetActionResponse(response)) {
    throw new Error('UDS owner returned an invalid fleet action result')
  }
  return response.result
}

export function sendToUdsSocket(
  targetSocketPath: string,
  message: string,
  timeoutMs?: number,
): Promise<undefined>
export function sendToUdsSocket(
  targetSocketPath: string,
  message: UdsPeerSendInput,
  timeoutMs?: number,
): Promise<UdsPeerSendResult>
export async function sendToUdsSocket(
  targetSocketPath: string,
  message: string | UdsPeerSendInput,
  timeoutMs = 5000,
): Promise<undefined | UdsPeerSendResult> {
  if (typeof message === 'string') {
    const { getUdsMessagingSocketPath } = await import('./udsMessaging.js')
    await sendAuthenticatedMessage(
      targetSocketPath,
      {
        type: 'text',
        data: message,
        from: getUdsMessagingSocketPath(),
        ts: new Date().toISOString(),
      },
      timeoutMs,
    )
    return
  }

  const { getUdsMessagingSocketPath, parseUdsTarget } = await import(
    './udsMessaging.js'
  )
  const senderSocket = getUdsMessagingSocketPath()
  if (!senderSocket) throw new Error('Peer messaging server is not running')
  const msgId = message.msg_id ?? randomUUID()
  const target = parseUdsTarget(targetSocketPath)
  registerOutstandingPeerSend(msgId, {
    transport: 'uds',
    address: `uds:${target.socketPath}`,
    id: target.socketPath,
  })
  let response: UdsMessage
  try {
    response = await sendAuthenticatedMessage(
      targetSocketPath,
      {
        ...buildUdsPeerUserMessage({
          content: message.content,
          from: `uds:${senderSocket}`,
          fromMode: message.fromMode,
          msgId,
          sessionId: message.sessionId,
          priority: message.priority,
          attachments: message.attachments,
        }),
        ...(message.summary ? { meta: { summary: message.summary } } : {}),
      },
      timeoutMs,
    )
  } catch (error) {
    cancelOutstandingPeerSend(msgId)
    throw error
  }
  const status = response.meta?.status
  if (
    status !== 'held' &&
    status !== 'denied' &&
    status !== 'expired' &&
    status !== 'delivered'
  ) {
    throw new Error('UDS receiver returned an invalid peer status')
  }
  return { msgId, status }
}

export async function sendUdsPeerReceipt(
  targetSocketPath: string,
  receipt: PeerReceipt,
  timeoutMs = 5000,
): Promise<void> {
  await sendAuthenticatedMessage(
    targetSocketPath,
    buildUdsPeerReceipt(receipt),
    timeoutMs,
  )
}

/**
 * Connect to a peer and return the raw socket for bidirectional communication.
 * The caller owns the post-connect lifecycle through onSocketError, which is
 * attached before the Promise resolves so peer socket errors cannot be
 * swallowed or surface through a listener handoff window.
 * Pre-connect failures reject with UdsPeerConnectionError.
 * This only opens the transport; callers still own any capability handshake.
 */
export function connectToPeer(
  socketPath: string,
  onSocketError: (error: Error) => void,
  timeoutMs = 5000,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const conn = createConnection(socketPath)
    let settled = false
    const timeout = setTimeout(
      fail,
      timeoutMs,
      new Error('Connection timed out'),
    )
    function cleanupListeners(): void {
      clearTimeout(timeout)
      conn.off('error', fail)
    }
    function fail(cause: unknown): void {
      if (settled) {
        return
      }
      settled = true
      cleanupListeners()
      conn.destroy()
      reject(new UdsPeerConnectionError(socketPath, cause))
    }
    conn.once('connect', () => {
      if (settled) {
        return
      }
      settled = true
      cleanupListeners()
      conn.on('error', onSocketError)
      resolve(conn)
    })
    conn.on('error', fail)
  })
}

/**
 * Disconnect a previously connected peer socket.
 */
export function disconnectPeer(socket: Socket): void {
  if (!socket.destroyed) {
    socket.end()
  }
}
