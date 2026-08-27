import { lazySchema } from '@claude-code-best/core-utils/lazySchema'
import { feature } from 'bun:bundle'
import { createHash } from 'crypto'
import { access, stat, unlink } from 'fs/promises'
import { constants } from 'fs'
import { basename, resolve } from 'path'
import { z } from 'zod/v4'
import { getSessionId } from '../../bootstrap/state.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { errorMessage } from '../../utils/errors.js'
import { discoverPeerRosterForTarget } from '../../utils/peerDiscovery.js'
import {
  MAX_PEER_FILE_BYTES,
  MAX_PEER_FILES,
  peerFileMediaType,
  readPeerFileBounded,
  stageLocalPeerFile,
} from '../../utils/peerFileTransfer.js'
import { sendPeerMessage } from '../../utils/peerMessaging.js'
import { sendCrossSessionPeer } from '../../utils/peerTransport.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getAgentName, isTeammate } from '../../utils/teammate.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { hasIsolatePeerMachines } from '../../utils/settings/settings.js'
import { FileReadTool } from '../FileReadTool/FileReadTool.js'
import { SEND_FILE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, PROMPT } from './prompt.js'

export { MAX_PEER_FILE_BYTES } from '../../utils/peerFileTransfer.js'

const inputSchema = lazySchema(() =>
  z.object({
    to: z.string().min(1).describe('Peer session name or explicit address'),
    files: z.preprocess(
      value => (typeof value === 'string' ? [value] : value),
      z
        .array(z.string().min(1))
        .min(1)
        .max(MAX_PEER_FILES)
        .describe('File paths to send'),
    ),
    message: z.string().optional().describe('Optional message sent with files'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const fileResultSchema = z.object({
  path: z.string(),
  size: z.number().optional(),
  sha256: z.string().optional(),
  file_uuid: z.string().optional(),
  error: z.string().optional(),
})
const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    message: z.string(),
    msg_id: z.string().optional(),
    files: z.array(fileResultSchema),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type SendFileOutput = z.infer<OutputSchema>

export type PeerFileInspection = {
  path: string
  fileName: string
  size?: number
  error?: string
}

export function canSendRemotePeerFiles(
  provider: ReturnType<typeof getAPIProvider>,
  policyAllowed: boolean,
  essentialTrafficOnly: boolean,
): boolean {
  return provider === 'firstParty' && policyAllowed && !essentialTrafficOnly
}

export async function inspectPeerFiles(
  files: string[],
  cwd = getCwd(),
): Promise<PeerFileInspection[]> {
  return Promise.all(
    files.map(async file => {
      const path = resolve(cwd, file)
      try {
        await access(path, constants.R_OK)
        const info = await stat(path)
        if (!info.isFile()) {
          return {
            path,
            fileName: basename(path),
            error: 'Path is not a regular file',
          }
        }
        if (info.size > MAX_PEER_FILE_BYTES) {
          return {
            path,
            fileName: basename(path),
            size: info.size,
            error: 'File exceeds the 30 MB transfer limit',
          }
        }
        return { path, fileName: basename(path), size: info.size }
      } catch {
        return {
          path,
          fileName: basename(path),
          error: 'File does not exist or is not readable',
        }
      }
    }),
  )
}

function companionMessage(
  message: string | undefined,
  names: string[],
): string {
  return (
    message?.trim() ||
    `Sent you ${names.length} ${names.length === 1 ? 'file' : 'files'}: ${names.join(', ')}`
  )
}

export const SendFileTool = buildTool({
  name: SEND_FILE_TOOL_NAME,
  searchHint: 'send files to another Claude Code session',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  strict: true,

  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  userFacingName() {
    return SEND_FILE_TOOL_NAME
  },
  isEnabled() {
    if (feature('CROSS_SESSION_MESSAGING')) return true
    return false
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  getPath(input) {
    return resolve(getCwd(), input.files[0] ?? '')
  },
  async checkPermissions(input, context) {
    const permissionContext = context.getAppState().toolPermissionContext
    for (const file of input.files) {
      const decision = checkReadPermissionForTool(
        FileReadTool,
        { file_path: resolve(getCwd(), file) },
        permissionContext,
      )
      if (decision.behavior !== 'allow') return decision
    }
    if (hasIsolatePeerMachines()) {
      return {
        behavior: 'ask',
        message: `Send ${input.files.length} ${input.files.length === 1 ? 'file' : 'files'} to '${input.to}'? If the recipient is remote, file contents will cross machines.`,
        decisionReason: {
          type: 'safetyCheck',
          reason:
            'isolatePeerMachines is enabled - cross-session file transfer requires explicit approval',
          classifierApprovable: false,
        },
      }
    }
    return { behavior: 'allow', updatedInput: input }
  },
  async validateInput(input) {
    if (input.to.startsWith('uds:') && input.to.includes('#token=')) {
      return {
        result: false,
        message: 'Inline UDS authentication tokens are not accepted.',
        errorCode: 1,
      }
    }
    return { result: true }
  },
  toAutoClassifierInput(input) {
    return `to ${input.to}: ${input.files.join(', ')}${input.message ? ` - message: ${input.message}` : ''}`
  },
  renderToolUseMessage(input) {
    return `${input.files?.join(', ') ?? ''} -> ${input.to ?? '...'}`
  },
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    const failures = data.files.filter(file => file.error)
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: failures.length
        ? `${data.message}\n${failures.length} file(s) could not be sent:\n${failures.map(file => `  ${file.path}: ${file.error}`).join('\n')}`
        : data.message,
    }
  },
  async call(input: Input, context) {
    const inspected = await inspectPeerFiles(input.files)
    const outcomes: SendFileOutput['files'] = inspected.map(file => ({
      path: file.path,
      ...(file.size === undefined ? {} : { size: file.size }),
      ...(file.error ? { error: file.error } : {}),
    }))
    const valid = inspected
      .map((file, index) => ({ ...file, index }))
      .filter(file => !file.error)
    if (valid.length === 0) {
      return {
        data: {
          success: false,
          message: 'No files could be prepared for transfer.',
          files: outcomes,
        },
      }
    }

    const appState = context.getAppState()
    const fromMode =
      appState.toolPermissionContext.mode === 'bypassPermissions'
        ? 'bypass'
        : 'prompting'
    const senderName = getAgentName() || (isTeammate() ? 'teammate' : 'main')
    const signal = context.abortController.signal
    let deliveredCount = 0

    const result = await sendPeerMessage(
      { to: input.to, content: input.message ?? 'Sending files' },
      {
        discover: () =>
          discoverPeerRosterForTarget(context.getAppState(), input.to),
        send: async (target, outbound) => {
          if (
            target.transport === 'in-process' ||
            target.transport === 'mailbox'
          ) {
            throw new Error(
              'This agent is in the current session and already shares the filesystem; use SendMessage with an @path instead.',
            )
          }

          if (target.transport === 'uds') {
            const staged: Array<
              Awaited<ReturnType<typeof stageLocalPeerFile>>
            > = []
            for (let offset = 0; offset < valid.length; offset += 4) {
              await Promise.all(
                valid.slice(offset, offset + 4).map(async file => {
                  if (signal.aborted) throw new Error('aborted')
                  try {
                    const item = await stageLocalPeerFile(file.path)
                    staged.push(item)
                    outcomes[file.index] = {
                      path: file.path,
                      size: item.file_size,
                      sha256: item.sha256,
                    }
                  } catch (error) {
                    outcomes[file.index] = {
                      path: file.path,
                      error: errorMessage(error),
                    }
                  }
                }),
              )
            }
            if (staged.length === 0) throw new Error('No files could be staged')
            try {
              const delivery = await sendCrossSessionPeer(target, {
                content: companionMessage(
                  input.message,
                  staged.map(file => file.file_name),
                ),
                msgId: outbound.msgId,
                summary: outbound.summary,
                senderName,
                fromMode,
                sessionId: getSessionId(),
                udsAttachments: staged,
              })
              deliveredCount = staged.length
              return delivery
            } catch (error) {
              await Promise.all(
                staged.map(file => unlink(file.path).catch(() => undefined)),
              )
              throw error
            }
          }

          if (
            !canSendRemotePeerFiles(
              getAPIProvider(),
              isPolicyAllowed('allow_send_file'),
              isEssentialTrafficOnly(),
            )
          ) {
            throw new Error(
              'Cross-machine file transfer is disabled by the current provider or policy.',
            )
          }

          const { uploadBytesToBridgeStore } = await import(
            '../BriefTool/upload.js'
          )
          const attachments = [] as Array<{
            file_uuid: string
            file_name: string
            is_image: boolean
            file_size: number
            sha256: string
            media_type: string
          }>
          for (let offset = 0; offset < valid.length; offset += 4) {
            await Promise.all(
              valid.slice(offset, offset + 4).map(async file => {
                if (signal.aborted) throw new Error('aborted')
                const bytes = await readPeerFileBounded(file.path)
                if (!bytes) {
                  outcomes[file.index] = {
                    path: file.path,
                    error: 'Source became unreadable or exceeded 30 MB',
                  }
                  return
                }
                const sha256 = createHash('sha256').update(bytes).digest('hex')
                const fileUuid = await uploadBytesToBridgeStore(
                  bytes,
                  file.fileName,
                  { signal },
                )
                if (!fileUuid) {
                  outcomes[file.index] = {
                    path: file.path,
                    size: bytes.length,
                    sha256,
                    error: 'Upload failed',
                  }
                  return
                }
                const mediaType = peerFileMediaType(file.fileName)
                attachments.push({
                  file_uuid: fileUuid,
                  file_name: file.fileName,
                  is_image: mediaType.startsWith('image/'),
                  file_size: bytes.length,
                  sha256,
                  media_type: mediaType,
                })
                outcomes[file.index] = {
                  path: file.path,
                  size: bytes.length,
                  sha256,
                  file_uuid: fileUuid,
                }
              }),
            )
          }
          if (attachments.length === 0)
            throw new Error('No files could be uploaded')
          const delivery = await sendCrossSessionPeer(target, {
            content: companionMessage(
              input.message,
              attachments.map(file => file.file_name),
            ),
            msgId: outbound.msgId,
            summary: outbound.summary,
            senderName,
            fromMode,
            sessionId: getSessionId(),
            remoteAttachments: attachments,
          })
          deliveredCount = attachments.length
          return delivery
        },
      },
    )

    return {
      data: {
        success: result.success,
        message: result.success
          ? `${deliveredCount} ${deliveredCount === 1 ? 'file' : 'files'} -> ${result.target.name}`
          : result.message,
        msg_id: result.msg_id,
        files: outcomes,
      },
    }
  },
} satisfies ToolDef<InputSchema, SendFileOutput>)
