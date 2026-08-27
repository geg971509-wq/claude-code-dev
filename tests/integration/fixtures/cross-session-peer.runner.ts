import { createInterface } from 'readline'
import { switchSession } from '../../../src/bootstrap/state.js'
import { getDefaultAppState } from '../../../src/state/AppStateStore.js'
import { ListAgentsTool } from '../../../src/tools/ListAgentsTool/ListAgentsTool.js'
import { SendFileTool } from '../../../src/tools/SendFileTool/SendFileTool.js'
import { SendMessageTool } from '../../../src/tools/SendMessageTool/SendMessageTool.js'
import {
  registerSession,
  updateSessionName,
} from '../../../src/utils/concurrentSessions.js'
import {
  configureCrossSessionMessaging,
  getHeldCrossSessionMessages,
  resolveHeldCrossSessionMessage,
  shutdownCrossSessionMessaging,
  subscribeCrossSessionReceipts,
} from '../../../src/utils/crossSessionMessaging.js'
import {
  getCommandQueueSnapshot,
  resetCommandQueue,
} from '../../../src/utils/messageQueueManager.js'
import { stageLocalPeerFile } from '../../../src/utils/peerFileTransfer.js'
import { sendToUdsSocket } from '../../../src/utils/udsClient.js'
import {
  startUdsMessaging,
  stopUdsMessaging,
} from '../../../src/utils/udsMessaging.js'
import type { PeerReceipt } from '../../../src/utils/peerMessageEnvelope.js'

const [socketPath, permissionMode, sessionId, name] = process.argv.slice(2)
if (!socketPath || !permissionMode || !sessionId || !name) {
  throw new Error(
    'socket path, permission mode, session id, and name are required',
  )
}

switchSession(sessionId as never)
resetCommandQueue()
await startUdsMessaging(socketPath, { isExplicit: true, sessionId })
process.env.CLAUDE_CODE_SESSION_NAME = name
if (!(await registerSession())) throw new Error('session registration failed')
await updateSessionName(name)
configureCrossSessionMessaging({
  permissionMode: permissionMode as 'default' | 'bypassPermissions',
})

let appState = getDefaultAppState()
appState = {
  ...appState,
  toolPermissionContext: {
    ...appState.toolPermissionContext,
    mode: permissionMode as 'default' | 'bypassPermissions',
  },
}
const toolContext = {
  getAppState: () => appState,
  setAppState: (update: (state: typeof appState) => typeof appState) => {
    appState = update(appState)
  },
  abortController: new AbortController(),
}

const receipts: PeerReceipt[] = []
const unsubscribe = subscribeCrossSessionReceipts(receipt =>
  receipts.push(receipt),
)

function respond(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

respond({ ready: true, socketPath })

const input = createInterface({ input: process.stdin })
let sequence = Promise.resolve()
input.on('line', line => {
  sequence = sequence.then(async () => {
    const command = JSON.parse(line) as {
      id: number
      type:
        | 'list'
        | 'send-tool'
        | 'send-file-tool'
        | 'send'
        | 'approve'
        | 'snapshot'
        | 'stop'
      target?: string
      path?: string
      content?: string
      msgId?: string
      fromMode?: 'prompting' | 'bypass'
      targetSessionId?: string
    }
    try {
      if (command.type === 'list') {
        const result = await ListAgentsTool.call({}, toolContext as never)
        respond({ id: command.id, ok: true, result })
        return
      }
      if (command.type === 'send-tool') {
        const result = await SendMessageTool.call(
          {
            to: command.target!,
            message: command.content!,
            summary: 'cross-session integration message',
          },
          toolContext as never,
          (() => undefined) as never,
        )
        respond({ id: command.id, ok: true, result })
        return
      }
      if (command.type === 'send-file-tool') {
        const result = await SendFileTool.call(
          {
            to: command.target!,
            files: [command.path!],
            message: command.content,
          },
          toolContext as never,
        )
        respond({ id: command.id, ok: true, result })
        return
      }
      if (command.type === 'send') {
        const attachments = command.path
          ? [await stageLocalPeerFile(command.path)]
          : undefined
        const result = await sendToUdsSocket(command.target!, {
          content: command.content!,
          msg_id: command.msgId,
          fromMode: command.fromMode,
          attachments,
          sessionId: command.targetSessionId,
        })
        respond({ id: command.id, ok: true, result })
        return
      }
      if (command.type === 'approve') {
        const result = await resolveHeldCrossSessionMessage(
          command.msgId!,
          'approve',
        )
        respond({ id: command.id, ok: true, result })
        return
      }
      if (command.type === 'snapshot') {
        respond({
          id: command.id,
          ok: true,
          result: {
            held: getHeldCrossSessionMessages(),
            queued: getCommandQueueSnapshot(),
            receipts,
          },
        })
        return
      }
      unsubscribe()
      await shutdownCrossSessionMessaging()
      await stopUdsMessaging()
      respond({ id: command.id, ok: true, result: 'stopped' })
      input.close()
      setTimeout(() => process.exit(0), 0)
    } catch (error) {
      respond({
        id: command.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
})
