import type {
  AssistantChunk,
  AssistantMessageEntry,
  PlanDisplayEntry,
  RenderableContentBlock,
  ThreadEntry,
  ThreadPhase,
  ToolCallData,
  ToolCallStatus,
  UserMessageEntry,
} from './types'
import { isPlayableAudio } from './audio-content'

export interface ThreadState {
  sessionId: string | null
  entries: ThreadEntry[]
  phase: ThreadPhase
  activeAssistantId: string | null
}

type SessionAction = { sessionId: string }
type PermissionRequest = NonNullable<ToolCallData['permissionRequest']>
type ToolCallPatch = Pick<ToolCallData, 'id'> &
  Partial<Omit<ToolCallData, 'id' | 'status' | 'permissionRequest'>> & {
    status?: string
    permissionRequest?: Partial<PermissionRequest>
  }

export type ThreadStateAction =
  | { type: 'reset'; sessionId: string | null }
  | (SessionAction & { type: 'phase_changed'; phase: ThreadPhase })
  | (SessionAction & { type: 'turn_started' })
  | (SessionAction & { type: 'assistant_stream_completed' })
  | (SessionAction & { type: 'turn_completed' })
  | (SessionAction & { type: 'turn_cancelled' })
  | (SessionAction & { type: 'turn_failed' })
  | (SessionAction & { type: 'user_message_added'; entry: UserMessageEntry })
  | (SessionAction & {
      type: 'user_message_delivery'
      id: string
      deliveryState: UserMessageEntry['deliveryState']
    })
  | (SessionAction & {
      type: 'user_content'
      id: string
      block: RenderableContentBlock
    })
  | (SessionAction & {
      type: 'assistant_content'
      id: string
      block: RenderableContentBlock
    })
  | (SessionAction & {
      type: 'assistant_thought'
      id: string
      text: string
      estimatedTokens?: number
    })
  | (SessionAction & {
      type: 'assistant_full_snapshot'
      id: string
      chunks: AssistantChunk[]
    })
  | (SessionAction & {
      type: 'assistant_snapshot'
      id: string
      content: RenderableContentBlock[]
    })
  | (SessionAction & {
      type: 'tool_upsert'
      toolCall: ToolCallPatch
    })
  | (SessionAction & {
      type: 'plan_replace'
      id: string
      entries: PlanDisplayEntry['entries']
    })
  | (SessionAction & { type: 'plan_remove' })

export function initialThreadState(
  sessionId: string | null = null,
): ThreadState {
  return { sessionId, entries: [], phase: 'idle', activeAssistantId: null }
}

export function normalizeToolStatus(status: string): ToolCallStatus {
  switch (status) {
    case 'pending':
    case 'queued':
      return 'queued'
    case 'running':
    case 'in_progress':
      return 'in_progress'
    case 'waiting_for_confirmation':
      return 'waiting_for_confirmation'
    case 'complete':
    case 'completed':
    case 'result':
    case 'success':
      return 'completed'
    case 'rejected':
      return 'rejected'
    case 'canceled':
    case 'cancelled':
      return 'cancelled'
    default:
      return 'error'
  }
}

export function toRenderableContentBlock(
  block: unknown,
): RenderableContentBlock | null {
  if (!block || typeof block !== 'object') return null
  const candidate = block as Record<string, unknown>
  if (candidate.type === 'text' && typeof candidate.text === 'string') {
    return { type: 'text', text: candidate.text, ...contentMetadata(candidate) }
  }
  if (
    candidate.type === 'image' &&
    typeof candidate.mimeType === 'string' &&
    typeof candidate.data === 'string'
  ) {
    return {
      type: 'image',
      mimeType: candidate.mimeType,
      data: candidate.data,
      ...(candidate.uri === null || typeof candidate.uri === 'string'
        ? { uri: candidate.uri }
        : {}),
      ...contentMetadata(candidate),
    }
  }
  if (
    candidate.type === 'audio' &&
    typeof candidate.mimeType === 'string' &&
    typeof candidate.data === 'string'
  ) {
    return {
      type: 'audio',
      mimeType: candidate.mimeType,
      data: candidate.data,
      playable: isPlayableAudio(candidate.mimeType, candidate.data),
      ...contentMetadata(candidate),
    }
  }
  if (
    candidate.type === 'resource_link' &&
    typeof candidate.uri === 'string' &&
    typeof candidate.name === 'string'
  ) {
    return {
      type: 'resource_link',
      uri: candidate.uri,
      name: candidate.name,
      ...(candidate.title === null || typeof candidate.title === 'string'
        ? { title: candidate.title }
        : {}),
      ...(candidate.description === null ||
      typeof candidate.description === 'string'
        ? { description: candidate.description }
        : {}),
      ...(candidate.mimeType === null || typeof candidate.mimeType === 'string'
        ? { mimeType: candidate.mimeType }
        : {}),
      ...(candidate.size === null ||
      (typeof candidate.size === 'number' && Number.isFinite(candidate.size))
        ? { size: candidate.size }
        : {}),
      ...resourceIcons(candidate.icons),
      ...contentMetadata(candidate),
    }
  }
  const resource =
    candidate.type === 'resource' &&
    candidate.resource &&
    typeof candidate.resource === 'object'
      ? (candidate.resource as Record<string, unknown>)
      : null
  if (resource && typeof resource.uri === 'string') {
    if (typeof resource.text === 'string') {
      return {
        type: 'resource',
        resource: {
          uri: resource.uri,
          ...(resource.mimeType === null ||
          typeof resource.mimeType === 'string'
            ? { mimeType: resource.mimeType }
            : {}),
          text: resource.text,
          ...resourceMetadata(resource),
        },
        ...contentMetadata(candidate),
      }
    }
    if (typeof resource.blob === 'string') {
      return {
        type: 'resource',
        resource: {
          uri: resource.uri,
          ...(resource.mimeType === null ||
          typeof resource.mimeType === 'string'
            ? { mimeType: resource.mimeType }
            : {}),
          blob: resource.blob,
          ...resourceMetadata(resource),
        },
        ...contentMetadata(candidate),
      }
    }
  }
  return null
}

function recordMetadata(
  value: unknown,
): Record<string, unknown> | null | undefined {
  if (value === null) return null
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function normalizedAnnotations(
  value: unknown,
): Record<string, unknown> | null | undefined {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined
  const candidate = value as Record<string, unknown>
  const annotations: Record<string, unknown> = {}
  const meta = recordMetadata(candidate._meta)
  if (meta !== undefined) annotations._meta = meta
  if (
    candidate.audience === null ||
    (Array.isArray(candidate.audience) &&
      candidate.audience.every(role => role === 'assistant' || role === 'user'))
  ) {
    annotations.audience = candidate.audience
  }
  if (
    candidate.lastModified === null ||
    typeof candidate.lastModified === 'string'
  ) {
    annotations.lastModified = candidate.lastModified
  }
  if (
    candidate.priority === null ||
    (typeof candidate.priority === 'number' &&
      Number.isFinite(candidate.priority))
  ) {
    annotations.priority = candidate.priority
  }
  return annotations
}

function contentMetadata(
  candidate: Record<string, unknown>,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {}
  const annotations = normalizedAnnotations(candidate.annotations)
  const meta = recordMetadata(candidate._meta)
  if (annotations !== undefined) metadata.annotations = annotations
  if (meta !== undefined) metadata._meta = meta
  return metadata
}

function resourceMetadata(
  candidate: Record<string, unknown>,
): Record<string, unknown> {
  const meta = recordMetadata(candidate._meta)
  return meta === undefined ? {} : { _meta: meta }
}

function resourceIcons(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) return {}
  const icons = value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const icon = item as Record<string, unknown>
    if (typeof icon.src !== 'string') return []
    return [
      {
        src: icon.src,
        ...(typeof icon.mimeType === 'string'
          ? { mimeType: icon.mimeType }
          : {}),
        ...(Array.isArray(icon.sizes) &&
        icon.sizes.every(size => typeof size === 'string')
          ? { sizes: icon.sizes }
          : {}),
        ...(icon.theme === 'light' || icon.theme === 'dark'
          ? { theme: icon.theme }
          : {}),
      },
    ]
  })
  return { icons }
}

function appendBlock(
  content: RenderableContentBlock[],
  block: RenderableContentBlock,
): RenderableContentBlock[] {
  const last = content[content.length - 1]
  if (
    last?.type === 'text' &&
    block.type === 'text' &&
    last.annotations === undefined &&
    last._meta === undefined &&
    block.annotations === undefined &&
    block._meta === undefined
  ) {
    return [
      ...content.slice(0, -1),
      { type: 'text', text: last.text + block.text },
    ]
  }
  return [...content, block]
}

function updateAssistant(
  state: ThreadState,
  id: string,
  update: (entry: AssistantMessageEntry) => AssistantMessageEntry,
): ThreadState {
  const index = state.entries.findIndex(
    entry => entry.type === 'assistant_message' && entry.id === id,
  )
  if (index < 0) return state
  const entry = state.entries[index] as AssistantMessageEntry
  const entries = [...state.entries]
  entries[index] = update(entry)
  return { ...state, entries }
}

function upsertAssistant(
  state: ThreadState,
  id: string,
  update: (entry: AssistantMessageEntry) => AssistantMessageEntry,
): ThreadState {
  const existing = updateAssistant(state, id, update)
  if (existing !== state) return existing
  return {
    ...state,
    entries: [
      ...state.entries,
      update({
        type: 'assistant_message',
        id,
        chunks: [],
        state: 'streaming',
      }),
    ],
  }
}

function appendAssistantBlock(
  entry: AssistantMessageEntry,
  block: RenderableContentBlock,
): AssistantMessageEntry {
  const last = entry.chunks[entry.chunks.length - 1]
  if (last?.type !== 'message') {
    return {
      ...entry,
      chunks: [...entry.chunks, { type: 'message', content: [block] }],
    }
  }
  return {
    ...entry,
    chunks: [
      ...entry.chunks.slice(0, -1),
      { type: 'message', content: appendBlock(last.content, block) },
    ],
  }
}

function appendThought(
  entry: AssistantMessageEntry,
  text: string,
  estimatedTokens?: number,
): AssistantMessageEntry {
  const last = entry.chunks[entry.chunks.length - 1]
  if (last?.type !== 'thought') {
    return {
      ...entry,
      chunks: [
        ...entry.chunks,
        {
          type: 'thought',
          text,
          ...(estimatedTokens === undefined ? {} : { estimatedTokens }),
        },
      ],
    }
  }

  const total =
    estimatedTokens === undefined
      ? last.estimatedTokens
      : last.estimatedTokens === undefined
        ? undefined
        : last.estimatedTokens + estimatedTokens
  return {
    ...entry,
    chunks: [
      ...entry.chunks.slice(0, -1),
      {
        type: 'thought',
        text: last.text + text,
        ...(total === undefined ? {} : { estimatedTokens: total }),
      },
    ],
  }
}

function contentBlocksEqual(
  left: RenderableContentBlock,
  right: RenderableContentBlock,
): boolean {
  if (left.type !== right.type) return false
  if (left.type === 'text' && right.type === 'text') {
    return left.text === right.text
  }
  if (left.type === 'image' && right.type === 'image') {
    return (
      left.mimeType === right.mimeType &&
      left.data === right.data &&
      left.uri === right.uri
    )
  }
  if (left.type === 'resource_link' && right.type === 'resource_link') {
    return (
      left.uri === right.uri &&
      left.name === right.name &&
      left.title === right.title &&
      left.description === right.description &&
      left.mimeType === right.mimeType &&
      left.size === right.size
    )
  }
  return false
}

function snapshotTail(
  streamed: RenderableContentBlock[],
  snapshot: RenderableContentBlock[],
): RenderableContentBlock[] | null {
  let snapshotIndex = 0
  for (
    let streamedIndex = 0;
    streamedIndex < streamed.length;
    streamedIndex++
  ) {
    const streamedBlock = streamed[streamedIndex]
    const snapshotBlock = snapshot[snapshotIndex]
    if (!streamedBlock || !snapshotBlock) return null

    if (streamedBlock.type === 'text' && snapshotBlock.type === 'text') {
      if (streamedBlock.text === snapshotBlock.text) {
        snapshotIndex++
        continue
      }
      if (
        streamedIndex === streamed.length - 1 &&
        snapshotBlock.text.startsWith(streamedBlock.text)
      ) {
        const suffix = snapshotBlock.text.slice(streamedBlock.text.length)
        return [
          ...(suffix ? [{ type: 'text' as const, text: suffix }] : []),
          ...snapshot.slice(snapshotIndex + 1),
        ]
      }
      return null
    }

    if (!contentBlocksEqual(streamedBlock, snapshotBlock)) return null
    snapshotIndex++
  }
  return snapshot.slice(snapshotIndex)
}

function reconcileSnapshot(
  entry: AssistantMessageEntry,
  content: RenderableContentBlock[],
): AssistantMessageEntry {
  const streamed = entry.chunks
    .flatMap(chunk => (chunk.type === 'message' ? chunk.content : []))
    .reduce(appendBlock, [] as RenderableContentBlock[])
  const message = content.reduce(appendBlock, [] as RenderableContentBlock[])

  const tail = snapshotTail(streamed, message)
  if (tail) {
    const chunks = [...entry.chunks]
    const index = chunks.map(chunk => chunk.type).lastIndexOf('message')
    const chunk = chunks[index]
    if (chunk?.type === 'message' && tail.length > 0) {
      chunks[index] = {
        type: 'message',
        content: tail.reduce(appendBlock, chunk.content),
      }
    } else if (index < 0 && tail.length > 0) {
      chunks.push({ type: 'message', content: tail })
    }
    return { ...entry, chunks }
  }

  const firstMessageIndex = entry.chunks.findIndex(
    chunk => chunk.type === 'message',
  )
  const chunks = entry.chunks.flatMap<AssistantChunk>((chunk, index) => {
    if (chunk.type === 'thought') return [chunk]
    if (index === firstMessageIndex && message.length > 0) {
      return [{ type: 'message', content: message }]
    }
    return []
  })
  if (firstMessageIndex < 0 && message.length > 0) {
    chunks.push({ type: 'message', content: message })
  }
  return {
    ...entry,
    chunks,
  }
}

function phaseForToolStatus(
  status: ToolCallStatus,
  currentPhase: ThreadPhase,
): ThreadPhase {
  if (
    status === 'queued' ||
    status === 'in_progress' ||
    status === 'waiting_for_confirmation'
  ) {
    return 'using_tool'
  }
  return currentPhase
}

export function threadStateReducer(
  state: ThreadState,
  action: ThreadStateAction,
): ThreadState {
  if (action.type === 'reset') return initialThreadState(action.sessionId)
  if (state.sessionId !== action.sessionId) return state

  switch (action.type) {
    case 'phase_changed':
      return { ...state, phase: action.phase }
    case 'turn_started':
      return { ...state, phase: 'requesting' }
    case 'assistant_stream_completed': {
      const completed = state.activeAssistantId
        ? updateAssistant(state, state.activeAssistantId, entry => ({
            ...entry,
            state: 'completed',
          }))
        : state
      const hasActiveTool = completed.entries.some(
        entry =>
          entry.type === 'tool_call' &&
          (entry.toolCall.status === 'queued' ||
            entry.toolCall.status === 'in_progress' ||
            entry.toolCall.status === 'waiting_for_confirmation'),
      )
      return {
        ...completed,
        phase: hasActiveTool ? 'using_tool' : 'responding',
        activeAssistantId: null,
      }
    }
    case 'turn_completed':
    case 'turn_cancelled':
    case 'turn_failed': {
      const assistantState =
        action.type === 'turn_completed'
          ? 'completed'
          : action.type === 'turn_cancelled'
            ? 'cancelled'
            : 'error'
      const terminal = state.activeAssistantId
        ? updateAssistant(state, state.activeAssistantId, entry => ({
            ...entry,
            state: assistantState,
          }))
        : state
      return {
        ...terminal,
        phase: action.type === 'turn_failed' ? 'error' : 'idle',
        activeAssistantId: null,
      }
    }
    case 'user_message_added':
      return { ...state, entries: [...state.entries, action.entry] }
    case 'user_message_delivery':
      return {
        ...state,
        entries: state.entries.map(entry =>
          entry.type === 'user_message' && entry.id === action.id
            ? { ...entry, deliveryState: action.deliveryState }
            : entry,
        ),
      }
    case 'user_content': {
      const last = state.entries[state.entries.length - 1]
      if (last?.type === 'user_message' && last.id === action.id) {
        const entries = [...state.entries]
        entries[entries.length - 1] = {
          ...last,
          content: appendBlock(last.content, action.block),
        }
        return { ...state, entries }
      }
      return {
        ...state,
        entries: [
          ...state.entries,
          {
            type: 'user_message',
            id: action.id,
            content: [action.block],
            deliveryState: 'sent',
          },
        ],
      }
    }
    case 'assistant_content':
      return {
        ...upsertAssistant(state, action.id, entry =>
          appendAssistantBlock(entry, action.block),
        ),
        phase: 'responding',
        activeAssistantId: action.id,
      }
    case 'assistant_thought':
      return {
        ...upsertAssistant(state, action.id, entry =>
          appendThought(entry, action.text, action.estimatedTokens),
        ),
        phase: 'thinking',
        activeAssistantId: action.id,
      }
    case 'assistant_full_snapshot':
      return updateAssistant(state, action.id, entry => ({
        ...entry,
        chunks: action.chunks,
      }))
    case 'assistant_snapshot':
      return updateAssistant(state, action.id, entry =>
        reconcileSnapshot(entry, action.content),
      )
    case 'tool_upsert': {
      const { status, permissionRequest, ...rawFields } = action.toolCall
      // biome-ignore lint/suspicious/noPrototypeBuiltins: Object.hasOwn requires ES2022.
      const hasPermissionRequest = Object.prototype.hasOwnProperty.call(
        action.toolCall,
        'permissionRequest',
      )
      // biome-ignore lint/suspicious/noPrototypeBuiltins: Object.hasOwn requires ES2022.
      const hasStandalonePermission = Object.prototype.hasOwnProperty.call(
        action.toolCall,
        'isStandalonePermission',
      )
      const fields = Object.fromEntries(
        Object.entries(rawFields).filter(([, value]) => value !== undefined),
      ) as typeof rawFields
      const index = state.entries.findIndex(
        entry => entry.type === 'tool_call' && entry.toolCall.id === fields.id,
      )
      if (index < 0) {
        const toolCall: ToolCallData = {
          ...fields,
          title: fields.title ?? fields.id,
          status: status === undefined ? 'queued' : normalizeToolStatus(status),
        }
        if (permissionRequest) {
          toolCall.permissionRequest = {
            requestId: permissionRequest.requestId ?? '',
            options: permissionRequest.options ?? [],
          }
        }
        return {
          ...state,
          entries: [...state.entries, { type: 'tool_call', toolCall }],
          phase: phaseForToolStatus(toolCall.status, state.phase),
        }
      }
      const previous = state.entries[index]
      if (previous?.type !== 'tool_call') return state
      const entries = [...state.entries]
      const toolCall: ToolCallData = {
        ...previous.toolCall,
        ...fields,
        status:
          status === undefined
            ? previous.toolCall.status
            : normalizeToolStatus(status),
      }
      if (hasPermissionRequest) {
        if (permissionRequest === undefined) {
          delete toolCall.permissionRequest
        } else {
          toolCall.permissionRequest = {
            requestId:
              permissionRequest.requestId ??
              previous.toolCall.permissionRequest?.requestId ??
              '',
            options:
              permissionRequest.options ??
              previous.toolCall.permissionRequest?.options ??
              [],
          }
        }
      }
      if (
        hasStandalonePermission &&
        action.toolCall.isStandalonePermission === undefined
      ) {
        delete toolCall.isStandalonePermission
      }
      entries[index] = {
        type: 'tool_call',
        toolCall,
      }
      return {
        ...state,
        entries,
        phase: phaseForToolStatus(toolCall.status, state.phase),
      }
    }
    case 'plan_replace': {
      const index = state.entries.reduce(
        (last, entry, entryIndex) =>
          entry.type === 'plan' ? entryIndex : last,
        -1,
      )
      if (index < 0) {
        return {
          ...state,
          entries: [
            ...state.entries,
            { type: 'plan', id: action.id, entries: action.entries },
          ],
        }
      }
      const previous = state.entries[index]
      if (previous?.type !== 'plan') return state
      const entries = [...state.entries]
      entries[index] = { ...previous, entries: action.entries }
      return { ...state, entries }
    }
    case 'plan_remove':
      return {
        ...state,
        entries: state.entries.filter(entry => entry.type !== 'plan'),
      }
  }
}

export function reduceThreadState(
  state: ThreadState,
  actions: readonly ThreadStateAction[],
): ThreadState {
  return actions.reduce(threadStateReducer, state)
}

export function cancelThreadActions(state: ThreadState): ThreadStateAction[] {
  const sessionId = state.sessionId
  if (!sessionId) return []
  return [
    { type: 'phase_changed', sessionId, phase: 'cancelling' },
    ...state.entries.flatMap<ThreadStateAction>(entry => {
      if (
        entry.type !== 'tool_call' ||
        !['queued', 'in_progress', 'waiting_for_confirmation'].includes(
          entry.toolCall.status,
        )
      ) {
        return []
      }
      return [
        {
          type: 'tool_upsert',
          sessionId,
          toolCall: {
            id: entry.toolCall.id,
            status: 'cancelled',
            permissionRequest: undefined,
          },
        },
      ]
    }),
  ]
}
