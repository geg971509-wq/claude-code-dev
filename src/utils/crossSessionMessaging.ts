import type { PermissionMode } from '../types/permissions.js'
import { randomUUID } from 'crypto'
import { registerCleanup } from './cleanupRegistry.js'
import type {
  CrossSessionInboundMessage,
  PeerPermissionClass,
  PeerReceiptStatus,
} from './crossSessionInbox.js'
import { enqueue } from './messageQueueManager.js'
import { parseAddress } from './peerAddress.js'
import {
  acceptOutstandingPeerReceipt,
  clearOutstandingPeerSends,
} from './peerMessaging.js'
import {
  materializeLocalPeerFiles,
  sweepStalePeerFileTransfers,
} from './peerFileTransfer.js'
import { PeerInboundRuntime } from './peerInboundRuntime.js'
import { buildPeerReceipt, type PeerReceipt } from './peerMessageEnvelope.js'
import { settingsChangeDetector } from './settings/changeDetector.js'
import { getInitialSettings } from './settings/settings.js'
import {
  getUdsMessagingSocketPath,
  setOnPeerMessage,
  setOnPeerMessageStatus,
} from './udsMessaging.js'

let permissionClass: PeerPermissionClass | undefined
let runtime: PeerInboundRuntime | undefined
let wake: (() => void) | undefined
let unsubscribeSettings: (() => void) | undefined
let unregisterCleanup: (() => void) | undefined

export function permissionClassForMode(
  mode: PermissionMode,
): PeerPermissionClass {
  return mode === 'bypassPermissions' ? 'bypass' : 'prompting'
}

function currentAddress(): string | undefined {
  const path = getUdsMessagingSocketPath()
  return path ? `uds:${path}` : undefined
}

async function sendReceipt(
  message: CrossSessionInboundMessage,
  status: PeerReceiptStatus,
): Promise<void> {
  const address = parseAddress(message.from)
  if (address.scheme === 'uds') {
    const { sendUdsPeerReceipt } = await import('./udsClient.js')
    await sendUdsPeerReceipt(address.target, {
      msgId: message.msgId,
      status,
      from: currentAddress(),
    })
    return
  }

  if (address.scheme === 'bridge') {
    const [{ postInterClaudeMessage }, { getSelfBridgeCompatId }] =
      await Promise.all([
        import('../bridge/peerSessions.js'),
        import('../bridge/replBridgeHandle.js'),
      ])
    const result = await postInterClaudeMessage(
      address.target,
      buildPeerReceipt({
        msgId: message.msgId,
        status,
        from: getSelfBridgeCompatId()
          ? `bridge:${getSelfBridgeCompatId()}`
          : undefined,
      }),
      { msgId: randomUUID() },
    )
    if (!result.ok) throw new Error(result.error)
    return
  }

  if (address.scheme === 'cloud') {
    const [{ getSessionId }, { sendEventToRemoteSession }] = await Promise.all([
      import('../bootstrap/state.js'),
      import('./teleport/api.js'),
    ])
    const sent = await sendEventToRemoteSession(
      address.target,
      [
        {
          type: 'text',
          text: buildPeerReceipt({
            msgId: message.msgId,
            status,
            from: `cloud:${getSessionId()}`,
          }),
        },
      ],
      { uuid: randomUUID() },
    )
    if (!sent) throw new Error('Remote session rejected the receipt')
  }
}

export function configureCrossSessionMessaging(options: {
  permissionMode: PermissionMode
  wake?: () => void
}): PeerInboundRuntime {
  permissionClass = permissionClassForMode(options.permissionMode)
  wake = options.wake
  if (!runtime) {
    runtime = new PeerInboundRuntime({
      getPolicy: () => getInitialSettings().crossSessionInbound,
      getPermissionClass: () => permissionClass,
      enqueue,
      wake: () => wake?.(),
      sendReceipt,
      materializeAttachments: attachments =>
        materializeLocalPeerFiles(attachments),
    })
    setOnPeerMessage(message => runtime!.receiveUds(message))
    setOnPeerMessageStatus(receipt => {
      receiveCrossSessionReceipt(receipt)
    })
    unsubscribeSettings = settingsChangeDetector.subscribe(() => {
      void runtime?.reevaluate()
    })
    unregisterCleanup = registerCleanup(shutdownCrossSessionMessaging)
    void sweepStalePeerFileTransfers()
  }
  return runtime
}

export function setCrossSessionPermissionMode(mode: PermissionMode): void {
  permissionClass = permissionClassForMode(mode)
  void runtime?.reevaluate()
}

export function receiveCrossSessionMessage(
  message: CrossSessionInboundMessage,
): Promise<PeerReceiptStatus> {
  if (!runtime) throw new Error('Cross-session messaging is not configured')
  return runtime.receive(message)
}

export function receiveCrossSessionReceipt(receipt: PeerReceipt): boolean {
  if (!runtime || !acceptOutstandingPeerReceipt(receipt)) return false
  runtime.receiveStatus(receipt)
  return true
}

export function getHeldCrossSessionMessages(): ReturnType<
  PeerInboundRuntime['getHeld']
> {
  return runtime?.getHeld() ?? []
}

export function subscribeHeldCrossSessionMessages(
  listener: () => void,
): () => void {
  return runtime?.subscribeHeld(listener) ?? (() => undefined)
}

export function subscribeCrossSessionReceipts(
  listener: (receipt: PeerReceipt) => void,
): () => void {
  return runtime?.subscribeStatus(listener) ?? (() => undefined)
}

export function resolveHeldCrossSessionMessage(
  msgId: string,
  action: 'approve' | 'deny' | 'cancelled',
): ReturnType<PeerInboundRuntime['resolveHeld']> {
  return runtime?.resolveHeld(msgId, action) ?? Promise.resolve('gone')
}

export async function shutdownCrossSessionMessaging(): Promise<void> {
  const active = runtime
  runtime = undefined
  setOnPeerMessage(null)
  setOnPeerMessageStatus(null)
  unsubscribeSettings?.()
  unsubscribeSettings = undefined
  unregisterCleanup?.()
  unregisterCleanup = undefined
  clearOutstandingPeerSends()
  await active?.shutdown()
}
