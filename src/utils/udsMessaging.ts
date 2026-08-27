/**
 * UDS Messaging Layer — Unix Domain Socket IPC for Claude Code instances.
 *
 * Each session auto-creates a UDS server so peer sessions can send messages.
 * Protocol: newline-delimited JSON (NDJSON), one message per line.
 *
 * Socket path defaults to a tmpdir-based path derived from the session PID,
 * but can be overridden via --messaging-socket-path.
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { createServer, type Server, type Socket } from 'net'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rmdir,
  unlink,
} from 'fs/promises'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { errorMessage } from './errors.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { attachNdjsonFramer } from './ndjsonFramer.js'
import { attachUdsResponseReader } from './udsResponseReader.js'
import { logError } from './log.js'
import { jsonParse, jsonStringify } from './slowOperations.js'
import type { PeerReceipt, UdsPeerUserMessage } from './peerMessageEnvelope.js'
import {
  isUdsFleetActionRequest,
  isUdsFleetSnapshotRequest,
  isUdsPeerReceiptMessage,
  isUdsPeerUserMessage,
} from './peerMessageEnvelope.js'
import type { PeerReceiptStatus } from './crossSessionInbox.js'
import type {
  AgentFleetAction,
  AgentFleetActionResult,
  AgentFleetSnapshot,
} from '../services/agentFleet/types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LegacyUdsMessageType =
  | 'text'
  | 'notification'
  | 'query'
  | 'response'
  | 'error'
  | 'ping'
  | 'pong'

export type LegacyUdsMessage = {
  /** Discriminator */
  type: LegacyUdsMessageType
  /** Payload text / JSON content */
  data?: string
  /** Sender socket path (so the receiver can reply) */
  from?: string
  /** ISO timestamp */
  ts?: string
  /** Optional metadata */
  meta?: Record<string, unknown>
}

export type UdsMessage =
  | LegacyUdsMessage
  | import('./peerMessageEnvelope.js').UdsPeerUserMessage
  | import('./peerMessageEnvelope.js').UdsPeerReceiptMessage
  | import('./peerMessageEnvelope.js').UdsFleetSnapshotRequest
  | import('./peerMessageEnvelope.js').UdsFleetSnapshotResponse
  | import('./peerMessageEnvelope.js').UdsFleetActionRequest
  | import('./peerMessageEnvelope.js').UdsFleetActionResponse

export type UdsInboxEntry = {
  id: string
  message: LegacyUdsMessage
  receivedAt: number
  status: 'pending' | 'processed'
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let server: Server | null = null
let socketPath: string | null = null
let onEnqueueCb: (() => void) | null = null
let onPeerMessageCb:
  | ((
      message: UdsPeerUserMessage,
    ) => PeerReceiptStatus | Promise<PeerReceiptStatus>)
  | null = null
let onPeerMessageStatusCb:
  | ((receipt: PeerReceipt) => void | Promise<void>)
  | null = null
let onAgentFleetSnapshotCb:
  | (() => AgentFleetSnapshot | Promise<AgentFleetSnapshot>)
  | null = null
let onAgentFleetActionCb:
  | ((
      action: AgentFleetAction,
    ) => AgentFleetActionResult | Promise<AgentFleetActionResult>)
  | null = null
const clients = new Set<Socket>()
const fleetRequestIds = new Set<string>()
const inbox: UdsInboxEntry[] = []
let nextId = 1
let defaultSocketPath: string | null = null
let authToken: string | null = null
let capabilityFilePath: string | null = null
let socketParentToCleanup: string | null = null
let inboxBytes = 0
let startupError: string | undefined

export const MAX_UDS_INBOX_ENTRIES = 1_000
export const MAX_UDS_FRAME_BYTES = 64 * 1024
export const MAX_UDS_INBOX_BYTES = 2 * 1024 * 1024
export const MAX_UDS_CLIENTS = 128
export const UDS_AUTH_TIMEOUT_MS = 2_000
export const UDS_IDLE_TIMEOUT_MS = 30_000
const MAX_FLEET_REQUEST_IDS = 2_048

/** macOS/BSD AF_UNIX `sun_path` limit (bytes, excluding NUL). */
export const MAX_UNIX_SOCKET_PATH_LENGTH = 104

// ---------------------------------------------------------------------------
// Public API — socket path helpers
// ---------------------------------------------------------------------------

export function assertValidUnixSocketPath(path: string): void {
  if (process.platform === 'win32') return
  const byteLength = Buffer.byteLength(path, 'utf8')
  if (byteLength > MAX_UNIX_SOCKET_PATH_LENGTH) {
    throw new Error(
      `[udsMessaging] socket path is ${byteLength} bytes (max ${MAX_UNIX_SOCKET_PATH_LENGTH}): ${path}`,
    )
  }
}

/**
 * Default socket path based on PID. Uses a flat file under a short temp
 * directory so the path stays within the AF_UNIX limit on macOS.
 *
 * On Windows, Node.js requires named pipe paths in the `\\.\pipe\` namespace;
 * file-system paths like `C:\...\Temp\x.sock` cause EACCES. Bun handles both
 * transparently, but we use the pipe format on Windows for Node.js compat.
 */
export function getDefaultUdsSocketPath(): string {
  if (defaultSocketPath) return defaultSocketPath
  const nonce = randomBytes(8).toString('hex')
  if (process.platform === 'win32') {
    defaultSocketPath = `\\\\.\\pipe\\claude-code-${process.pid}-${nonce}`
    return defaultSocketPath
  }

  defaultSocketPath = join(
    tmpdir(),
    'cc-socks',
    `${process.pid}-${nonce}`,
    'messaging.sock',
  )
  assertValidUnixSocketPath(defaultSocketPath)
  return defaultSocketPath
}

/**
 * Returns the socket path of the currently running server, or undefined
 * if the server has not been started.
 */
export function getUdsMessagingSocketPath(): string | undefined {
  return socketPath ?? undefined
}

export function getUdsMessagingStartupError(): string | undefined {
  return startupError
}

export function formatUdsAddress(socket: string): string {
  return `uds:${socket}`
}

export function parseUdsTarget(target: string): {
  socketPath: string
} {
  if (target.includes('#token=')) {
    throw new Error(
      'UDS target must not include an inline auth token; use the ListPeers address',
    )
  }
  return { socketPath: target.startsWith('uds:') ? target.slice(4) : target }
}

function getCapabilityDir(): string {
  return join(getClaudeConfigHomeDir(), 'messaging-capabilities')
}

function getCapabilityPath(socket: string): string {
  const digest = createHash('sha256').update(socket).digest('hex')
  return join(getCapabilityDir(), `${digest}.json`)
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

async function assertPrivateCapabilityDir(dir: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof lstat>>
  try {
    stat = await lstat(dir)
  } catch (error) {
    if (!isNotFound(error)) throw error
    await mkdir(dir, { recursive: true, mode: 0o700 })
    stat = await lstat(dir)
  }

  assertPrivateDirectory(stat, dir, 'capability directory')
  await chmod(dir, 0o700)
}

function assertPrivateDirectory(
  stat: Awaited<ReturnType<typeof lstat>>,
  dir: string,
  label: string,
): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      `[udsMessaging] ${label} is not a private directory: ${dir}`,
    )
  }
  if (process.platform !== 'win32') {
    const broadMode = Number(stat.mode) & 0o077
    if (broadMode !== 0) {
      throw new Error(
        `[udsMessaging] ${label} permissions are too broad: ${dir}`,
      )
    }
    if (
      typeof process.getuid === 'function' &&
      Number(stat.uid) !== process.getuid()
    ) {
      throw new Error(
        `[udsMessaging] ${label} owner does not match current user: ${dir}`,
      )
    }
  }
}

async function writePrivateFileExclusive(
  path: string,
  content: string,
): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf-8')
  } finally {
    await handle.close()
  }
  await chmod(path, 0o600)
}

async function ensureSocketParent(path: string): Promise<void> {
  const dir = dirname(path)
  try {
    const stat = await lstat(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`[udsMessaging] socket parent is not a directory: ${dir}`)
    }
    assertPrivateDirectory(stat, dir, 'socket parent')
    return
  } catch (error) {
    if (!isNotFound(error)) throw error
  }

  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
}

async function writeCapabilityFile(
  socket: string,
  token: string,
): Promise<void> {
  const dir = getCapabilityDir()
  await assertPrivateCapabilityDir(dir)
  const target = getCapabilityPath(socket)
  const temp = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  try {
    await writePrivateFileExclusive(
      temp,
      jsonStringify({ socketPath: socket, authToken: token }),
    )
    await rename(temp, target)
  } catch (error) {
    try {
      await unlink(temp)
    } catch {
      // Temp file may not exist if exclusive creation failed.
    }
    throw error
  }
  capabilityFilePath = target
}

export async function readUdsCapabilityToken(
  socket: string,
): Promise<string | undefined> {
  try {
    const parsed = jsonParse(
      await readFile(getCapabilityPath(socket), 'utf-8'),
    ) as Record<string, unknown>
    if (parsed.socketPath === socket && typeof parsed.authToken === 'string') {
      return parsed.authToken
    }
  } catch {
    // Missing or unreadable capability file means the peer is not addressable.
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

/**
 * Register a callback invoked whenever a message is enqueued into the inbox.
 * Used by the print/SDK query loop to kick off processing.
 */
export function setOnEnqueue(cb: (() => void) | null): void {
  onEnqueueCb = cb
}

export function setOnPeerMessage(
  cb:
    | ((
        message: UdsPeerUserMessage,
      ) => PeerReceiptStatus | Promise<PeerReceiptStatus>)
    | null,
): void {
  onPeerMessageCb = cb
}

export function setOnPeerMessageStatus(
  cb: ((receipt: PeerReceipt) => void | Promise<void>) | null,
): void {
  onPeerMessageStatusCb = cb
}

export function setOnAgentFleetSnapshot(
  cb: (() => AgentFleetSnapshot | Promise<AgentFleetSnapshot>) | null,
): void {
  onAgentFleetSnapshotCb = cb
}

export function setOnAgentFleetAction(
  cb:
    | ((
        action: AgentFleetAction,
      ) => AgentFleetActionResult | Promise<AgentFleetActionResult>)
    | null,
): void {
  onAgentFleetActionCb = cb
}

/**
 * Drain all pending inbox messages and release retained history.
 */
export function drainInbox(): UdsInboxEntry[] {
  const pending = inbox.splice(0, inbox.length)
  inboxBytes = 0
  for (const entry of pending) {
    entry.status = 'processed'
  }
  return pending
}

function getMessageBytes(message: LegacyUdsMessage): number {
  return Buffer.byteLength(jsonStringify(message), 'utf8')
}

function enqueueInboxEntry(entry: UdsInboxEntry): boolean {
  const entryBytes = getMessageBytes(entry.message)
  if (
    entryBytes > MAX_UDS_FRAME_BYTES ||
    inbox.length >= MAX_UDS_INBOX_ENTRIES ||
    inboxBytes + entryBytes > MAX_UDS_INBOX_BYTES
  ) {
    logError(
      new Error(
        `[udsMessaging] inbox full (${inbox.length}/${MAX_UDS_INBOX_ENTRIES}, ${inboxBytes}/${MAX_UDS_INBOX_BYTES} bytes); dropping message type=${entry.message.type}`,
      ),
    )
    return false
  }
  inbox.push(entry)
  inboxBytes += entryBytes
  return true
}

function ensureAuthToken(): string {
  if (!authToken) {
    authToken = randomBytes(32).toString('hex')
  }
  return authToken
}

function getMessageAuthToken(message: UdsMessage): string | undefined {
  const token = message.meta?.authToken
  return typeof token === 'string' ? token : undefined
}

function isAuthorizedMessage(message: UdsMessage): boolean {
  const provided = getMessageAuthToken(message)
  if (!provided || !authToken) return false
  const providedBuffer = Buffer.from(provided, 'utf8')
  const expectedBuffer = Buffer.from(authToken, 'utf8')
  if (providedBuffer.length !== expectedBuffer.length) return false
  return timingSafeEqual(providedBuffer, expectedBuffer)
}

function writeSocketMessage(socket: Socket, message: UdsMessage): void {
  if (socket.destroyed) return
  socket.write(jsonStringify(message) + '\n')
}

function writeSocketMessageAndDestroy(
  socket: Socket,
  message: UdsMessage,
): void {
  if (socket.destroyed) return
  socket.write(jsonStringify(message) + '\n', () => {
    if (!socket.destroyed) socket.destroy()
  })
}

function writeSocketErrorAndDestroy(socket: Socket, data: string): void {
  writeSocketMessageAndDestroy(socket, {
    type: 'error',
    data,
    ts: new Date().toISOString(),
  })
}

function writeFleetError(
  socket: Socket,
  requestId: string,
  data: string,
): void {
  writeSocketMessage(socket, {
    type: 'error',
    data,
    ts: new Date().toISOString(),
    meta: { request_id: requestId },
  })
}

function rememberFleetRequestId(requestId: string): boolean {
  if (fleetRequestIds.has(requestId)) return false
  fleetRequestIds.add(requestId)
  if (fleetRequestIds.size > MAX_FLEET_REQUEST_IDS) {
    const oldest = fleetRequestIds.values().next().value
    if (typeof oldest === 'string') fleetRequestIds.delete(oldest)
  }
  return true
}

function requestIdFromUnknown(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('request_id' in value)) {
    return ''
  }
  return typeof value.request_id === 'string' ? value.request_id : ''
}

function isLegacyUdsMessage(message: UdsMessage): message is LegacyUdsMessage {
  return (
    message.type === 'text' ||
    message.type === 'notification' ||
    message.type === 'query' ||
    message.type === 'response' ||
    message.type === 'error' ||
    message.type === 'ping' ||
    message.type === 'pong'
  )
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybeUnref = (timer as { unref?: () => void }).unref
  if (typeof maybeUnref === 'function') {
    maybeUnref.call(timer)
  }
}

async function closeServer(serverToClose: Server): Promise<void> {
  await new Promise<void>(resolve => {
    serverToClose.close(() => resolve())
  })
}

async function removeSocketPath(path: string): Promise<void> {
  if (process.platform === 'win32') return
  try {
    await unlink(path)
  } catch {
    // Already gone.
  }
}

async function removeEmptySocketParent(path: string | null): Promise<void> {
  if (!path || process.platform === 'win32') return
  try {
    await rmdir(path)
  } catch (error) {
    if (
      !isNotFound(error) &&
      (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY'
    ) {
      logForDebugging(
        `[udsMessaging] failed to remove socket parent ${path}: ${errorMessage(error)}`,
      )
    }
  }
}

async function removeStaleSocketPath(
  path: string,
  isExplicit: boolean,
): Promise<void> {
  let stat: Awaited<ReturnType<typeof lstat>>
  try {
    stat = await lstat(path)
  } catch (error) {
    if (isNotFound(error)) return
    throw error
  }

  if (stat.isSymbolicLink()) {
    throw new Error(
      `[udsMessaging] existing path is a symbolic link; refusing to remove it${isExplicit ? ' (explicit)' : ''}: ${path}`,
    )
  }
  if (!stat.isSocket()) {
    throw new Error(
      `[udsMessaging] existing path is not a socket; refusing to remove it${isExplicit ? ' (explicit)' : ''}: ${path}`,
    )
  }
  if (
    typeof process.getuid !== 'function' ||
    Number(stat.uid) !== process.getuid()
  ) {
    throw new Error(
      `[udsMessaging] existing socket is not owned by the current user; refusing to remove it: ${path}`,
    )
  }
  await unlink(path)
}

function stripAuthToken<T extends UdsMessage>(message: T): T {
  const { authToken: _authToken, ...metaWithoutAuth } = message.meta ?? {}
  return {
    ...message,
    meta: Object.keys(metaWithoutAuth).length > 0 ? metaWithoutAuth : undefined,
  } as T
}

function withRequestAuthToken(message: UdsMessage, token: string): UdsMessage {
  return {
    ...message,
    meta: {
      ...message.meta,
      authToken: token,
    },
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Start the UDS messaging server on the given socket path.
 *
 * Exports `CLAUDE_CODE_MESSAGING_SOCKET` into `process.env` so child
 * processes (hooks, spawned agents) can discover and connect back.
 */
export async function startUdsMessaging(
  path: string,
  opts?: { isExplicit?: boolean; sessionId?: string },
): Promise<void> {
  startupError = undefined
  if (server) {
    logForDebugging('[udsMessaging] server already running, skipping start')
    return
  }

  const autoSocketParent = opts?.isExplicit ? null : dirname(path)
  try {
    assertValidUnixSocketPath(path)
    if (process.platform !== 'win32') {
      await ensureSocketParent(path)
      // Clean up a stale socket only after verifying explicit paths are safe.
      await removeStaleSocketPath(path, opts?.isExplicit === true)
    }
  } catch (error) {
    await removeEmptySocketParent(autoSocketParent)
    defaultSocketPath = null
    startupError = errorMessage(error)
    throw error
  }

  const token = ensureAuthToken()
  let startedServer: Server | null = null
  let exportedSocketEnv = false
  try {
    await new Promise<void>((resolve, reject) => {
      const srv = createServer(socket => {
        if (clients.size >= MAX_UDS_CLIENTS) {
          logForDebugging(
            `[udsMessaging] rejected client: ${clients.size}/${MAX_UDS_CLIENTS} clients already connected`,
          )
          socket.destroy()
          return
        }
        clients.add(socket)
        logForDebugging(
          `[udsMessaging] client connected (total: ${clients.size})`,
        )
        let authenticated = false
        let closing = false
        const closeWithError = (data: string): void => {
          if (closing || socket.destroyed) return
          closing = true
          socket.pause()
          writeSocketErrorAndDestroy(socket, data)
        }
        const authTimer = setTimeout(() => {
          if (authenticated || socket.destroyed) return
          logForDebugging('[udsMessaging] closing unauthenticated idle client')
          closeWithError('authentication timeout')
        }, UDS_AUTH_TIMEOUT_MS)
        unrefTimer(authTimer)
        socket.setTimeout(UDS_IDLE_TIMEOUT_MS, () => {
          logForDebugging('[udsMessaging] closing idle client')
          closeWithError('idle timeout')
        })

        attachNdjsonFramer<UdsMessage>(
          socket,
          msg => {
            if (!isAuthorizedMessage(msg)) {
              logForDebugging(
                `[udsMessaging] rejected unauthenticated message type=${msg.type}`,
              )
              closeWithError('unauthorized')
              return
            }
            if (!authenticated) {
              authenticated = true
              clearTimeout(authTimer)
            }

            // Handle ping with automatic pong
            if (msg.type === 'ping') {
              writeSocketMessage(socket, {
                type: 'pong',
                from: socketPath ?? undefined,
                ts: new Date().toISOString(),
              })
              return
            }

            if (msg.type === 'fleet_snapshot') {
              if (!isUdsFleetSnapshotRequest(msg)) {
                writeFleetError(
                  socket,
                  requestIdFromUnknown(msg),
                  'invalid fleet snapshot request',
                )
                return
              }
              if (!rememberFleetRequestId(msg.request_id)) {
                writeFleetError(socket, msg.request_id, 'duplicate request ID')
                return
              }
              void (async () => {
                if (!onAgentFleetSnapshotCb) {
                  writeFleetError(
                    socket,
                    msg.request_id,
                    'fleet snapshot owner unavailable',
                  )
                  return
                }
                try {
                  const snapshot = await onAgentFleetSnapshotCb()
                  writeSocketMessage(socket, {
                    type: 'fleet_snapshot_response',
                    request_id: msg.request_id,
                    snapshot,
                  })
                } catch (error) {
                  writeFleetError(socket, msg.request_id, errorMessage(error))
                }
              })()
              return
            }

            if (msg.type === 'fleet_action') {
              if (!isUdsFleetActionRequest(msg)) {
                writeFleetError(
                  socket,
                  requestIdFromUnknown(msg),
                  'invalid fleet action request',
                )
                return
              }
              if (!rememberFleetRequestId(msg.request_id)) {
                writeFleetError(socket, msg.request_id, 'duplicate request ID')
                return
              }
              void (async () => {
                if (!onAgentFleetActionCb) {
                  writeFleetError(
                    socket,
                    msg.request_id,
                    'fleet action owner unavailable',
                  )
                  return
                }
                try {
                  const result = await onAgentFleetActionCb(msg.action)
                  writeSocketMessage(socket, {
                    type: 'fleet_action_response',
                    request_id: msg.request_id,
                    result,
                  })
                } catch (error) {
                  writeFleetError(socket, msg.request_id, errorMessage(error))
                }
              })()
              return
            }

            if (isUdsPeerUserMessage(msg)) {
              if (
                opts?.sessionId !== undefined &&
                msg.session_id !== undefined &&
                msg.session_id !== opts.sessionId
              ) {
                closeWithError('target session mismatch')
                return
              }
              const sanitizedMessage = stripAuthToken(msg)
              void (async () => {
                try {
                  if (!onPeerMessageCb) {
                    closeWithError('peer receiver unavailable')
                    return
                  }
                  const status = await onPeerMessageCb(sanitizedMessage)
                  writeSocketMessage(socket, {
                    type: 'response',
                    data: 'ok',
                    ts: new Date().toISOString(),
                    meta: { msg_id: msg.msg_id, status },
                  })
                } catch (error) {
                  closeWithError(errorMessage(error))
                }
              })()
              return
            }

            if (isUdsPeerReceiptMessage(msg)) {
              const receipt: PeerReceipt = {
                msgId: msg.orig_msg_id,
                status: msg.status,
                from: msg.from,
                reason: msg.reason,
              }
              void (async () => {
                try {
                  await onPeerMessageStatusCb?.(receipt)
                  writeSocketMessage(socket, {
                    type: 'response',
                    data: 'ok',
                    ts: new Date().toISOString(),
                    meta: { msg_id: msg.orig_msg_id, status: msg.status },
                  })
                } catch (error) {
                  closeWithError(errorMessage(error))
                }
              })()
              return
            }

            if (!isLegacyUdsMessage(msg)) {
              closeWithError('invalid message type')
              return
            }

            // Enqueue into inbox
            const sanitizedMessage = stripAuthToken(msg)
            const entry: UdsInboxEntry = {
              id: `uds-${nextId++}`,
              message: sanitizedMessage,
              receivedAt: Date.now(),
              status: 'pending',
            }
            if (!enqueueInboxEntry(entry)) {
              closeWithError('inbox full')
              return
            }
            logForDebugging(
              `[udsMessaging] enqueued message type=${msg.type} from=${msg.from ?? 'unknown'}`,
            )
            writeSocketMessage(socket, {
              type: 'response',
              data: 'ok',
              ts: new Date().toISOString(),
              meta: { id: entry.id },
            })
            onEnqueueCb?.()
          },
          text => jsonParse(text) as UdsMessage,
          {
            maxFrameBytes: MAX_UDS_FRAME_BYTES,
            onFrameError: error => {
              logForDebugging(`[udsMessaging] ${error.message}`)
              closeWithError(error.message)
            },
            onInvalidFrame: error => {
              logForDebugging(
                `[udsMessaging] invalid client frame: ${errorMessage(error)}`,
              )
              closeWithError('invalid frame')
            },
            destroyOnFrameError: false,
          },
        )

        socket.on('close', () => {
          clearTimeout(authTimer)
          clients.delete(socket)
        })

        socket.on('error', err => {
          clearTimeout(authTimer)
          clients.delete(socket)
          logForDebugging(`[udsMessaging] client error: ${errorMessage(err)}`)
        })
      })

      const rejectBeforeListen = (error: Error): void => {
        reject(error)
      }
      const logRuntimeError = (error: Error): void => {
        logForDebugging(
          `[udsMessaging] server error on ${path}${opts?.isExplicit ? ' (explicit)' : ''}: ${errorMessage(error)}`,
        )
      }

      srv.once('error', rejectBeforeListen)

      srv.listen(path, () => {
        void (async () => {
          try {
            if (process.platform !== 'win32') {
              // Restrict socket permissions to owner-only. On macOS with
              // Node.js v22, the listen callback may fire before the socket
              // file is visible on disk (observed with nested tmpdir paths).
              // The parent directory is already 0o700, so skipping chmod when
              // the file is not yet visible is safe.
              try {
                await chmod(path, 0o600)
              } catch (err: unknown) {
                if (
                  !(
                    err instanceof Error &&
                    (err as NodeJS.ErrnoException).code === 'ENOENT'
                  )
                ) {
                  throw err
                }
                logForDebugging(
                  `[udsMessaging] chmod skipped: socket file not yet visible at ${path}`,
                )
              }
            }
            srv.off('error', rejectBeforeListen)
            srv.on('error', logRuntimeError)
            server = srv
            startedServer = srv
            srv.unref()
            resolve()
          } catch (error) {
            srv.off('error', rejectBeforeListen)
            const closeError =
              error instanceof Error ? error : new Error(errorMessage(error))
            let rejected = false
            const rejectOnce = (): void => {
              if (rejected) return
              rejected = true
              reject(closeError)
            }
            const fallback = setTimeout(rejectOnce, 1_000)
            unrefTimer(fallback)
            srv.close(() => {
              clearTimeout(fallback)
              rejectOnce()
            })
          }
        })()
      })
    })

    await writeCapabilityFile(path, token)
    socketPath = path
    socketParentToCleanup = autoSocketParent
    // Export so child processes can discover the socket only after the
    // capability file exists and the listener is ready.
    process.env.CLAUDE_CODE_MESSAGING_SOCKET = path
    exportedSocketEnv = true
    logForDebugging(
      `[udsMessaging] server listening on ${path}${opts?.isExplicit ? ' (explicit)' : ''}`,
    )
  } catch (error) {
    if (capabilityFilePath) {
      try {
        await unlink(capabilityFilePath)
      } catch {
        // Already gone.
      }
      capabilityFilePath = null
    }
    if (startedServer) {
      await closeServer(startedServer)
    }
    if (server === startedServer) {
      server = null
    }
    await removeSocketPath(path)
    await removeEmptySocketParent(autoSocketParent)
    if (exportedSocketEnv) {
      delete process.env.CLAUDE_CODE_MESSAGING_SOCKET
    }
    socketPath = null
    socketParentToCleanup = null
    defaultSocketPath = null
    authToken = null
    startupError = errorMessage(error)
    throw error
  }

  // Register cleanup so the socket file is removed on exit
  registerCleanup(async () => {
    await stopUdsMessaging()
  })
}

/**
 * Stop the UDS messaging server and clean up the socket file.
 */
export async function stopUdsMessaging(): Promise<void> {
  defaultSocketPath = null
  startupError = undefined
  fleetRequestIds.clear()
  onEnqueueCb = null
  onPeerMessageCb = null
  onPeerMessageStatusCb = null
  onAgentFleetSnapshotCb = null
  onAgentFleetActionCb = null
  if (!server) return

  // Close all connected clients
  for (const socket of clients) {
    socket.destroy()
  }
  clients.clear()

  await new Promise<void>(resolve => {
    server!.close(() => resolve())
  })
  server = null
  inbox.length = 0
  inboxBytes = 0

  // Remove socket file (skip on Windows — pipe paths aren't files)
  if (socketPath) {
    await removeSocketPath(socketPath)
    delete process.env.CLAUDE_CODE_MESSAGING_SOCKET
    logForDebugging(
      `[udsMessaging] server stopped, socket removed: ${socketPath}`,
    )
    socketPath = null
    authToken = null
  }
  await removeEmptySocketParent(socketParentToCleanup)
  socketParentToCleanup = null
  if (capabilityFilePath) {
    try {
      await unlink(capabilityFilePath)
    } catch {
      // Already gone
    }
    capabilityFilePath = null
  }
}

/**
 * Send a UDS message to a specific socket path (outbound — used when this
 * session wants to push a message to a peer's server).
 */
export async function sendUdsMessage(
  targetSocketPath: string,
  message: LegacyUdsMessage,
  opts: { authToken?: string } = {},
): Promise<void> {
  const { createConnection } = await import('net')
  const token = opts.authToken ?? authToken
  if (!token) {
    throw new Error('Cannot send UDS message without auth token')
  }
  const outbound = withRequestAuthToken(
    {
      ...message,
      from: message.from ?? socketPath ?? undefined,
      ts: message.ts ?? new Date().toISOString(),
    },
    token,
  )

  return new Promise<void>((resolve, reject) => {
    let settled = false
    let conn: ReturnType<typeof createConnection>
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (error) {
        conn.destroy(error)
        reject(error)
      } else {
        conn.end()
        resolve()
      }
    }

    conn = createConnection(targetSocketPath, () => {
      conn.write(jsonStringify(outbound) + '\n', err => {
        if (err) finish(err)
      })
    })
    attachUdsResponseReader(conn, {
      maxFrameBytes: MAX_UDS_FRAME_BYTES,
      acceptPong: true,
      onSettled: finish,
    })
    // Timeout so we don't hang on unreachable sockets
    conn.setTimeout(5000, () => {
      finish(new Error('Connection timed out'))
    })
  })
}
