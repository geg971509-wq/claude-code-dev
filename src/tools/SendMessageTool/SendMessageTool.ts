import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { getSessionId, isReplBridgeActive } from 'src/bootstrap/state.js'
import { getReplBridgeHandle } from 'src/bridge/replBridgeHandle.js'
import type { Tool, ToolUseContext } from 'src/Tool.js'
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { findTeammateTaskByAgentId } from 'src/tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import {
  isLocalAgentTask,
  queuePendingMessage,
} from 'src/tasks/LocalAgentTask/LocalAgentTask.js'
import { isMainSessionTask } from 'src/tasks/LocalMainSessionTask.js'
import { toAgentId } from '@claude-code-best/core-utils/ids'
import { generateRequestId } from 'src/utils/agentId.js'
import { isAgentSwarmsEnabled } from 'src/utils/agentSwarmsEnabled.js'
import { logForDebugging } from 'src/utils/debug.js'
import { errorMessage } from 'src/utils/errors.js'
import { truncate } from 'src/utils/format.js'
import { gracefulShutdown } from 'src/utils/gracefulShutdown.js'
import { lazySchema } from '@claude-code-best/core-utils/lazySchema'
import { enqueue } from 'src/utils/messageQueueManager.js'
import { parseAddress } from 'src/utils/peerAddress.js'
import { discoverPeerRosterForTarget } from 'src/utils/peerDiscovery.js'
import { buildPeerMessageEnvelope } from 'src/utils/peerMessageEnvelope.js'
import {
  peerTargetRequiresIsolation,
  sendPeerMessage,
  type PeerOutboundMessage,
  type PeerSendResult,
} from 'src/utils/peerMessaging.js'
import {
  normalizePeerName,
  type PeerCandidate,
} from 'src/utils/peerRegistry.js'
import { sendCrossSessionPeer } from 'src/utils/peerTransport.js'
import { hasIsolatePeerMachines } from 'src/utils/settings/settings.js'
import { semanticBoolean } from '@claude-code-best/core-utils/semanticBoolean'
import { jsonStringify } from 'src/utils/slowOperations.js'
import type { BackendType } from 'src/utils/swarm/backends/types.js'
import { TEAM_LEAD_NAME } from 'src/utils/swarm/constants.js'
import { readTeamFileAsync } from 'src/utils/swarm/teamHelpers.js'
import {
  getAgentId,
  getAgentName,
  getTeammateColor,
  getTeamName,
  isTeamLead,
  isTeammate,
} from 'src/utils/teammate.js'
import {
  createShutdownApprovedMessage,
  createShutdownRejectedMessage,
  createShutdownRequestMessage,
  writeToMailbox,
} from 'src/utils/teammateMailbox.js'
import { resumeAgentBackground } from '../AgentTool/resumeAgent.js'
import { SEND_MESSAGE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const StructuredMessage = lazySchema(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('shutdown_request'),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal('shutdown_response'),
      request_id: z.string(),
      approve: semanticBoolean(),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal('plan_approval_response'),
      request_id: z.string(),
      approve: semanticBoolean(),
      feedback: z.string().optional(),
    }),
  ]),
)

const inputSchema = lazySchema(() =>
  z.object({
    to: z
      .string()
      .describe(
        'Recipient: teammate name, or "*" for broadcast to all teammates',
      ),
    summary: z
      .string()
      .optional()
      .describe(
        'Optional short preview; defaults to the first non-empty message line',
      ),
    message: z.union([
      z.string().describe('Plain text message content'),
      StructuredMessage(),
    ]),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export type Input = z.infer<InputSchema>

export type MessageRouting = {
  sender: string
  senderColor?: string
  target: string
  targetColor?: string
  summary?: string
  content?: string
}

export type MessageOutput = {
  success: boolean
  message: string
  routing?: MessageRouting
}

export type BroadcastOutput = {
  success: boolean
  message: string
  recipients: string[]
  routing?: MessageRouting
}

export type RequestOutput = {
  success: boolean
  message: string
  request_id: string
  target: string
}

export type ResponseOutput = {
  success: boolean
  message: string
  request_id?: string
}

export type SendMessageToolOutput =
  | PeerSendResult
  | MessageOutput
  | BroadcastOutput
  | RequestOutput
  | ResponseOutput

const UDS_INLINE_TOKEN_MARKER = '#token='

function isCrossSessionMessagingEnabled(): boolean {
  if (feature('CROSS_SESSION_MESSAGING')) return true
  return false
}

function verifyAndPinPeerTarget(
  to: string,
  target: PeerCandidate,
  context: ToolUseContext,
): string | undefined {
  if (
    parseAddress(to).scheme !== 'other' ||
    /\s+\[[a-z0-9_-]{3,64}\]$/i.test(to.trim()) ||
    (target.transport === 'in-process' && to === target.id)
  ) {
    return undefined
  }
  const key = normalizePeerName(to)
  const identity = `${target.kind}:${target.transport}:${target.sessionId ?? target.id}`
  let error: string | undefined
  context.setAppState(previous => {
    const pins = previous.sendMessagePins ?? new Map<string, string>()
    const pinned = pins.get(key)
    if (pinned && pinned !== identity) {
      error = `Agent "${to}" now resolves to a different session; use ListAgents and the exact "name [ref]" address.`
      return previous
    }
    if (pinned === identity) return previous
    const next = new Map(pins)
    next.set(key, identity)
    return { ...previous, sendMessagePins: next }
  })
  return error
}

function stripInlineUdsToken(target: string): string {
  const markerIndex = target.indexOf(UDS_INLINE_TOKEN_MARKER)
  return markerIndex === -1 ? target : target.slice(0, markerIndex)
}

function hasInlineUdsToken(to: string): boolean {
  const addr = parseAddress(to)
  // Empty-token markers are still inline-token attempts. Observable input
  // redaction preserves "#token=" so cloned inputs remain rejected.
  return addr.scheme === 'uds' && addr.target.includes(UDS_INLINE_TOKEN_MARKER)
}

function recipientForDisplay(to: string): string {
  const addr = parseAddress(to)
  if (addr.scheme !== 'uds') return to
  return `uds:${stripInlineUdsToken(addr.target)}`
}

function redactInlineUdsTokenForRejection(to: string): string {
  const addr = parseAddress(to)
  if (addr.scheme !== 'uds') return to
  const markerIndex = addr.target.indexOf(UDS_INLINE_TOKEN_MARKER)
  if (markerIndex === -1) return to
  return `uds:${addr.target.slice(0, markerIndex)}${UDS_INLINE_TOKEN_MARKER}`
}

function redactObservableInlineUdsToken(input: { to: string }): void {
  if (!hasInlineUdsToken(input.to)) return
  input.to = redactInlineUdsTokenForRejection(input.to)
}

async function dispatchPeerMessage(
  target: PeerCandidate,
  message: PeerOutboundMessage,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
  invokingRequestId?: string,
): Promise<{ status: 'delivered' | 'queued' | 'held' }> {
  const appState = context.getAppState()
  if (target.kind === 'main') {
    const senderName = getAgentName() || context.agentId || 'subagent'
    if (isTeammate()) {
      await writeToMailbox(
        TEAM_LEAD_NAME,
        {
          from: senderName,
          text: message.content,
          summary: message.summary,
          timestamp: new Date().toISOString(),
          color: getTeammateColor(),
        },
        getTeamName(appState.teamContext),
      )
    } else {
      enqueue({
        mode: 'prompt',
        value: buildPeerMessageEnvelope(message.content, {
          from: `in-process:${context.agentId ?? senderName}`,
          name: senderName,
          msgId: message.msgId,
        }),
        priority: 'next',
        skipSlashCommands: true,
        isMeta: true,
        origin: {
          kind: 'peer',
          from: senderName,
          senderTaskId: context.agentId,
        },
      })
    }
    return { status: 'queued' }
  }

  if (target.transport === 'in-process') {
    const agentId = toAgentId(target.id)
    if (!agentId) throw new Error(`Invalid in-process agent ID: ${target.id}`)
    const task = appState.tasks[agentId]
    if (
      isLocalAgentTask(task) &&
      !isMainSessionTask(task) &&
      task.status === 'running'
    ) {
      queuePendingMessage(
        agentId,
        message.content,
        context.setAppStateForTasks ?? context.setAppState,
      )
      return { status: 'queued' }
    }

    await resumeAgentBackground({
      agentId,
      prompt: message.content,
      toolUseContext: context,
      canUseTool,
      invokingRequestId,
    })
    return { status: 'queued' }
  }

  if (target.transport === 'mailbox') {
    await writeToMailbox(
      target.name,
      {
        from: getAgentName() || (isTeammate() ? 'teammate' : TEAM_LEAD_NAME),
        text: message.content,
        summary: message.summary,
        timestamp: new Date().toISOString(),
        color: getTeammateColor(),
      },
      getTeamName(appState.teamContext),
    )
    return { status: 'queued' }
  }

  if (
    target.transport === 'uds' ||
    target.transport === 'cloud' ||
    target.transport === 'bridge'
  ) {
    return sendCrossSessionPeer(target, {
      ...message,
      sessionId: getSessionId(),
      fromMode:
        appState.toolPermissionContext.mode === 'bypassPermissions'
          ? 'bypass'
          : 'prompting',
      senderName:
        getAgentName() || (isTeammate() ? 'teammate' : TEAM_LEAD_NAME),
    })
  }

  throw new Error(`Unsupported peer transport: ${target.transport}`)
}

async function handleMessage(
  input: { to: string; message: string; summary?: string },
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
  invokingRequestId?: string,
): Promise<{ data: PeerSendResult }> {
  return {
    data: await sendPeerMessage(
      { to: input.to, content: input.message, summary: input.summary },
      {
        discover: () =>
          discoverPeerRosterForTarget(
            context.getAppState(),
            input.to,
            undefined,
            {
              includeMain: context.agentId !== undefined,
              includeRemote: isCrossSessionMessagingEnabled(),
            },
          ),
        send: (target, message) =>
          dispatchPeerMessage(
            target,
            message,
            context,
            canUseTool,
            invokingRequestId,
          ),
        verifyTarget: (to, target) =>
          verifyAndPinPeerTarget(to, target, context),
      },
    ),
  }
}

async function handleBroadcast(
  content: string,
  summary: string | undefined,
  context: ToolUseContext,
): Promise<{ data: BroadcastOutput }> {
  const appState = context.getAppState()
  const teamName = getTeamName(appState.teamContext)

  if (!teamName) {
    throw new Error(
      'Not in a team context. Create a team with Teammate spawnTeam first, or set CLAUDE_CODE_TEAM_NAME.',
    )
  }

  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) {
    throw new Error(`Team "${teamName}" does not exist`)
  }

  const senderName =
    getAgentName() || (isTeammate() ? 'teammate' : TEAM_LEAD_NAME)
  if (!senderName) {
    throw new Error(
      'Cannot broadcast: sender name is required. Set CLAUDE_CODE_AGENT_NAME.',
    )
  }

  const senderColor = getTeammateColor()

  const recipients: string[] = []
  for (const member of teamFile.members) {
    if (member.name.toLowerCase() === senderName.toLowerCase()) {
      continue
    }
    recipients.push(member.name)
  }

  if (recipients.length === 0) {
    return {
      data: {
        success: true,
        message: 'No teammates to broadcast to (you are the only team member)',
        recipients: [],
      },
    }
  }

  for (const recipientName of recipients) {
    await writeToMailbox(
      recipientName,
      {
        from: senderName,
        text: content,
        summary,
        timestamp: new Date().toISOString(),
        color: senderColor,
      },
      teamName,
    )
  }

  return {
    data: {
      success: true,
      message: `Message broadcast to ${recipients.length} teammate(s): ${recipients.join(', ')}`,
      recipients,
      routing: {
        sender: senderName,
        senderColor,
        target: '@team',
        summary,
        content,
      },
    },
  }
}

async function handleShutdownRequest(
  targetName: string,
  reason: string | undefined,
  context: ToolUseContext,
): Promise<{ data: RequestOutput }> {
  const appState = context.getAppState()
  const teamName = getTeamName(appState.teamContext)
  const senderName = getAgentName() || TEAM_LEAD_NAME
  const requestId = generateRequestId('shutdown', targetName)

  const shutdownMessage = createShutdownRequestMessage({
    requestId,
    from: senderName,
    reason,
  })

  await writeToMailbox(
    targetName,
    {
      from: senderName,
      text: jsonStringify(shutdownMessage),
      timestamp: new Date().toISOString(),
      color: getTeammateColor(),
    },
    teamName,
  )

  return {
    data: {
      success: true,
      message: `Shutdown request sent to ${targetName}. Request ID: ${requestId}`,
      request_id: requestId,
      target: targetName,
    },
  }
}

async function handleShutdownApproval(
  requestId: string,
  context: ToolUseContext,
): Promise<{ data: ResponseOutput }> {
  const teamName = getTeamName()
  const agentId = getAgentId()
  const agentName = getAgentName() || 'teammate'

  logForDebugging(
    `[SendMessageTool] handleShutdownApproval: teamName=${teamName}, agentId=${agentId}, agentName=${agentName}`,
  )

  let ownPaneId: string | undefined
  let ownBackendType: BackendType | undefined
  if (teamName) {
    const teamFile = await readTeamFileAsync(teamName)
    if (teamFile && agentId) {
      const selfMember = teamFile.members.find(m => m.agentId === agentId)
      if (selfMember) {
        ownPaneId = selfMember.tmuxPaneId
        ownBackendType = selfMember.backendType
      }
    }
  }

  const approvedMessage = createShutdownApprovedMessage({
    requestId,
    from: agentName,
    paneId: ownPaneId,
    backendType: ownBackendType,
  })

  await writeToMailbox(
    TEAM_LEAD_NAME,
    {
      from: agentName,
      text: jsonStringify(approvedMessage),
      timestamp: new Date().toISOString(),
      color: getTeammateColor(),
    },
    teamName,
  )

  if (ownBackendType === 'in-process') {
    logForDebugging(
      `[SendMessageTool] In-process teammate ${agentName} approving shutdown - signaling abort`,
    )

    if (agentId) {
      const appState = context.getAppState()
      const task = findTeammateTaskByAgentId(agentId, appState.tasks)
      if (task?.abortController) {
        task.abortController.abort()
        logForDebugging(
          `[SendMessageTool] Aborted controller for in-process teammate ${agentName}`,
        )
      } else {
        logForDebugging(
          `[SendMessageTool] Warning: Could not find task/abortController for ${agentName}`,
        )
      }
    }
  } else {
    if (agentId) {
      const appState = context.getAppState()
      const task = findTeammateTaskByAgentId(agentId, appState.tasks)
      if (task?.abortController) {
        logForDebugging(
          `[SendMessageTool] Fallback: Found in-process task for ${agentName} via AppState, aborting`,
        )
        task.abortController.abort()

        return {
          data: {
            success: true,
            message: `Shutdown approved (fallback path). Agent ${agentName} is now exiting.`,
            request_id: requestId,
          },
        }
      }
    }

    setImmediate(async () => {
      await gracefulShutdown(0, 'other')
    })
  }

  return {
    data: {
      success: true,
      message: `Shutdown approved. Sent confirmation to team-lead. Agent ${agentName} is now exiting.`,
      request_id: requestId,
    },
  }
}

async function handleShutdownRejection(
  requestId: string,
  reason: string,
): Promise<{ data: ResponseOutput }> {
  const teamName = getTeamName()
  const agentName = getAgentName() || 'teammate'

  const rejectedMessage = createShutdownRejectedMessage({
    requestId,
    from: agentName,
    reason,
  })

  await writeToMailbox(
    TEAM_LEAD_NAME,
    {
      from: agentName,
      text: jsonStringify(rejectedMessage),
      timestamp: new Date().toISOString(),
      color: getTeammateColor(),
    },
    teamName,
  )

  return {
    data: {
      success: true,
      message: `Shutdown rejected. Reason: "${reason}". Continuing to work.`,
      request_id: requestId,
    },
  }
}

async function handlePlanApproval(
  recipientName: string,
  requestId: string,
  context: ToolUseContext,
): Promise<{ data: ResponseOutput }> {
  const appState = context.getAppState()
  const teamName = appState.teamContext?.teamName

  if (!isTeamLead(appState.teamContext)) {
    throw new Error(
      'Only the team lead can approve plans. Teammates cannot approve their own or other plans.',
    )
  }

  const leaderMode = appState.toolPermissionContext.mode
  const modeToInherit = leaderMode === 'plan' ? 'default' : leaderMode

  const approvalResponse = {
    type: 'plan_approval_response',
    requestId,
    approved: true,
    timestamp: new Date().toISOString(),
    permissionMode: modeToInherit,
  }

  await writeToMailbox(
    recipientName,
    {
      from: TEAM_LEAD_NAME,
      text: jsonStringify(approvalResponse),
      timestamp: new Date().toISOString(),
    },
    teamName,
  )

  return {
    data: {
      success: true,
      message: `Plan approved for ${recipientName}. They will receive the approval and can proceed with implementation.`,
      request_id: requestId,
    },
  }
}

async function handlePlanRejection(
  recipientName: string,
  requestId: string,
  feedback: string,
  context: ToolUseContext,
): Promise<{ data: ResponseOutput }> {
  const appState = context.getAppState()
  const teamName = appState.teamContext?.teamName

  if (!isTeamLead(appState.teamContext)) {
    throw new Error(
      'Only the team lead can reject plans. Teammates cannot reject their own or other plans.',
    )
  }

  const rejectionResponse = {
    type: 'plan_approval_response',
    requestId,
    approved: false,
    feedback,
    timestamp: new Date().toISOString(),
  }

  await writeToMailbox(
    recipientName,
    {
      from: TEAM_LEAD_NAME,
      text: jsonStringify(rejectionResponse),
      timestamp: new Date().toISOString(),
    },
    teamName,
  )

  return {
    data: {
      success: true,
      message: `Plan rejected for ${recipientName} with feedback: "${feedback}"`,
      request_id: requestId,
    },
  }
}

export const SendMessageTool: Tool<InputSchema, SendMessageToolOutput> =
  buildTool({
    name: SEND_MESSAGE_TOOL_NAME,
    searchHint:
      'send message to teammate agent, broadcast, inter-agent communication, swarm messaging, agent coordination',
    maxResultSizeChars: 100_000,

    userFacingName() {
      return 'SendMessage'
    },

    get inputSchema(): InputSchema {
      return inputSchema()
    },
    shouldDefer: true,
    alwaysLoad: isAgentSwarmsEnabled(),

    isEnabled() {
      return true
    },

    isReadOnly(input) {
      return typeof input.message === 'string'
    },

    backfillObservableInput(input) {
      if (typeof input.to !== 'string') return

      redactObservableInlineUdsToken(input as { to: string })
      if ('type' in input) return

      if (input.to === '*') {
        input.type = 'broadcast'
        if (typeof input.message === 'string') input.content = input.message
      } else if (typeof input.message === 'string') {
        input.type = 'message'
        input.recipient = recipientForDisplay(input.to)
        input.content = input.message
      } else if (typeof input.message === 'object' && input.message !== null) {
        const msg = input.message as {
          type?: string
          request_id?: string
          approve?: boolean
          reason?: string
          feedback?: string
        }
        input.type = msg.type
        input.recipient = recipientForDisplay(input.to)
        if (msg.request_id !== undefined) input.request_id = msg.request_id
        if (msg.approve !== undefined) input.approve = msg.approve
        const content = msg.reason ?? msg.feedback
        if (content !== undefined) input.content = content
      }
    },

    toAutoClassifierInput(input) {
      const recipient = recipientForDisplay(input.to)
      if (typeof input.message === 'string') {
        return `to ${recipient}: ${input.message}`
      }
      switch (input.message.type) {
        case 'shutdown_request':
          return `shutdown_request to ${recipient}`
        case 'shutdown_response':
          return `shutdown_response ${input.message.approve ? 'approve' : 'reject'} ${input.message.request_id}`
        case 'plan_approval_response':
          return `plan_approval ${input.message.approve ? 'approve' : 'reject'} to ${recipient}`
      }
    },

    async checkPermissions(input, context) {
      if (hasIsolatePeerMachines() && typeof input.message === 'string') {
        const address = parseAddress(input.to)
        const roster =
          address.scheme === 'other'
            ? await discoverPeerRosterForTarget(
                context.getAppState(),
                input.to,
                undefined,
                {
                  includeMain: context.agentId !== undefined,
                  includeRemote: isCrossSessionMessagingEnabled(),
                },
              )
            : undefined
        if (peerTargetRequiresIsolation(input.to, roster)) {
          return {
            behavior: 'ask' as const,
            message: `Send a message to '${input.to}' on another machine? It will be marked as coming from another Claude Code session.`,
            decisionReason: {
              type: 'safetyCheck' as const,
              reason:
                'isolatePeerMachines is enabled - cross-machine messages require explicit approval',
              classifierApprovable: false,
            },
          }
        }
      }
      return { behavior: 'allow' as const, updatedInput: input }
    },

    async validateInput(input, _context) {
      if (input.to.trim().length === 0) {
        return {
          result: false,
          message: 'to must not be empty',
          errorCode: 9,
        }
      }
      const addr = parseAddress(input.to)
      if (
        (addr.scheme === 'bridge' ||
          addr.scheme === 'cloud' ||
          addr.scheme === 'uds' ||
          addr.scheme === 'tcp') &&
        addr.target.trim().length === 0
      ) {
        return {
          result: false,
          message: 'address target must not be empty',
          errorCode: 9,
        }
      }
      if (addr.scheme === 'uds' && hasInlineUdsToken(input.to)) {
        return {
          result: false,
          message:
            'uds addresses must not include inline auth tokens; use the ListPeers address',
          errorCode: 9,
        }
      }
      if (input.to.includes('@')) {
        return {
          result: false,
          message:
            'to must be a bare teammate name or "*" — there is only one team per session',
          errorCode: 9,
        }
      }
      if (typeof input.message === 'string') {
        return { result: true }
      }

      if (input.to === '*') {
        return {
          result: false,
          message: 'structured messages cannot be broadcast (to: "*")',
          errorCode: 9,
        }
      }

      if (
        input.message.type === 'shutdown_response' &&
        input.to !== TEAM_LEAD_NAME
      ) {
        return {
          result: false,
          message: `shutdown_response must be sent to "${TEAM_LEAD_NAME}"`,
          errorCode: 9,
        }
      }

      if (
        input.message.type === 'shutdown_response' &&
        !input.message.approve &&
        (!input.message.reason || input.message.reason.trim().length === 0)
      ) {
        return {
          result: false,
          message: 'reason is required when rejecting a shutdown request',
          errorCode: 9,
        }
      }

      return { result: true }
    },

    async description() {
      return DESCRIPTION
    },

    async prompt() {
      return getPrompt()
    },

    mapToolResultToToolResultBlockParam(data, toolUseID) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: [
          {
            type: 'text' as const,
            text: jsonStringify(data),
          },
        ],
      }
    },

    async call(input, context, canUseTool, assistantMessage) {
      if (typeof input.message === 'string') {
        const addr = parseAddress(input.to)
        if (
          !isCrossSessionMessagingEnabled() &&
          (addr.scheme === 'uds' ||
            addr.scheme === 'bridge' ||
            addr.scheme === 'cloud')
        ) {
          return {
            data: {
              success: false,
              message: 'Cross-session messaging is disabled in this build.',
              error_code: 'unsupported_transport' as const,
            },
          }
        }
        if (addr.scheme === 'uds' && hasInlineUdsToken(input.to)) {
          return {
            data: {
              success: false,
              message:
                'uds addresses must not include inline auth tokens; use the ListPeers address',
            },
          }
        }
      }

      if (typeof input.message === 'string') {
        if (input.to === '*') {
          return handleBroadcast(input.message, input.summary, context)
        }
        return handleMessage(
          { to: input.to, message: input.message, summary: input.summary },
          context,
          canUseTool,
          assistantMessage?.requestId as string | undefined,
        )
      }

      if (input.to === '*') {
        throw new Error('structured messages cannot be broadcast')
      }

      switch (input.message.type) {
        case 'shutdown_request':
          return handleShutdownRequest(input.to, input.message.reason, context)
        case 'shutdown_response':
          if (input.message.approve) {
            return handleShutdownApproval(input.message.request_id, context)
          }
          return handleShutdownRejection(
            input.message.request_id,
            input.message.reason!,
          )
        case 'plan_approval_response':
          if (input.message.approve) {
            return handlePlanApproval(
              input.to,
              input.message.request_id,
              context,
            )
          }
          return handlePlanRejection(
            input.to,
            input.message.request_id,
            input.message.feedback ?? 'Plan needs revision',
            context,
          )
      }
    },

    renderToolUseMessage,
    renderToolResultMessage,
  } satisfies ToolDef<InputSchema, SendMessageToolOutput>)
