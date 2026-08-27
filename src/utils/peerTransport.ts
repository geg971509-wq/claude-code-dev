import type {
  PeerPermissionClass,
  PeerReceiptStatus,
} from './crossSessionInbox.js'
import { buildPeerMessageEnvelope } from './peerMessageEnvelope.js'
import type { LocalPeerFile } from './peerFileTransfer.js'
import {
  cancelOutstandingPeerSend,
  registerOutstandingPeerSend,
} from './peerMessaging.js'
import type { PeerCandidate } from './peerRegistry.js'
import type { RemoteFileAttachment } from './remoteSessionEvents.js'

type PeerDeliveryStatus =
  | Exclude<PeerReceiptStatus, 'denied' | 'expired'>
  | 'queued'

export type CrossSessionPeerTarget = Pick<
  PeerCandidate,
  'address' | 'id' | 'sessionId' | 'transport'
>

export async function sendCrossSessionPeer(
  target: CrossSessionPeerTarget,
  message: {
    content: string
    msgId: string
    summary?: string
    senderName?: string
    fromMode: PeerPermissionClass
    sessionId: string
    udsAttachments?: LocalPeerFile[]
    remoteAttachments?: RemoteFileAttachment[]
  },
): Promise<{ status: PeerDeliveryStatus }> {
  if (target.transport !== 'uds') {
    registerOutstandingPeerSend(message.msgId, target)
  }
  try {
    if (target.transport === 'uds') {
      const { sendToUdsSocket } = await import('./udsClient.js')
      const result = await sendToUdsSocket(target.address ?? target.id, {
        content: message.content,
        summary: message.summary,
        msg_id: message.msgId,
        sessionId: target.sessionId,
        fromMode: message.fromMode,
        attachments: message.udsAttachments,
      })
      if (result.status === 'denied' || result.status === 'expired') {
        throw new Error(`Remote session ${result.status} the message`)
      }
      return {
        status: result.status === 'delivered' ? 'queued' : result.status,
      }
    }

    if (target.transport === 'cloud') {
      const { sendEventToRemoteSession } = await import('./teleport/api.js')
      const sent = await sendEventToRemoteSession(
        target.sessionId ?? target.id,
        [
          {
            type: 'text',
            text: buildPeerMessageEnvelope(message.content, {
              from: `cloud:${message.sessionId}`,
              name: message.senderName,
              msgId: message.msgId,
              fromMode: message.fromMode,
            }),
          },
        ],
        {
          uuid: message.msgId,
          fileAttachments: message.remoteAttachments,
        },
      )
      if (!sent) throw new Error('Remote session rejected the message')
      return { status: 'queued' }
    }

    if (target.transport === 'bridge') {
      const [{ postInterClaudeMessage }, { getSelfBridgeCompatId }] =
        await Promise.all([
          import('../bridge/peerSessions.js'),
          import('../bridge/replBridgeHandle.js'),
        ])
      const self = getSelfBridgeCompatId()
      if (!self) throw new Error('Bridge session is not connected')
      const sent = await postInterClaudeMessage(
        target.sessionId ?? target.id,
        buildPeerMessageEnvelope(message.content, {
          from: `bridge:${self}`,
          name: message.senderName,
          msgId: message.msgId,
          fromMode: message.fromMode,
        }),
        {
          msgId: message.msgId,
          fileAttachments: message.remoteAttachments,
        },
      )
      if (!sent.ok) throw new Error(sent.error)
      return { status: 'queued' }
    }

    throw new Error(`Unsupported cross-session transport: ${target.transport}`)
  } catch (error) {
    cancelOutstandingPeerSend(message.msgId)
    throw error
  }
}
