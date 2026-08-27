import type { QueuePriority } from '../types/textInputTypes.js'
import type {
  AgentFleetAction,
  AgentFleetActionResult,
  AgentFleetSnapshot,
} from '../services/agentFleet/types.js'
import type {
  PeerPermissionClass,
  PeerReceiptStatus,
} from './crossSessionInbox.js'
import type { LocalPeerFile } from './peerFileTransfer.js'

export type PeerEnvelopeMetadata = {
  from: string
  name?: string
  msgId: string
  fromMode?: PeerPermissionClass
}

export type ParsedPeerEnvelope = PeerEnvelopeMetadata & { content: string }

export type PeerReceipt = {
  msgId: string
  status: PeerReceiptStatus
  from?: string
  reason?: string
}

export type UdsPeerUserMessage = {
  type: 'user'
  uuid: string
  session_id?: string
  message: { role: 'user'; content: string }
  priority: QueuePriority
  file_attachments?: LocalPeerFile[]
  from: string
  msg_id: string
  fromMode?: PeerPermissionClass
  meta?: Record<string, unknown>
}

export type UdsPeerReceiptMessage = {
  type: 'control'
  action: 'peer_message_status'
  status: PeerReceiptStatus
  orig_msg_id: string
  from?: string
  reason?: string
  meta?: Record<string, unknown>
}

export type UdsFleetSnapshotRequest = {
  type: 'fleet_snapshot'
  request_id: string
  meta?: Record<string, unknown>
}

export type UdsFleetSnapshotResponse = {
  type: 'fleet_snapshot_response'
  request_id: string
  snapshot: AgentFleetSnapshot
  meta?: Record<string, unknown>
}

export type UdsFleetActionRequest = {
  type: 'fleet_action'
  request_id: string
  action: AgentFleetAction
  meta?: Record<string, unknown>
}

export type UdsFleetActionResponse = {
  type: 'fleet_action_response'
  request_id: string
  result: AgentFleetActionResult
  meta?: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function isFleetRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

function isAgentFleetAction(value: unknown): value is AgentFleetAction {
  if (!isRecord(value)) return false
  const common =
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.revision === 'string' &&
    value.revision.length > 0 &&
    typeof value.updatedAt === 'number' &&
    Number.isFinite(value.updatedAt)
  if (!common) return false
  if (value.type === 'message') {
    return (
      hasOnlyKeys(value, ['type', 'id', 'revision', 'updatedAt', 'content']) &&
      typeof value.content === 'string' &&
      value.content.trim().length > 0
    )
  }
  if (value.type === 'resume' || value.type === 'retry') {
    return (
      hasOnlyKeys(value, ['type', 'id', 'revision', 'updatedAt', 'prompt']) &&
      typeof value.prompt === 'string' &&
      value.prompt.trim().length > 0
    )
  }
  return (
    hasOnlyKeys(value, ['type', 'id', 'revision', 'updatedAt']) &&
    (value.type === 'stop' ||
      value.type === 'logs' ||
      value.type === 'attach' ||
      value.type === 'cleanup')
  )
}

export function isUdsFleetSnapshotRequest(
  value: unknown,
): value is UdsFleetSnapshotRequest {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['type', 'request_id', 'meta']) &&
    value.type === 'fleet_snapshot' &&
    isFleetRequestId(value.request_id)
  )
}

export function isUdsFleetActionRequest(
  value: unknown,
): value is UdsFleetActionRequest {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['type', 'request_id', 'action', 'meta']) &&
    value.type === 'fleet_action' &&
    isFleetRequestId(value.request_id) &&
    isAgentFleetAction(value.action)
  )
}

export function isUdsFleetSnapshotResponse(
  value: unknown,
): value is UdsFleetSnapshotResponse {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['type', 'request_id', 'snapshot', 'meta']) &&
    value.type === 'fleet_snapshot_response' &&
    isFleetRequestId(value.request_id) &&
    isRecord(value.snapshot) &&
    typeof value.snapshot.generatedAt === 'number' &&
    typeof value.snapshot.revision === 'string' &&
    typeof value.snapshot.cwd === 'string' &&
    Array.isArray(value.snapshot.records) &&
    typeof value.snapshot.partial === 'boolean' &&
    Array.isArray(value.snapshot.unavailableSources)
  )
}

export function isUdsFleetActionResponse(
  value: unknown,
): value is UdsFleetActionResponse {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['type', 'request_id', 'result', 'meta']) ||
    value.type !== 'fleet_action_response' ||
    !isFleetRequestId(value.request_id) ||
    !isRecord(value.result)
  ) {
    return false
  }
  if (value.result.ok === true) {
    return (
      hasOnlyKeys(value.result, ['ok', 'action', 'id', 'output']) &&
      (value.result.action === 'stop' ||
        value.result.action === 'message' ||
        value.result.action === 'resume' ||
        value.result.action === 'retry' ||
        value.result.action === 'logs' ||
        value.result.action === 'attach' ||
        value.result.action === 'cleanup') &&
      typeof value.result.id === 'string' &&
      (value.result.output === undefined ||
        typeof value.result.output === 'string')
    )
  }
  return (
    value.result.ok === false &&
    hasOnlyKeys(value.result, ['ok', 'code', 'message']) &&
    (value.result.code === 'not-found' ||
      value.result.code === 'stale' ||
      value.result.code === 'unsupported' ||
      value.result.code === 'permission-denied' ||
      value.result.code === 'owner-unavailable' ||
      value.result.code === 'transport-error') &&
    typeof value.result.message === 'string'
  )
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function decodeAttribute(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&')
}

function attributes(values: Record<string, string | undefined>): string {
  return Object.entries(values)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}="${escapeAttribute(value)}"`)
    .join(' ')
}

function parseAttributes(source: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const match of source.matchAll(/([a-z][a-z-]*)="([^"]*)"/g)) {
    result[match[1]!] = decodeAttribute(match[2]!)
  }
  return result
}

export function buildPeerMessageEnvelope(
  content: string,
  metadata: PeerEnvelopeMetadata,
): string {
  const attrs = attributes({
    from: metadata.from,
    'from-name': metadata.name,
    'msg-id': metadata.msgId,
    'from-mode': metadata.fromMode,
  })
  return `<cross-session-message ${attrs}>\n${content}\n</cross-session-message>`
}

export function parsePeerMessageEnvelope(
  value: string,
): ParsedPeerEnvelope | undefined {
  const match =
    /^<cross-session-message\b([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>$/.exec(
      value.trim(),
    )
  if (!match) return undefined
  const attrs = parseAttributes(match[1]!)
  if (!attrs.from || !attrs['msg-id']) return undefined
  const fromMode = attrs['from-mode']
  return {
    content: match[2]!,
    from: attrs.from,
    name: attrs['from-name'],
    msgId: attrs['msg-id'],
    fromMode:
      fromMode === 'prompting' || fromMode === 'bypass' ? fromMode : undefined,
  }
}

export function buildPeerReceipt(receipt: PeerReceipt): string {
  return `<peer-message-status ${attributes({
    'msg-id': receipt.msgId,
    status: receipt.status,
    from: receipt.from,
    reason: receipt.reason,
  })} />`
}

export function parsePeerReceipt(value: string): PeerReceipt | undefined {
  const match = /^<peer-message-status\b([^>]*)\/>$/.exec(value.trim())
  if (!match) return undefined
  const attrs = parseAttributes(match[1]!)
  const status = attrs.status
  if (
    !attrs['msg-id'] ||
    (status !== 'held' &&
      status !== 'denied' &&
      status !== 'expired' &&
      status !== 'delivered')
  ) {
    return undefined
  }
  return {
    msgId: attrs['msg-id'],
    status,
    from: attrs.from,
    reason: attrs.reason,
  }
}

export function buildUdsPeerUserMessage(input: {
  content: string
  from: string
  fromMode?: PeerPermissionClass
  msgId: string
  sessionId?: string
  priority?: QueuePriority
  attachments?: LocalPeerFile[]
}): UdsPeerUserMessage {
  return {
    type: 'user',
    uuid: input.msgId,
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
    message: { role: 'user', content: input.content },
    priority: input.priority ?? 'next',
    ...(input.attachments?.length
      ? { file_attachments: input.attachments }
      : {}),
    from: input.from,
    msg_id: input.msgId,
    ...(input.fromMode ? { fromMode: input.fromMode } : {}),
  }
}

export function isUdsPeerUserMessage(
  value: unknown,
): value is UdsPeerUserMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Partial<UdsPeerUserMessage>
  return (
    message.type === 'user' &&
    typeof message.uuid === 'string' &&
    typeof message.msg_id === 'string' &&
    typeof message.from === 'string' &&
    message.message?.role === 'user' &&
    typeof message.message.content === 'string' &&
    (message.priority === 'now' ||
      message.priority === 'next' ||
      message.priority === 'later')
  )
}

export function isUdsPeerReceiptMessage(
  value: unknown,
): value is UdsPeerReceiptMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Partial<UdsPeerReceiptMessage>
  return (
    message.type === 'control' &&
    message.action === 'peer_message_status' &&
    typeof message.orig_msg_id === 'string' &&
    (message.status === 'held' ||
      message.status === 'denied' ||
      message.status === 'expired' ||
      message.status === 'delivered')
  )
}

export function buildUdsPeerReceipt(
  receipt: PeerReceipt,
): UdsPeerReceiptMessage {
  return {
    type: 'control',
    action: 'peer_message_status',
    status: receipt.status,
    orig_msg_id: receipt.msgId,
    from: receipt.from,
    reason: receipt.reason,
  }
}
