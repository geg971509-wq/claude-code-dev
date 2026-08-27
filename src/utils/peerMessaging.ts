import { randomUUID } from 'node:crypto'
import { errorMessage } from './errors.js'
import { parseAddress } from './peerAddress.js'
import type { PeerReceipt } from './peerMessageEnvelope.js'
import {
  formatPeerAddress,
  type PeerCandidate,
  type PeerRoster,
  resolvePeerTarget,
} from './peerRegistry.js'

export type PeerMessageStatus = 'delivered' | 'queued' | 'held'

export type PeerOutboundMessage = {
  msgId: string
  content: string
  summary: string
}

export type PeerTransportSender = (
  target: PeerCandidate,
  message: PeerOutboundMessage,
) => Promise<{ status: PeerMessageStatus }>

export type PeerSendErrorCode =
  | 'ambiguous_target'
  | 'target_not_found'
  | 'discovery_unavailable'
  | 'stale_target'
  | 'unsupported_transport'
  | 'delivery_failed'

export type PeerSendResult =
  | {
      success: true
      message: string
      msg_id: string
      status: PeerMessageStatus
      target: PeerCandidate
    }
  | {
      success: false
      message: string
      error_code: PeerSendErrorCode
      msg_id?: string
    }

export type PeerMessagingDeps = {
  discover: () => Promise<PeerRoster>
  send: PeerTransportSender
  createMessageId?: () => string
  verifyTarget?: (to: string, target: PeerCandidate) => string | undefined
}

type OutstandingPeerSend = {
  transport: 'uds' | 'bridge' | 'cloud'
  peerIdentity: string
  status: 'pending' | 'held'
}

const DEFAULT_OUTSTANDING_SEND_LIMIT = 2_048

function expectedPeerReceiptIdentity(
  target: Pick<PeerCandidate, 'address' | 'id' | 'sessionId' | 'transport'>,
): Pick<OutstandingPeerSend, 'peerIdentity' | 'transport'> | undefined {
  if (
    target.transport !== 'uds' &&
    target.transport !== 'bridge' &&
    target.transport !== 'cloud'
  ) {
    return undefined
  }
  const address = target.address ? parseAddress(target.address) : undefined
  return {
    transport: target.transport,
    peerIdentity:
      address?.scheme === target.transport
        ? address.target
        : (target.sessionId ?? target.id),
  }
}

export class OutstandingPeerSendRegistry {
  readonly #entries = new Map<string, OutstandingPeerSend>()

  constructor(readonly limit = DEFAULT_OUTSTANDING_SEND_LIMIT) {}

  register(
    msgId: string,
    target: Pick<PeerCandidate, 'address' | 'id' | 'sessionId' | 'transport'>,
  ): boolean {
    const identity = expectedPeerReceiptIdentity(target)
    if (!identity) return false
    this.#entries.delete(msgId)
    this.#entries.set(msgId, { ...identity, status: 'pending' })
    while (this.#entries.size > this.limit) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) break
      this.#entries.delete(oldest)
    }
    return true
  }

  cancel(msgId: string): void {
    this.#entries.delete(msgId)
  }

  accept(receipt: PeerReceipt): boolean {
    const entry = this.#entries.get(receipt.msgId)
    if (!entry || !receipt.from) return false
    const from = parseAddress(receipt.from)
    if (from.scheme !== entry.transport || from.target !== entry.peerIdentity) {
      return false
    }
    if (receipt.status === 'held') {
      if (entry.status !== 'pending') return false
      entry.status = 'held'
      return true
    }
    this.#entries.delete(receipt.msgId)
    return true
  }

  clear(): void {
    this.#entries.clear()
  }
}

const outstandingPeerSends = new OutstandingPeerSendRegistry()

export function registerOutstandingPeerSend(
  msgId: string,
  target: Pick<PeerCandidate, 'address' | 'id' | 'sessionId' | 'transport'>,
): boolean {
  return outstandingPeerSends.register(msgId, target)
}

export function cancelOutstandingPeerSend(msgId: string): void {
  outstandingPeerSends.cancel(msgId)
}

export function acceptOutstandingPeerReceipt(receipt: PeerReceipt): boolean {
  return outstandingPeerSends.accept(receipt)
}

export function clearOutstandingPeerSends(): void {
  outstandingPeerSends.clear()
}

export function derivePeerMessageSummary(content: string): string {
  const firstLine = content
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean)
  return (firstLine || 'Message').slice(0, 80)
}

export function peerTargetRequiresIsolation(
  to: string,
  roster?: PeerRoster,
): boolean {
  const address = parseAddress(to)
  if (address.scheme === 'bridge' || address.scheme === 'cloud') return true
  if (address.scheme !== 'other' || !roster) return false

  const resolution = resolvePeerTarget(roster, to)
  if (resolution.kind === 'resolved') {
    return (
      resolution.candidate.transport === 'bridge' ||
      resolution.candidate.transport === 'cloud'
    )
  }
  return (
    resolution.kind === 'not-found' &&
    (roster.unavailable.bridge !== undefined ||
      roster.unavailable.cloud !== undefined)
  )
}

function directCandidate(
  transport: 'uds' | 'cloud' | 'bridge',
  target: string,
): PeerCandidate {
  const address = `${transport}:${target}`
  return {
    kind: transport === 'uds' ? 'local-session' : `${transport}-session`,
    transport,
    id: target,
    sessionId: transport === 'uds' ? undefined : target,
    name: address,
    address,
    ref: 'direct',
    mirroredTransports: [],
    canReply: true,
  }
}

async function resolveTarget(
  to: string,
  discover: () => Promise<PeerRoster>,
): Promise<
  | { candidate: PeerCandidate }
  | { error_code: PeerSendErrorCode; message: string }
> {
  const address = parseAddress(to)
  if (
    address.scheme === 'uds' ||
    address.scheme === 'cloud' ||
    address.scheme === 'bridge'
  ) {
    return { candidate: directCandidate(address.scheme, address.target) }
  }
  if (address.scheme === 'tcp') {
    return {
      error_code: 'unsupported_transport',
      message:
        'tcp peer messaging is not supported; use a listed agent address',
    }
  }

  const roster = await discover()
  const resolution = resolvePeerTarget(roster, to)
  if (resolution.kind === 'resolved') {
    return { candidate: resolution.candidate }
  }
  if (resolution.kind === 'ambiguous') {
    return {
      error_code: 'ambiguous_target',
      message: `Agent name is ambiguous; use one of: ${resolution.candidates
        .map(candidate => formatPeerAddress(candidate.name, candidate.ref))
        .join(', ')}`,
    }
  }
  const unavailable = Object.keys(resolution.unavailable)
  if (unavailable.length > 0) {
    return {
      error_code: 'discovery_unavailable',
      message: `Agent not found; discovery unavailable for: ${unavailable.join(', ')}`,
    }
  }
  return {
    error_code: 'target_not_found',
    message: `Agent not found: ${to}`,
  }
}

export async function sendPeerMessage(
  input: { to: string; content: string; summary?: string },
  deps: PeerMessagingDeps,
): Promise<PeerSendResult> {
  const resolution = await resolveTarget(input.to, deps.discover)
  if ('error_code' in resolution) {
    return { success: false, ...resolution }
  }
  const pinError = deps.verifyTarget?.(input.to, resolution.candidate)
  if (pinError) {
    return {
      success: false,
      message: pinError,
      error_code: 'stale_target',
    }
  }

  const msgId = (deps.createMessageId ?? randomUUID)()
  const summary =
    input.summary?.trim() || derivePeerMessageSummary(input.content)
  try {
    const delivery = await deps.send(resolution.candidate, {
      msgId,
      content: input.content,
      summary,
    })
    const label = formatPeerAddress(
      resolution.candidate.name,
      resolution.candidate.ref,
    )
    return {
      success: true,
      message: `Message ${delivery.status} to ${label} via ${resolution.candidate.transport}`,
      msg_id: msgId,
      status: delivery.status,
      target: resolution.candidate,
    }
  } catch (error) {
    return {
      success: false,
      message: `Message delivery failed: ${errorMessage(error)}`,
      error_code: 'delivery_failed',
      msg_id: msgId,
    }
  }
}
