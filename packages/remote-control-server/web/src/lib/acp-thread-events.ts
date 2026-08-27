import type {
  ContentBlock,
  ImageContent,
  PermissionOptionKind,
  SessionUpdate,
} from '../acp/types'
import {
  type ThreadState,
  type ThreadStateAction,
  toRenderableContentBlock,
} from './thread-state'
import type { ToolCallStatus, UserMessageEntry } from './types'
import { assertSupportedImage } from './image-content'

function eventId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

export function acpUpdateToThreadActions(
  sessionId: string,
  update: SessionUpdate,
  assistantId = eventId('assistant'),
  userId = eventId('user'),
): ThreadStateAction[] {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const block = toRenderableContentBlock(update.content)
      return block
        ? [
            {
              type: 'assistant_content',
              sessionId,
              id: update.messageId ?? assistantId,
              block,
            },
          ]
        : []
    }
    case 'agent_thought_chunk':
      return update.content.type === 'text' && update.content.text
        ? [
            {
              type: 'assistant_thought',
              sessionId,
              id: update.messageId ?? assistantId,
              text: update.content.text,
            },
          ]
        : []
    case 'user_message_chunk': {
      const block = toRenderableContentBlock(update.content)
      return block
        ? [
            {
              type: 'user_content',
              sessionId,
              id: update.messageId ?? userId,
              block,
            },
          ]
        : []
    }
    case 'tool_call':
    case 'tool_call_update': {
      const toolCall: Extract<
        ThreadStateAction,
        { type: 'tool_upsert' }
      >['toolCall'] = {
        id: update.toolCallId,
      }
      if (update.title !== undefined) toolCall.title = update.title
      if (update.status !== undefined) toolCall.status = update.status
      if (update.content !== undefined) toolCall.content = update.content
      if (update.rawInput !== undefined) toolCall.rawInput = update.rawInput
      if (update.rawOutput !== undefined) toolCall.rawOutput = update.rawOutput
      return [{ type: 'tool_upsert', sessionId, toolCall }]
    }
    case 'plan':
      return update.entries.length > 0
        ? [
            {
              type: 'plan_replace',
              sessionId,
              id: eventId('plan'),
              entries: update.entries,
            },
          ]
        : [{ type: 'plan_remove', sessionId }]
    case 'available_commands_update':
      return []
  }
}

export function acpUpdateToThreadActionsForState(
  state: ThreadState,
  sessionId: string,
  update: SessionUpdate,
): ThreadStateAction[] {
  const isCurrentSession = state.sessionId === sessionId
  const isAssistantUpdate =
    update.sessionUpdate === 'agent_message_chunk' ||
    update.sessionUpdate === 'agent_thought_chunk'
  const assistantChanged =
    isAssistantUpdate &&
    update.messageId !== undefined &&
    update.messageId !== state.activeAssistantId
  const boundary =
    isCurrentSession &&
    state.activeAssistantId &&
    (update.sessionUpdate === 'user_message_chunk' || assistantChanged)
      ? ([{ type: 'turn_completed', sessionId }] satisfies ThreadStateAction[])
      : []
  const lastEntry = state.entries[state.entries.length - 1]
  const legacyUserId =
    isCurrentSession && lastEntry?.type === 'user_message'
      ? lastEntry.id
      : undefined
  return [
    ...boundary,
    ...acpUpdateToThreadActions(
      sessionId,
      update,
      isCurrentSession ? (state.activeAssistantId ?? undefined) : undefined,
      legacyUserId,
    ),
  ]
}

export function acpHistoryReplayCompletedActions(
  state: ThreadState,
  sessionId: string,
): ThreadStateAction[] {
  if (state.sessionId !== sessionId) return []
  return state.activeAssistantId
    ? [{ type: 'turn_completed', sessionId }]
    : [{ type: 'phase_changed', sessionId, phase: 'idle' }]
}

export function acpErrorToThreadActions(
  sessionId?: string,
): ThreadStateAction[] {
  return sessionId ? [{ type: 'turn_failed', sessionId }] : []
}

export function shouldHandleAcpError(
  currentSessionId: string | null,
  errorSessionId?: string,
): boolean {
  return errorSessionId === undefined || errorSessionId === currentSessionId
}

interface SubmitAcpPromptOptions {
  sessionId: string
  userId?: string
  content: ContentBlock[]
  prepareImage: (image: ImageContent) => Promise<ImageContent>
  sendPrompt: (content: ContentBlock[]) => Promise<void>
  dispatch: (action: ThreadStateAction) => void
}

export type SubmitAcpPromptResult =
  | { status: 'sent' }
  | { status: 'prepare_failed' | 'send_failed'; error: unknown }

function userEntry(
  id: string,
  content: ContentBlock[],
  deliveryState: UserMessageEntry['deliveryState'],
): UserMessageEntry {
  return {
    type: 'user_message',
    id,
    content: content.flatMap(block => {
      const renderable = toRenderableContentBlock(block)
      return renderable ? [renderable] : []
    }),
    deliveryState,
  }
}

function isImageContent(block: ContentBlock): block is ImageContent {
  return (
    block.type === 'image' &&
    'mimeType' in block &&
    typeof block.mimeType === 'string' &&
    'data' in block &&
    typeof block.data === 'string'
  )
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function acpPromptFailureMessage(
  result: SubmitAcpPromptResult,
): string | null {
  switch (result.status) {
    case 'sent':
      return null
    case 'prepare_failed':
      return `Could not prepare image: ${errorText(result.error)}`
    case 'send_failed':
      return `Could not send message: ${errorText(result.error)}`
  }
}

export async function submitAcpPrompt({
  sessionId,
  userId = eventId('user'),
  content,
  prepareImage,
  sendPrompt,
  dispatch,
}: SubmitAcpPromptOptions): Promise<SubmitAcpPromptResult> {
  dispatch({ type: 'turn_started', sessionId })

  let prepared: ContentBlock[]
  try {
    for (const block of content) {
      if (isImageContent(block)) assertSupportedImage(block)
    }
    prepared = await Promise.all(
      content.map(block =>
        isImageContent(block) ? prepareImage(block) : block,
      ),
    )
    for (const block of prepared) {
      if (isImageContent(block)) assertSupportedImage(block)
    }
  } catch (error) {
    dispatch({
      type: 'user_message_added',
      sessionId,
      entry: userEntry(userId, content, 'failed'),
    })
    dispatch({ type: 'turn_failed', sessionId })
    return { status: 'prepare_failed', error }
  }

  dispatch({
    type: 'user_message_added',
    sessionId,
    entry: userEntry(userId, prepared, 'sending'),
  })
  try {
    await sendPrompt(prepared)
    dispatch({
      type: 'user_message_delivery',
      sessionId,
      id: userId,
      deliveryState: 'sent',
    })
    return { status: 'sent' }
  } catch (error) {
    dispatch({
      type: 'user_message_delivery',
      sessionId,
      id: userId,
      deliveryState: 'failed',
    })
    dispatch({ type: 'turn_failed', sessionId })
    return { status: 'send_failed', error }
  }
}

export function permissionResponseToolStatus(
  optionId: string | null,
  optionKind: PermissionOptionKind | null,
  isStandalone: boolean,
): ToolCallStatus {
  if (
    optionId === null ||
    optionKind === 'reject_once' ||
    optionKind === 'reject_always'
  ) {
    return 'rejected'
  }
  return isStandalone ? 'completed' : 'in_progress'
}
