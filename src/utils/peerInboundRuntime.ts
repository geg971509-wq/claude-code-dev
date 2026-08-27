import type { QueuedCommand } from '../types/textInputTypes.js'
import { lstat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  CrossSessionInbox,
  type CrossSessionInboundMessage,
  type CrossSessionInboundPolicy,
  type PeerPermissionClass,
  type PeerReceiptStatus,
} from './crossSessionInbox.js'
import {
  buildPeerMessageEnvelope,
  type PeerReceipt,
  type UdsPeerUserMessage,
} from './peerMessageEnvelope.js'
import { createSignal } from './signal.js'
import { getClaudeConfigHomeDir } from './envUtils.js'

export type PeerInboundRuntimeDeps = {
  getPolicy: () => CrossSessionInboundPolicy | undefined
  getPermissionClass: () => PeerPermissionClass | undefined
  enqueue: (command: QueuedCommand) => void | Promise<void>
  wake?: () => void
  sendReceipt?: (
    message: CrossSessionInboundMessage,
    status: PeerReceiptStatus,
  ) => void | Promise<void>
  materializeAttachments: (
    attachments: unknown,
  ) => Promise<{ prefix: string; paths: string[] }>
  materializeRemoteAttachments?: (
    attachments: unknown,
  ) => Promise<{ prefix: string; paths: string[] }>
  cleanupAttachments?: (attachments: unknown) => Promise<void>
}

async function cleanupLocalAttachments(input: unknown): Promise<void> {
  if (!Array.isArray(input)) return
  const spool = resolve(join(getClaudeConfigHomeDir(), 'file-transfers'))
  for (const value of input) {
    const path =
      typeof value === 'object' && value !== null && 'path' in value
        ? (value as { path?: unknown }).path
        : undefined
    if (typeof path !== 'string' || !isAbsolute(path)) continue
    const target = resolve(path)
    if (dirname(target) !== spool) continue
    try {
      const info = await lstat(target)
      if (info.isFile() && !info.isSymbolicLink()) await unlink(target)
    } catch {
      // Already moved, missing, or not safe to unlink.
    }
  }
}

export class PeerInboundRuntime {
  readonly #deps: PeerInboundRuntimeDeps
  readonly #heldChanged = createSignal()
  readonly #statusChanged = createSignal<[PeerReceipt]>()
  readonly #inbox: CrossSessionInbox

  constructor(deps: PeerInboundRuntimeDeps) {
    this.#deps = deps
    this.#inbox = new CrossSessionInbox({
      getPolicy: deps.getPolicy,
      getPermissionClass: deps.getPermissionClass,
      deliver: message => this.#deliver(message),
      sendReceipt: deps.sendReceipt,
      onHeld: () => this.#heldChanged.emit(),
      onDropped: async message => {
        await this.#cleanup(message)
        this.#heldChanged.emit()
      },
      onReleased: () => this.#heldChanged.emit(),
    })
  }

  receiveUds(message: UdsPeerUserMessage): Promise<PeerReceiptStatus> {
    return this.#inbox.receive({
      msgId: message.msg_id,
      uuid: message.uuid,
      from: message.from,
      content: message.message.content,
      priority: message.priority,
      transport: 'uds',
      fromMode: message.fromMode,
      selfSent: false,
      attachments: message.file_attachments,
    })
  }

  receive(message: CrossSessionInboundMessage): Promise<PeerReceiptStatus> {
    return this.#inbox.receive(message)
  }

  receiveStatus(receipt: PeerReceipt): void {
    this.#statusChanged.emit(receipt)
  }

  getHeld(): ReturnType<CrossSessionInbox['getHeld']> {
    return this.#inbox.getHeld()
  }

  resolveHeld(
    msgId: string,
    action: 'approve' | 'deny' | 'cancelled',
  ): ReturnType<CrossSessionInbox['resolveHeld']> {
    return this.#inbox.resolveHeld(msgId, action)
  }

  reevaluate(): Promise<number> {
    return this.#inbox.reevaluate()
  }

  shutdown(): Promise<void> {
    return this.#inbox.shutdown()
  }

  subscribeHeld(listener: () => void): () => void {
    return this.#heldChanged.subscribe(listener)
  }

  subscribeStatus(listener: (receipt: PeerReceipt) => void): () => void {
    return this.#statusChanged.subscribe(listener)
  }

  async #deliver(message: CrossSessionInboundMessage): Promise<void> {
    let materialized = { prefix: '', paths: [] as string[] }
    if (message.attachments?.length) {
      if (message.transport === 'uds') {
        try {
          materialized = await this.#deps.materializeAttachments(
            message.attachments,
          )
        } finally {
          await this.#cleanup(message)
        }
      } else {
        const materialize =
          this.#deps.materializeRemoteAttachments ??
          (await import('../bridge/inboundAttachments.js'))
            .materializeInboundAttachments
        materialized = await materialize(message.attachments)
      }
    }
    const content = buildPeerMessageEnvelope(
      `${materialized.prefix}${message.content}`,
      {
        from: message.from,
        name: message.name,
        msgId: message.msgId,
        fromMode: message.fromMode,
      },
    )
    await this.#deps.enqueue({
      value: content,
      mode: 'prompt',
      priority: message.priority,
      isMeta: true,
      skipSlashCommands: true,
      origin: {
        kind: 'cross-session',
        transport: message.transport,
        from: message.from,
        name: message.name,
        msgId: message.msgId,
        attachmentPaths: materialized.paths,
      },
    })
    this.#deps.wake?.()
  }

  async #cleanup(message: CrossSessionInboundMessage): Promise<void> {
    if (message.transport !== 'uds' || !message.attachments?.length) return
    try {
      await (this.#deps.cleanupAttachments ?? cleanupLocalAttachments)(
        message.attachments,
      )
    } catch {
      // Cleanup is best-effort and must not suppress the authoritative receipt.
    }
  }
}
