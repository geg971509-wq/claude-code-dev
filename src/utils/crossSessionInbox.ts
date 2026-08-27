import type { QueuePriority } from '../types/textInputTypes.js'

export type CrossSessionInboundPolicy = 'accept' | 'hold' | 'refuse'
export type PeerPermissionClass = 'prompting' | 'bypass'
export type PeerReceiptStatus = 'held' | 'denied' | 'expired' | 'delivered'
export type PeerHoldCause =
  | 'bypass-default'
  | 'explicit-setting'
  | 'mode-unknown'
  | 'mode-mismatch'
  | 'no-mode-asserted'

export type CrossSessionInboundMessage = {
  msgId: string
  uuid: string
  from: string
  name?: string
  content: string
  priority: QueuePriority
  transport: 'uds' | 'bridge' | 'cloud'
  fromMode?: PeerPermissionClass
  selfSent?: boolean
  attachments?: unknown[]
}

export type CrossSessionDeliveryStatus =
  | 'delivered'
  | 'held'
  | 'denied'
  | 'expired'

type CrossSessionInboxDeps = {
  getPolicy: () => CrossSessionInboundPolicy | undefined
  getPermissionClass: () => PeerPermissionClass | undefined
  deliver: (message: CrossSessionInboundMessage) => void | Promise<void>
  sendReceipt?: (
    message: CrossSessionInboundMessage,
    status: PeerReceiptStatus,
  ) => void | Promise<void>
  onHeld?: (
    message: CrossSessionInboundMessage,
    heldCount: number,
    cause: PeerHoldCause,
  ) => void
  onDropped?: (message: CrossSessionInboundMessage) => void | Promise<void>
  onReleased?: (messages: CrossSessionInboundMessage[]) => void
  heldLimit?: number
  settledLimit?: number
}

type HeldEntry = {
  message: CrossSessionInboundMessage
  cause: PeerHoldCause
}

type Verdict =
  | { policy: 'accept'; cause: PeerHoldCause }
  | { policy: 'hold'; cause: PeerHoldCause }
  | { policy: 'refuse'; cause: PeerHoldCause }

const DEFAULT_HELD_LIMIT = 100
const DEFAULT_SETTLED_LIMIT = 2_048

export class CrossSessionInbox {
  readonly #deps: CrossSessionInboxDeps
  readonly #held: HeldEntry[] = []
  readonly #settled = new Map<string, CrossSessionDeliveryStatus>()
  readonly #inFlight = new Map<string, Promise<CrossSessionDeliveryStatus>>()
  #operationTail: Promise<void> = Promise.resolve()
  #shuttingDown = false

  constructor(deps: CrossSessionInboxDeps) {
    this.#deps = deps
  }

  getHeld(): ReadonlyArray<{
    message: CrossSessionInboundMessage
    cause: PeerHoldCause
  }> {
    return this.#held
  }

  async receive(
    message: CrossSessionInboundMessage,
  ): Promise<CrossSessionDeliveryStatus> {
    const inFlight = this.#inFlight.get(message.msgId)
    if (inFlight) return inFlight
    const operation = this.#runExclusive(() => this.#receiveOnce(message))
    this.#inFlight.set(message.msgId, operation)
    try {
      return await operation
    } finally {
      if (this.#inFlight.get(message.msgId) === operation) {
        this.#inFlight.delete(message.msgId)
      }
    }
  }

  async #receiveOnce(
    message: CrossSessionInboundMessage,
  ): Promise<CrossSessionDeliveryStatus> {
    const prior = this.#settled.get(message.msgId)
    if (prior) return prior
    const held = this.#held.find(entry => entry.message.msgId === message.msgId)
    if (held) return 'held'

    if (this.#shuttingDown) {
      await this.#deps.onDropped?.(message)
      await this.#settle(message, 'expired')
      return 'expired'
    }
    const verdict = this.#verdict(message)
    if (verdict.policy === 'accept') {
      await this.#deliver(message)
      return 'delivered'
    }
    if (verdict.policy === 'refuse') {
      await this.#deps.onDropped?.(message)
      await this.#settle(message, 'denied')
      return 'denied'
    }
    const limit = this.#deps.heldLimit ?? DEFAULT_HELD_LIMIT
    if (this.#held.length >= limit) {
      const evicted = this.#held.shift()
      if (evicted) {
        await this.#deps.onDropped?.(evicted.message)
        await this.#settle(evicted.message, 'expired')
      }
    }
    this.#held.push({ message, cause: verdict.cause })
    this.#deps.onHeld?.(message, this.#held.length, verdict.cause)
    await this.#receipt(message, 'held')
    return 'held'
  }

  resolveHeld(
    msgId: string,
    action: 'approve' | 'deny' | 'cancelled',
  ): Promise<'delivered' | 'dropped' | 'gone'> {
    return this.#runExclusive(() => this.#resolveHeld(msgId, action))
  }

  async #resolveHeld(
    msgId: string,
    action: 'approve' | 'deny' | 'cancelled',
  ): Promise<'delivered' | 'dropped' | 'gone'> {
    const index = this.#held.findIndex(entry => entry.message.msgId === msgId)
    if (index === -1) return 'gone'
    const [entry] = this.#held.splice(index, 1)
    if (!entry) return 'gone'

    if (action === 'approve') {
      if (this.#deps.getPolicy() === 'refuse') {
        await this.#deps.onDropped?.(entry.message)
        await this.#settle(entry.message, 'denied')
        return 'dropped'
      }
      await this.#deliver(entry.message)
      this.#deps.onReleased?.([entry.message])
      return 'delivered'
    }

    await this.#deps.onDropped?.(entry.message)
    await this.#settle(entry.message, action === 'deny' ? 'denied' : 'expired')
    return 'dropped'
  }

  reevaluate(): Promise<number> {
    return this.#runExclusive(() => this.#reevaluate())
  }

  async #reevaluate(): Promise<number> {
    if (this.#held.length === 0) return 0
    const retained: HeldEntry[] = []
    const released: CrossSessionInboundMessage[] = []
    for (const entry of this.#held) {
      const verdict = this.#verdict(entry.message)
      if (verdict.policy === 'accept') {
        await this.#deliver(entry.message)
        released.push(entry.message)
      } else if (verdict.policy === 'refuse') {
        await this.#deps.onDropped?.(entry.message)
        await this.#settle(entry.message, 'denied')
      } else {
        retained.push({ ...entry, cause: verdict.cause })
        if (entry.cause !== verdict.cause) {
          this.#deps.onHeld?.(entry.message, retained.length, verdict.cause)
        }
      }
    }
    this.#held.length = 0
    this.#held.push(...retained)
    if (released.length > 0) this.#deps.onReleased?.(released)
    return released.length
  }

  shutdown(): Promise<void> {
    return this.#runExclusive(() => this.#shutdown())
  }

  async #shutdown(): Promise<void> {
    this.#shuttingDown = true
    const held = this.#held.splice(0)
    for (const entry of held) {
      await this.#deps.onDropped?.(entry.message)
      await this.#settle(entry.message, 'expired')
    }
  }

  #verdict(message: CrossSessionInboundMessage): Verdict {
    const configured = this.#deps.getPolicy()
    if (configured) return { policy: configured, cause: 'explicit-setting' }
    if (message.selfSent) return { policy: 'accept', cause: 'bypass-default' }

    const receiverMode = this.#deps.getPermissionClass()
    if (!receiverMode) return { policy: 'hold', cause: 'mode-unknown' }
    if (message.fromMode) {
      return message.fromMode === receiverMode
        ? { policy: 'accept', cause: 'bypass-default' }
        : { policy: 'hold', cause: 'mode-mismatch' }
    }
    return receiverMode === 'bypass'
      ? { policy: 'hold', cause: 'no-mode-asserted' }
      : { policy: 'accept', cause: 'bypass-default' }
  }

  async #deliver(message: CrossSessionInboundMessage): Promise<void> {
    await this.#deps.deliver(message)
    await this.#settle(message, 'delivered')
  }

  async #settle(
    message: CrossSessionInboundMessage,
    status: PeerReceiptStatus,
  ): Promise<void> {
    this.#remember(message.msgId, status)
    await this.#receipt(message, status)
  }

  async #receipt(
    message: CrossSessionInboundMessage,
    status: PeerReceiptStatus,
  ): Promise<void> {
    try {
      await this.#deps.sendReceipt?.(message, status)
    } catch {
      // Delivery is authoritative locally; a best-effort receipt must not undo it.
    }
  }

  #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation)
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  #remember(msgId: string, status: CrossSessionDeliveryStatus): void {
    this.#settled.delete(msgId)
    this.#settled.set(msgId, status)
    const limit = this.#deps.settledLimit ?? DEFAULT_SETTLED_LIMIT
    while (this.#settled.size > limit) {
      const oldest = this.#settled.keys().next().value
      if (oldest === undefined) break
      this.#settled.delete(oldest)
    }
  }
}
