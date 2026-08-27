import {
  apiBind,
  apiFetchSessionHistory,
  apiInterrupt,
  apiSendControl,
  apiSendEvent,
  getUuid,
} from '../api/client'
import type { SessionEvent } from '../types'
import {
  cancelThreadActions,
  type ThreadState,
  type ThreadStateAction,
  toRenderableContentBlock,
} from './thread-state'
import type {
  AssistantChunk,
  AssistantMessageEntry,
  PendingPermission,
  RenderableContentBlock,
  ToolCallData,
  UserMessageImage,
} from './types'
import { generateMessageUuid } from './utils'
import { assertSupportedImage } from './image-content'

type Dispatch = (action: ThreadStateAction) => void
type GetState = () => ThreadState
type ObjectValue = Record<string, unknown>

type StreamBlock = {
  type: string
  toolId?: string
  toolName?: string
  inputJson: string
}

type SSEEventHandler = (event: SessionEvent) => void
type SSEConnection = { ready: Promise<void>; disconnect: () => void }

const SSE_OPEN_TIMEOUT_MS = 10_000

class SSEBus {
  private listeners = new Set<SSEEventHandler>()
  private eventSource: EventSource | null = null
  private disconnectCurrent: (() => void) | null = null

  onEvent(handler: SSEEventHandler): () => void {
    this.listeners.add(handler)
    return () => this.listeners.delete(handler)
  }

  connect(sessionId: string): SSEConnection {
    this.disconnect()
    const uuid = getUuid()
    const url = `/web/sessions/${sessionId}/events?uuid=${encodeURIComponent(uuid)}`
    const eventSource = new EventSource(url)
    this.eventSource = eventSource
    let settled = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let resolveReady: () => void = () => {}
    let rejectReady: (error: Error) => void = () => {}
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const clearOpenTimeout = () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
      timeoutId = undefined
    }
    const disconnect = () => {
      eventSource.close()
      if (this.eventSource === eventSource) {
        this.eventSource = null
        this.disconnectCurrent = null
      }
      clearOpenTimeout()
      if (!settled) {
        settled = true
        rejectReady(new Error('SSE connection closed before opening'))
      }
    }
    this.disconnectCurrent = disconnect
    eventSource.addEventListener('open', () => {
      if (this.eventSource !== eventSource) return
      if (settled) return
      settled = true
      clearOpenTimeout()
      resolveReady()
    })
    eventSource.addEventListener('error', () => {
      if (this.eventSource !== eventSource) return
      if (settled) return
      settled = true
      clearOpenTimeout()
      eventSource.close()
      if (this.eventSource === eventSource) {
        this.eventSource = null
        this.disconnectCurrent = null
      }
      rejectReady(new Error('SSE connection failed before opening'))
    })
    eventSource.addEventListener('message', (event: MessageEvent) => {
      if (this.eventSource !== eventSource) return
      let data: SessionEvent
      try {
        data = JSON.parse(event.data) as SessionEvent
      } catch {
        // Ignore malformed SSE frames; the next frame remains usable.
        return
      }
      for (const handler of this.listeners) handler(data)
    })
    timeoutId = setTimeout(() => {
      if (settled) return
      settled = true
      eventSource.close()
      if (this.eventSource === eventSource) {
        this.eventSource = null
        this.disconnectCurrent = null
      }
      rejectReady(new Error('SSE connection timed out before opening'))
    }, SSE_OPEN_TIMEOUT_MS)
    if (settled) clearOpenTimeout()
    return { ready, disconnect }
  }

  disconnect(): void {
    this.disconnectCurrent?.()
    this.disconnectCurrent = null
  }
}

export const sseBus = new SSEBus()

function objectValue(value: unknown): ObjectValue | null {
  return value !== null && typeof value === 'object'
    ? (value as ObjectValue)
    : null
}

function payloadOf(event: SessionEvent): ObjectValue {
  return objectValue(event.payload) ?? {}
}

function rawPayload(payload: ObjectValue): ObjectValue {
  return objectValue(payload.raw) ?? {}
}

function messageOf(payload: ObjectValue): ObjectValue | null {
  return (
    objectValue(payload.message) ?? objectValue(rawPayload(payload).message)
  )
}

function stringField(
  value: ObjectValue,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key])
      return value[key] as string
  }
  return undefined
}

function eventUuid(event: SessionEvent, payload: ObjectValue): string {
  return (
    stringField(payload, 'uuid') ??
    stringField(rawPayload(payload), 'uuid') ??
    event.id ??
    generateMessageUuid()
  )
}

function renderableBlock(block: unknown): RenderableContentBlock | null {
  const direct = toRenderableContentBlock(block)
  if (direct) return direct
  const candidate = objectValue(block)
  const source = objectValue(candidate?.source)
  if (
    (candidate?.type === 'image' || candidate?.type === 'audio') &&
    source?.type === 'base64' &&
    typeof source.media_type === 'string' &&
    typeof source.data === 'string'
  ) {
    return toRenderableContentBlock({
      type: candidate.type,
      mimeType: source.media_type,
      data: source.data,
      annotations: candidate.annotations,
      _meta: candidate._meta,
    })
  }
  return null
}

function messageBlocks(payload: ObjectValue): unknown[] {
  const message = messageOf(payload)
  const content = message?.content ?? payload.content
  if (Array.isArray(content)) return content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return content === undefined || content === null ? [] : [content]
}

function toolOutput(block: ObjectValue): unknown {
  return block.content ?? block.output ?? ''
}

function isToolTerminal(status: ToolCallData['status']): boolean {
  return ['completed', 'rejected', 'error', 'cancelled'].includes(status)
}

function terminalIsCancellation(payload: ObjectValue): boolean {
  return [payload.subtype, payload.status].some(
    value => typeof value === 'string' && /cancel|interrupt/i.test(value),
  )
}

export class RCSChatAdapter {
  private unsub: (() => void) | null = null
  private disconnectSSE: (() => void) | null = null
  private currentAssistantId: string | null = null
  private streamBlocks = new Map<number, StreamBlock>()
  private generation = 0
  private initializing = false
  private bufferedEvents: SessionEvent[] = []

  constructor(
    private readonly sessionId: string,
    private readonly dispatch: Dispatch,
    private readonly getState: GetState,
    private readonly options?: {
      onStatusChange?: (status: string) => void
      onError?: (error: string) => void
      onPermissionRequest?: (permission: PendingPermission) => void
      onPermissionCancelled?: (requestId: string) => void
    },
  ) {}

  async init(): Promise<void> {
    const generation = ++this.generation
    this.closeConnection()
    this.initializing = true
    this.bufferedEvents = []
    try {
      await Promise.all([
        this.connectSSE(generation),
        this.bindForInitialization(),
      ])
    } catch (error) {
      if (generation !== this.generation) return
      this.failInitialization()
      throw error
    }
    if (generation !== this.generation) return
    try {
      const { events } = await apiFetchSessionHistory(this.sessionId)
      if (generation !== this.generation) return
      const replay = this.mergeEvents(events ?? [], this.bufferedEvents)
      this.bufferedEvents = []
      this.replayEvents(replay)
      this.initializing = false
    } catch (error) {
      if (generation !== this.generation) return
      this.failInitialization()
      throw error
    }
  }

  async loadHistory(): Promise<void> {
    const generation = this.generation
    const { events } = await apiFetchSessionHistory(this.sessionId)
    if (generation !== this.generation) return
    this.replayEvents(events ?? [])
  }

  private async bindForInitialization(): Promise<void> {
    try {
      await apiBind(this.sessionId)
    } catch (error) {
      if (
        error instanceof Error &&
        /already bound to (?:this client|this uuid)/i.test(error.message)
      ) {
        return
      }
      throw error
    }
  }

  private failInitialization(): void {
    this.initializing = false
    this.bufferedEvents = []
    this.disconnect()
  }

  private mergeEvents(
    history: SessionEvent[],
    live: SessionEvent[],
  ): SessionEvent[] {
    const seen = new Set<string>()
    return [...history, ...live]
      .filter((event, index) => {
        const key =
          event.seqNum !== undefined
            ? `seq:${event.seqNum}`
            : event.id
              ? `id:${event.id}`
              : `anonymous:${index}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .sort((left, right) => {
        if (left.seqNum === undefined || right.seqNum === undefined) return 0
        return left.seqNum - right.seqNum
      })
  }

  private replayEvents(events: SessionEvent[]): void {
    this.currentAssistantId = null
    this.streamBlocks.clear()
    this.dispatch({ type: 'reset', sessionId: this.sessionId })
    const resolvedPermissions = new Set(
      events.flatMap(event => {
        if (
          event.type !== 'control_response' &&
          event.type !== 'permission_response' &&
          event.type !== 'control_cancel_request'
        ) {
          return []
        }
        const payload = payloadOf(event)
        const response =
          objectValue(payload.response) ??
          objectValue(rawPayload(payload).response) ??
          {}
        const id =
          stringField(payload, 'request_id') ??
          stringField(response, 'request_id') ??
          stringField(rawPayload(payload), 'request_id')
        return id ? [id] : []
      }),
    )
    for (const event of events)
      this.processEvent(event, true, resolvedPermissions)
  }

  connectSSE(generation = this.generation): Promise<void> {
    this.unsub = sseBus.onEvent(event => {
      if (generation === this.generation) this.handleEvent(event)
    })
    const connection = sseBus.connect(this.sessionId)
    this.disconnectSSE = connection.disconnect
    return connection.ready
  }

  disconnect(): void {
    this.generation++
    this.initializing = false
    this.bufferedEvents = []
    this.closeConnection()
  }

  private closeConnection(): void {
    this.unsub?.()
    this.unsub = null
    this.disconnectSSE?.()
    this.disconnectSSE = null
  }

  handleEvent(event: SessionEvent): void {
    if (this.initializing) {
      this.bufferedEvents.push(event)
      return
    }
    this.processEvent(event, false)
  }

  private processEvent(
    event: SessionEvent,
    historical: boolean,
    resolvedPermissions: ReadonlySet<string> = new Set(),
  ): void {
    if (/Remote Control connecting/i.test(JSON.stringify(event))) return
    const payload = payloadOf(event)

    switch (event.type) {
      case 'stream_event':
      case 'partial_assistant': {
        const streamEvent =
          objectValue(payload.event) ?? objectValue(rawPayload(payload).event)
        if (streamEvent) this.handleStreamEvent(streamEvent)
        return
      }
      case 'assistant':
        this.handleAssistantSnapshot(event, payload)
        return
      case 'user':
      case 'user_message':
        this.handleUserMessage(event, payload)
        return
      case 'tool_use':
        this.handleToolUse(payload)
        return
      case 'tool_result':
        this.handleToolResult(payload)
        return
      case 'control_request':
      case 'permission_request':
        if (
          !historical ||
          !this.permissionWasResolved(payload, resolvedPermissions)
        ) {
          this.handlePermissionRequest(payload)
        }
        return
      case 'control_cancel_request':
        this.handlePermissionCancellation(payload)
        return
      case 'result':
      case 'result_success': {
        const terminal = { ...rawPayload(payload), ...payload }
        const cancellation = terminalIsCancellation(terminal)
        const failed =
          terminal.is_error === true ||
          (typeof terminal.subtype === 'string' &&
            /^error(?:_|$)/i.test(terminal.subtype))
        if (failed) {
          const errors = Array.isArray(terminal.errors)
            ? terminal.errors.map(String).filter(Boolean)
            : []
          const message =
            errors.join('\n') ||
            (typeof terminal.result === 'string' ? terminal.result : '') ||
            String(terminal.subtype ?? 'Turn failed')
          this.options?.onError?.(message)
          this.finishTools('error')
        } else {
          this.finishTools(cancellation ? 'cancelled' : 'completed')
        }
        this.dispatch({
          type: failed
            ? 'turn_failed'
            : cancellation
              ? 'turn_cancelled'
              : 'turn_completed',
          sessionId: this.sessionId,
        })
        this.currentAssistantId = null
        return
      }
      case 'error': {
        const message = String(
          payload.message ?? payload.content ?? 'Unknown error',
        )
        this.options?.onError?.(message)
        this.finishTools('error')
        this.dispatch({ type: 'turn_failed', sessionId: this.sessionId })
        this.currentAssistantId = null
        return
      }
      case 'session_status': {
        const status = typeof payload.status === 'string' ? payload.status : ''
        if (status) this.options?.onStatusChange?.(status)
        if (status === 'archived' || status === 'inactive') {
          this.finishTools('completed')
          this.dispatch({ type: 'turn_completed', sessionId: this.sessionId })
          this.currentAssistantId = null
        }
        return
      }
      case 'status':
        if (terminalIsCancellation(payload)) {
          this.finishTools('cancelled')
          this.dispatch({ type: 'turn_cancelled', sessionId: this.sessionId })
          this.currentAssistantId = null
        }
        return
      default:
        return
    }
  }

  private handleStreamEvent(event: ObjectValue): void {
    switch (event.type) {
      case 'message_start': {
        const message = objectValue(event.message)
        const id = stringField(message ?? {}, 'id') ?? generateMessageUuid()
        if (this.currentAssistantId && this.currentAssistantId !== id) {
          this.dispatch({ type: 'turn_completed', sessionId: this.sessionId })
        }
        this.currentAssistantId = id
        this.streamBlocks.clear()
        this.dispatch({ type: 'turn_started', sessionId: this.sessionId })
        return
      }
      case 'content_block_start': {
        const index = typeof event.index === 'number' ? event.index : -1
        if (index < 0) return
        const block = objectValue(event.content_block) ?? {}
        const streamBlock: StreamBlock = {
          type: typeof block.type === 'string' ? block.type : 'unknown',
          inputJson: '',
          toolId: stringField(block, 'id'),
          toolName: stringField(block, 'name'),
        }
        this.streamBlocks.set(index, streamBlock)
        if (
          streamBlock.type === 'thinking' &&
          this.currentAssistantId &&
          typeof block.thinking === 'string' &&
          block.thinking
        ) {
          this.dispatch({
            type: 'assistant_thought',
            sessionId: this.sessionId,
            id: this.currentAssistantId,
            text: block.thinking,
          })
        } else if (
          streamBlock.type === 'text' &&
          this.currentAssistantId &&
          typeof block.text === 'string' &&
          block.text
        ) {
          this.dispatch({
            type: 'assistant_content',
            sessionId: this.sessionId,
            id: this.currentAssistantId,
            block: { type: 'text', text: block.text },
          })
        } else if (streamBlock.type === 'tool_use' && streamBlock.toolId) {
          this.dispatch({
            type: 'tool_upsert',
            sessionId: this.sessionId,
            toolCall: {
              id: streamBlock.toolId,
              title: streamBlock.toolName ?? 'tool',
              status: 'in_progress',
              rawInput: objectValue(block.input) ?? {},
            },
          })
        } else if (streamBlock.type === 'audio' && this.currentAssistantId) {
          const normalized = renderableBlock(block)
          if (normalized?.type === 'audio') {
            this.dispatch({
              type: 'assistant_content',
              sessionId: this.sessionId,
              id: this.currentAssistantId,
              block: normalized,
            })
          }
        }
        return
      }
      case 'content_block_delta': {
        const delta = objectValue(event.delta)
        if (!delta || !this.currentAssistantId) return
        const index = typeof event.index === 'number' ? event.index : -1
        const block = this.streamBlocks.get(index)
        if (
          block?.type === 'text' &&
          delta.type === 'text_delta' &&
          typeof delta.text === 'string'
        ) {
          this.dispatch({
            type: 'assistant_content',
            sessionId: this.sessionId,
            id: this.currentAssistantId,
            block: { type: 'text', text: delta.text },
          })
        } else if (
          block?.type === 'thinking' &&
          delta.type === 'thinking_delta' &&
          typeof delta.thinking === 'string'
        ) {
          this.dispatch({
            type: 'assistant_thought',
            sessionId: this.sessionId,
            id: this.currentAssistantId,
            text: delta.thinking,
          })
        } else if (
          delta.type === 'input_json_delta' &&
          typeof delta.partial_json === 'string'
        ) {
          if (block?.type === 'tool_use') block.inputJson += delta.partial_json
        }
        return
      }
      case 'content_block_stop': {
        const index = typeof event.index === 'number' ? event.index : -1
        const block = this.streamBlocks.get(index)
        if (block?.type === 'tool_use' && block.toolId && block.inputJson) {
          try {
            const input = JSON.parse(block.inputJson)
            this.dispatch({
              type: 'tool_upsert',
              sessionId: this.sessionId,
              toolCall: {
                id: block.toolId,
                rawInput: objectValue(input) ?? {},
              },
            })
          } catch {
            // Keep the initial structured input when a partial JSON buffer is invalid.
          }
        }
        this.streamBlocks.delete(index)
        return
      }
      case 'message_stop': {
        this.dispatch({
          type: 'assistant_stream_completed',
          sessionId: this.sessionId,
        })
        this.currentAssistantId = null
        this.streamBlocks.clear()
        return
      }
      case 'message_delta':
      default:
        return
    }
  }

  private handleAssistantSnapshot(
    event: SessionEvent,
    payload: ObjectValue,
  ): void {
    const message = messageOf(payload)
    const id = stringField(message ?? {}, 'id') ?? eventUuid(event, payload)
    const existingEntry = this.getState().entries.find(
      (entry): entry is AssistantMessageEntry =>
        entry.type === 'assistant_message' && entry.id === id,
    )
    if (this.currentAssistantId && this.currentAssistantId !== id) {
      this.dispatch({ type: 'turn_completed', sessionId: this.sessionId })
    }
    if (!existingEntry) {
      this.dispatch({ type: 'turn_started', sessionId: this.sessionId })
    }
    if (!existingEntry || existingEntry.state === 'streaming') {
      this.currentAssistantId = id
    }

    const blocks = messageBlocks(payload)
    const existing = existingEntry !== undefined
    const snapshotChunks = blocks.reduce<AssistantChunk[]>((chunks, block) => {
      const value = objectValue(block)
      if (value?.type === 'thinking' && typeof value.thinking === 'string') {
        chunks.push({ type: 'thought', text: value.thinking })
        return chunks
      }
      const normalized = renderableBlock(block)
      if (!normalized) return chunks
      const last = chunks[chunks.length - 1]
      if (last?.type === 'message') last.content.push(normalized)
      else chunks.push({ type: 'message', content: [normalized] })
      return chunks
    }, [])
    if (existing && snapshotChunks.length > 0) {
      this.dispatch({
        type: 'assistant_full_snapshot',
        sessionId: this.sessionId,
        id,
        chunks: snapshotChunks,
      })
    } else if (!existing) {
      for (const block of blocks) {
        const value = objectValue(block)
        if (value?.type === 'thinking' && typeof value.thinking === 'string') {
          this.dispatch({
            type: 'assistant_thought',
            sessionId: this.sessionId,
            id,
            text: value.thinking,
          })
          continue
        }
        const normalized = renderableBlock(block)
        if (normalized) {
          this.dispatch({
            type: 'assistant_content',
            sessionId: this.sessionId,
            id,
            block: normalized,
          })
        }
      }
    }
    for (const block of blocks) {
      const value = objectValue(block)
      if (value?.type === 'tool_use') this.upsertToolBlock(value)
    }
  }

  private handleUserMessage(event: SessionEvent, payload: ObjectValue): void {
    const blocks = messageBlocks(payload)
    const toolResults = blocks.filter(
      block => objectValue(block)?.type === 'tool_result',
    )
    for (const block of toolResults)
      this.handleToolResult(objectValue(block) ?? {})

    const id = eventUuid(event, payload)
    if (
      toolResults.length === 0 &&
      this.getState().entries.some(
        entry => entry.type === 'user_message' && entry.id === id,
      )
    ) {
      return
    }
    for (const block of blocks) {
      if (objectValue(block)?.type === 'tool_result') continue
      const normalized = renderableBlock(block)
      if (normalized) {
        this.dispatch({
          type: 'user_content',
          sessionId: this.sessionId,
          id,
          block: normalized,
        })
      }
    }
  }

  private upsertToolBlock(block: ObjectValue): void {
    const id = stringField(block, 'id', 'tool_use_id', 'tool_call_id')
    if (!id) return
    const existing = this.getState().entries.find(
      entry => entry.type === 'tool_call' && entry.toolCall.id === id,
    )
    this.dispatch({
      type: 'tool_upsert',
      sessionId: this.sessionId,
      toolCall: {
        id,
        title: stringField(block, 'name', 'tool_name') ?? 'tool',
        rawInput: objectValue(block.input ?? block.tool_input) ?? {},
        ...(existing?.type === 'tool_call' &&
        isToolTerminal(existing.toolCall.status)
          ? {}
          : { status: 'in_progress' }),
      },
    })
  }

  private handleToolUse(payload: ObjectValue): void {
    const source = { ...rawPayload(payload), ...payload }
    this.upsertToolBlock({
      id: source.tool_call_id ?? source.tool_use_id ?? source.id,
      name: source.tool_name ?? source.name,
      input: source.tool_input ?? source.input,
    })
  }

  private handleToolResult(payload: ObjectValue): void {
    const source = { ...payload, ...rawPayload(payload) }
    const id = stringField(source, 'tool_use_id', 'tool_call_id', 'id')
    if (!id) return
    const output = toolOutput(source)
    const content = (Array.isArray(output) ? output : [output]).flatMap(
      block => {
        const normalized = renderableBlock(block)
        return normalized
          ? [{ type: 'content' as const, content: normalized }]
          : []
      },
    )
    this.dispatch({
      type: 'tool_upsert',
      sessionId: this.sessionId,
      toolCall: {
        id,
        status: source.is_error === true ? 'error' : 'completed',
        rawOutput: { output },
        ...(content.length > 0 ? { content } : {}),
      },
    })
  }

  private finishTools(status: 'completed' | 'cancelled' | 'error'): void {
    for (const entry of this.getState().entries) {
      if (
        entry.type === 'tool_call' &&
        !isToolTerminal(entry.toolCall.status)
      ) {
        this.dispatch({
          type: 'tool_upsert',
          sessionId: this.sessionId,
          toolCall: {
            id: entry.toolCall.id,
            status,
            permissionRequest: undefined,
          },
        })
      }
    }
  }

  private permissionWasResolved(
    payload: ObjectValue,
    resolvedPermissions: ReadonlySet<string>,
  ): boolean {
    const request = objectValue(payload.request) ?? {}
    const requestId =
      stringField(payload, 'request_id') ??
      stringField(rawPayload(payload), 'request_id')
    const status =
      stringField(payload, 'status') ??
      stringField(request, 'status') ??
      stringField(rawPayload(payload), 'status')
    return (
      (requestId !== undefined && resolvedPermissions.has(requestId)) ||
      (status !== undefined &&
        /^(?:resolved|completed|cancelled|canceled|rejected|approved)$/i.test(
          status,
        ))
    )
  }

  private handlePermissionCancellation(payload: ObjectValue): void {
    const requestId =
      stringField(payload, 'request_id') ??
      stringField(rawPayload(payload), 'request_id')
    if (!requestId) return
    const tool = this.getState().entries.find(
      entry =>
        entry.type === 'tool_call' &&
        entry.toolCall.permissionRequest?.requestId === requestId,
    )
    if (tool?.type === 'tool_call') {
      this.dispatch({
        type: 'tool_upsert',
        sessionId: this.sessionId,
        toolCall: {
          id: tool.toolCall.id,
          status: 'in_progress',
          permissionRequest: undefined,
        },
      })
    }
    this.options?.onPermissionCancelled?.(requestId)
  }

  private handlePermissionRequest(payload: ObjectValue): void {
    const request = objectValue(payload.request)
    if (!request || request.subtype !== 'can_use_tool') return
    const requestId = stringField(payload, 'request_id') ?? ''
    const toolName = stringField(request, 'tool_name') ?? 'unknown'
    const toolInput = objectValue(request.input ?? request.tool_input) ?? {}
    const requestedToolId =
      stringField(request, 'tool_use_id', 'tool_call_id') ??
      stringField(payload, 'tool_use_id', 'tool_call_id') ??
      stringField(rawPayload(payload), 'tool_use_id', 'tool_call_id')
    const activeTool = [...this.getState().entries]
      .reverse()
      .find(
        entry =>
          entry.type === 'tool_call' && !isToolTerminal(entry.toolCall.status),
      )
    const id =
      requestedToolId ??
      (activeTool?.type === 'tool_call' ? activeTool.toolCall.id : requestId)
    const existingRequestedTool = requestedToolId
      ? this.getState().entries.find(
          entry =>
            entry.type === 'tool_call' && entry.toolCall.id === requestedToolId,
        )
      : activeTool
    if (id) {
      this.dispatch({
        type: 'tool_upsert',
        sessionId: this.sessionId,
        toolCall: {
          id,
          title: toolName,
          status: 'waiting_for_confirmation',
          rawInput: toolInput,
          permissionRequest: { requestId, options: [] },
          ...(existingRequestedTool ? {} : { isStandalonePermission: true }),
        },
      })
    }
    this.options?.onPermissionRequest?.({
      requestId,
      toolName,
      toolInput,
      description:
        typeof request.description === 'string'
          ? request.description
          : undefined,
    })
  }

  async sendMessage(
    text: string,
    images: UserMessageImage[] = [],
  ): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed && images.length === 0) return
    const id = generateMessageUuid()
    const localContent: RenderableContentBlock[] = [
      ...(trimmed ? [{ type: 'text' as const, text: trimmed }] : []),
      ...images.map(image => ({
        type: 'image' as const,
        mimeType: image.mimeType,
        data: image.data,
      })),
    ]
    const wireContent = [
      ...(trimmed ? [{ type: 'text' as const, text: trimmed }] : []),
      ...images.map(image => ({
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: image.mimeType,
          data: image.data,
        },
      })),
    ]

    try {
      for (const image of images) assertSupportedImage(image)
    } catch (error) {
      this.dispatch({
        type: 'user_message_added',
        sessionId: this.sessionId,
        entry: {
          type: 'user_message',
          id,
          content: localContent,
          deliveryState: 'failed',
        },
      })
      this.dispatch({ type: 'turn_failed', sessionId: this.sessionId })
      this.options?.onError?.(
        error instanceof Error ? error.message : 'Invalid image',
      )
      throw error
    }

    this.dispatch({
      type: 'user_message_added',
      sessionId: this.sessionId,
      entry: {
        type: 'user_message',
        id,
        content: localContent,
        deliveryState: 'sending',
      },
    })
    this.dispatch({ type: 'turn_started', sessionId: this.sessionId })
    try {
      await apiSendEvent(this.sessionId, {
        type: 'user',
        uuid: id,
        content: trimmed,
        message: { role: 'user', content: wireContent },
      })
      this.dispatch({
        type: 'user_message_delivery',
        sessionId: this.sessionId,
        id,
        deliveryState: 'sent',
      })
    } catch (error) {
      this.dispatch({
        type: 'user_message_delivery',
        sessionId: this.sessionId,
        id,
        deliveryState: 'failed',
      })
      this.dispatch({ type: 'turn_failed', sessionId: this.sessionId })
      this.options?.onError?.(
        error instanceof Error ? error.message : 'Failed to send message',
      )
      throw error
    }
  }

  async respondPermission(
    requestId: string,
    approved: boolean,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await apiSendControl(this.sessionId, {
        type: 'permission_response',
        approved,
        request_id: requestId,
        ...extra,
      })
    } catch (error) {
      this.options?.onError?.(
        error instanceof Error ? error.message : 'Failed to send permission',
      )
      throw error
    }
    const tool = this.getState().entries.find(
      entry =>
        entry.type === 'tool_call' &&
        entry.toolCall.permissionRequest?.requestId === requestId,
    )
    if (tool?.type === 'tool_call') {
      this.dispatch({
        type: 'tool_upsert',
        sessionId: this.sessionId,
        toolCall: {
          id: tool.toolCall.id,
          status: approved ? 'in_progress' : 'rejected',
          permissionRequest: undefined,
        },
      })
    }
  }

  async interrupt(): Promise<void> {
    for (const action of cancelThreadActions(this.getState()))
      this.dispatch(action)
    try {
      await apiInterrupt(this.sessionId)
      this.dispatch({ type: 'turn_cancelled', sessionId: this.sessionId })
      this.currentAssistantId = null
      this.streamBlocks.clear()
    } catch (error) {
      this.dispatch({ type: 'turn_failed', sessionId: this.sessionId })
      this.options?.onError?.(
        error instanceof Error ? error.message : 'Failed to interrupt',
      )
      throw error
    }
  }
}
