import { describe, expect, test } from 'bun:test'
import type { SessionUpdate } from '../acp/types'
import type { RenderableContentBlock } from '../lib/types'
import {
  acpErrorToThreadActions,
  acpHistoryReplayCompletedActions,
  acpPromptFailureMessage,
  acpUpdateToThreadActionsForState,
  acpUpdateToThreadActions,
  permissionResponseToolStatus,
  shouldHandleAcpError,
  submitAcpPrompt,
} from '../lib/acp-thread-events'
import {
  cancelThreadActions,
  initialThreadState,
  normalizeToolStatus,
  reduceThreadState,
  threadStateReducer,
  toRenderableContentBlock,
} from '../lib/thread-state'

describe('threadStateReducer', () => {
  test('full thought snapshot preserves interleaved thought and message blocks', () => {
    let state = reduceThreadState(initialThreadState('session-1'), [
      { type: 'turn_started', sessionId: 'session-1' },
      {
        type: 'assistant_thought',
        sessionId: 'session-1',
        id: 'm1',
        text: 'draft t1',
      },
      {
        type: 'assistant_content',
        sessionId: 'session-1',
        id: 'm1',
        block: { type: 'text', text: 'draft m1' },
      },
      {
        type: 'assistant_thought',
        sessionId: 'session-1',
        id: 'm1',
        text: 'draft t2',
      },
      {
        type: 'assistant_content',
        sessionId: 'session-1',
        id: 'm1',
        block: { type: 'text', text: 'draft m2' },
      },
      { type: 'turn_completed', sessionId: 'session-1' },
    ])
    state = threadStateReducer(state, {
      type: 'assistant_full_snapshot',
      sessionId: 'session-1',
      id: 'm1',
      chunks: [
        { type: 'thought', text: 'T1' },
        { type: 'message', content: [{ type: 'text', text: 'M1' }] },
        { type: 'thought', text: 'T2' },
        { type: 'message', content: [{ type: 'text', text: 'M2' }] },
      ],
    })
    expect(state.phase).toBe('idle')
    expect(state.entries[0]).toMatchObject({
      state: 'completed',
      chunks: [
        { type: 'thought', text: 'T1' },
        { type: 'message', content: [{ type: 'text', text: 'M1' }] },
        { type: 'thought', text: 'T2' },
        { type: 'message', content: [{ type: 'text', text: 'M2' }] },
      ],
    })
  })
  test('preserves interleaved thinking and message chunks', () => {
    const state = reduceThreadState(initialThreadState('session-1'), [
      { type: 'turn_started', sessionId: 'session-1' },
      {
        type: 'assistant_thought',
        sessionId: 'session-1',
        id: 'assistant-1',
        text: 'considering',
        estimatedTokens: 3,
      },
      {
        type: 'assistant_content',
        sessionId: 'session-1',
        id: 'assistant-1',
        block: { type: 'text', text: 'hello' },
      },
      {
        type: 'assistant_thought',
        sessionId: 'session-1',
        id: 'assistant-1',
        text: 'again',
      },
      {
        type: 'assistant_content',
        sessionId: 'session-1',
        id: 'assistant-1',
        block: { type: 'text', text: ' world' },
      },
    ])

    expect(state.entries[0]).toEqual({
      type: 'assistant_message',
      id: 'assistant-1',
      state: 'streaming',
      chunks: [
        { type: 'thought', text: 'considering', estimatedTokens: 3 },
        { type: 'message', content: [{ type: 'text', text: 'hello' }] },
        { type: 'thought', text: 'again' },
        { type: 'message', content: [{ type: 'text', text: ' world' }] },
      ],
    })
  })

  test('merges consecutive thought deltas without crossing message chunks', () => {
    const state = reduceThreadState(initialThreadState('session-1'), [
      { type: 'turn_started', sessionId: 'session-1' },
      {
        type: 'assistant_thought',
        sessionId: 'session-1',
        id: 'assistant-1',
        text: 'one',
        estimatedTokens: 2,
      },
      {
        type: 'assistant_thought',
        sessionId: 'session-1',
        id: 'assistant-1',
        text: ' two',
        estimatedTokens: 3,
      },
      {
        type: 'assistant_content',
        sessionId: 'session-1',
        id: 'assistant-1',
        block: { type: 'text', text: 'answer' },
      },
      {
        type: 'assistant_thought',
        sessionId: 'session-1',
        id: 'assistant-1',
        text: 'three',
      },
      {
        type: 'assistant_thought',
        sessionId: 'session-1',
        id: 'assistant-1',
        text: ' four',
        estimatedTokens: 4,
      },
    ])

    expect(state.entries[0]).toMatchObject({
      chunks: [
        { type: 'thought', text: 'one two', estimatedTokens: 5 },
        { type: 'message', content: [{ type: 'text', text: 'answer' }] },
        { type: 'thought', text: 'three four' },
      ],
    })
  })

  test('merges adjacent text while preserving non-text block order', () => {
    const image = { type: 'image' as const, mimeType: 'image/png', data: 'abc' }
    const resource = {
      type: 'resource_link' as const,
      uri: 'file:///report.md',
      name: 'report.md',
    }
    const state = reduceThreadState(initialThreadState('session-1'), [
      { type: 'turn_started', sessionId: 'session-1' },
      {
        type: 'assistant_content',
        id: 'assistant-1',
        sessionId: 'session-1',
        block: { type: 'text', text: 'a' },
      },
      {
        type: 'assistant_content',
        id: 'assistant-1',
        sessionId: 'session-1',
        block: { type: 'text', text: 'b' },
      },
      {
        type: 'assistant_content',
        sessionId: 'session-1',
        id: 'assistant-1',
        block: image,
      },
      {
        type: 'assistant_content',
        id: 'assistant-1',
        sessionId: 'session-1',
        block: { type: 'text', text: 'c' },
      },
      {
        type: 'assistant_content',
        id: 'assistant-1',
        sessionId: 'session-1',
        block: resource,
      },
    ])

    expect(state.entries[0]?.type).toBe('assistant_message')
    if (state.entries[0]?.type !== 'assistant_message') return
    expect(state.entries[0].chunks).toEqual([
      {
        type: 'message',
        content: [
          { type: 'text', text: 'ab' },
          image,
          { type: 'text', text: 'c' },
          resource,
        ],
      },
    ])
  })

  test('does not merge adjacent text blocks when that would discard ACP metadata', () => {
    const first = {
      type: 'text' as const,
      text: 'a',
      annotations: { audience: ['user'] as Array<'user'> },
      _meta: { chunk: 1 },
    }
    const second = {
      type: 'text' as const,
      text: 'b',
      annotations: null,
      _meta: { chunk: 2 },
    }
    const state = reduceThreadState(initialThreadState('session-1'), [
      { type: 'turn_started', sessionId: 'session-1' },
      {
        type: 'assistant_content',
        id: 'assistant-1',
        sessionId: 'session-1',
        block: first,
      },
      {
        type: 'assistant_content',
        id: 'assistant-1',
        sessionId: 'session-1',
        block: second,
      },
    ])

    expect(state.entries[0]).toMatchObject({
      chunks: [{ type: 'message', content: [first, second] }],
    })
  })

  test('reconciles a snapshot without terminating the active turn', () => {
    const snapshot = reduceThreadState(initialThreadState('session-1'), [
      { type: 'turn_started', sessionId: 'session-1' },
      {
        type: 'assistant_content',
        id: 'assistant-1',
        sessionId: 'session-1',
        block: { type: 'text', text: 'Hello' },
      },
      {
        type: 'assistant_snapshot',
        sessionId: 'session-1',
        id: 'assistant-1',
        content: [{ type: 'text', text: 'Hello world' }],
      },
    ])

    expect(snapshot.entries[0]).toEqual({
      type: 'assistant_message',
      id: 'assistant-1',
      state: 'streaming',
      chunks: [
        { type: 'message', content: [{ type: 'text', text: 'Hello world' }] },
      ],
    })
    expect(snapshot.activeAssistantId).toBe('assistant-1')
    expect(snapshot.phase).toBe('responding')

    const terminal = threadStateReducer(snapshot, {
      type: 'turn_completed',
      sessionId: 'session-1',
    })
    expect(terminal.entries[0]).toMatchObject({ state: 'completed' })
    expect(terminal.activeAssistantId).toBeNull()
    expect(terminal.phase).toBe('idle')
  })

  test('keeps thought placement while reconciling a completed snapshot', () => {
    const state = reduceThreadState(initialThreadState('session-1'), [
      { type: 'turn_started', sessionId: 'session-1' },
      {
        type: 'assistant_content',
        id: 'assistant-1',
        sessionId: 'session-1',
        block: { type: 'text', text: 'Hello' },
      },
      {
        type: 'assistant_thought',
        id: 'assistant-1',
        sessionId: 'session-1',
        text: 'checking',
      },
      {
        type: 'assistant_content',
        id: 'assistant-1',
        sessionId: 'session-1',
        block: { type: 'text', text: ' world' },
      },
      {
        type: 'assistant_snapshot',
        sessionId: 'session-1',
        id: 'assistant-1',
        content: [{ type: 'text', text: 'Hello world' }],
      },
    ])

    expect(state.entries[0]).toMatchObject({
      state: 'streaming',
      chunks: [
        { type: 'message', content: [{ type: 'text', text: 'Hello' }] },
        { type: 'thought', text: 'checking' },
        { type: 'message', content: [{ type: 'text', text: ' world' }] },
      ],
    })
  })

  test('preserves thought placement when a snapshot corrects streamed text', () => {
    const state = reduceThreadState(initialThreadState('session-1'), [
      { type: 'turn_started', sessionId: 'session-1' },
      {
        type: 'assistant_content',
        id: 'assistant-1',
        sessionId: 'session-1',
        block: { type: 'text', text: 'draft' },
      },
      {
        type: 'assistant_thought',
        id: 'assistant-1',
        sessionId: 'session-1',
        text: 'correcting',
      },
      {
        type: 'assistant_content',
        id: 'assistant-1',
        sessionId: 'session-1',
        block: { type: 'text', text: ' answer' },
      },
      {
        type: 'assistant_snapshot',
        sessionId: 'session-1',
        id: 'assistant-1',
        content: [{ type: 'text', text: 'final answer' }],
      },
    ])

    expect(state.entries[0]).toMatchObject({
      chunks: [
        { type: 'message', content: [{ type: 'text', text: 'final answer' }] },
        { type: 'thought', text: 'correcting' },
      ],
    })
  })

  test('appends new snapshot media after streamed text without moving thoughts', () => {
    const image = { type: 'image' as const, mimeType: 'image/png', data: 'abc' }
    const resource = {
      type: 'resource_link' as const,
      uri: 'file:///report.md',
      name: 'report.md',
    }
    const state = reduceThreadState(initialThreadState('session-1'), [
      { type: 'turn_started', sessionId: 'session-1' },
      {
        type: 'assistant_content',
        id: 'assistant-1',
        sessionId: 'session-1',
        block: { type: 'text', text: 'Hello' },
      },
      {
        type: 'assistant_thought',
        id: 'assistant-1',
        sessionId: 'session-1',
        text: 'checking',
      },
      {
        type: 'assistant_content',
        id: 'assistant-1',
        sessionId: 'session-1',
        block: { type: 'text', text: ' world' },
      },
      {
        type: 'assistant_snapshot',
        sessionId: 'session-1',
        id: 'assistant-1',
        content: [{ type: 'text', text: 'Hello world' }, image, resource],
      },
    ])

    expect(state.entries[0]).toMatchObject({
      state: 'streaming',
      chunks: [
        { type: 'message', content: [{ type: 'text', text: 'Hello' }] },
        { type: 'thought', text: 'checking' },
        {
          type: 'message',
          content: [{ type: 'text', text: ' world' }, image, resource],
        },
      ],
    })
  })

  test('matches media snapshots independently of property insertion order', () => {
    const streamedImage = {
      type: 'image' as const,
      mimeType: 'image/png',
      data: 'abc',
      uri: 'file:///image.png',
    }
    const snapshotImage = {
      uri: 'file:///image.png',
      data: 'abc',
      mimeType: 'image/png',
      type: 'image' as const,
    }
    const streamedResource = {
      type: 'resource_link' as const,
      uri: 'file:///report.md',
      name: 'report.md',
      description: 'Report',
      mimeType: 'text/markdown',
      size: 42,
    }
    const snapshotResource = {
      size: 42,
      mimeType: 'text/markdown',
      description: 'Report',
      name: 'report.md',
      uri: 'file:///report.md',
      type: 'resource_link' as const,
    }
    const state = reduceThreadState(initialThreadState('session-1'), [
      { type: 'turn_started', sessionId: 'session-1' },
      {
        type: 'assistant_content',
        id: 'assistant-1',
        sessionId: 'session-1',
        block: { type: 'text', text: 'Hello' },
      },
      {
        type: 'assistant_content',
        id: 'assistant-1',
        sessionId: 'session-1',
        block: streamedImage,
      },
      {
        type: 'assistant_thought',
        id: 'assistant-1',
        sessionId: 'session-1',
        text: 'checking',
      },
      {
        type: 'assistant_content',
        id: 'assistant-1',
        sessionId: 'session-1',
        block: streamedResource,
      },
      {
        type: 'assistant_snapshot',
        sessionId: 'session-1',
        id: 'assistant-1',
        content: [
          { type: 'text', text: 'Hello' },
          snapshotImage,
          snapshotResource,
        ],
      },
    ])

    expect(state.entries[0]).toMatchObject({
      state: 'streaming',
      chunks: [
        {
          type: 'message',
          content: [{ type: 'text', text: 'Hello' }, streamedImage],
        },
        { type: 'thought', text: 'checking' },
        { type: 'message', content: [streamedResource] },
      ],
    })
  })

  test('applies a corrected snapshot after the turn completed', () => {
    const state = reduceThreadState(initialThreadState('session-1'), [
      { type: 'turn_started', sessionId: 'session-1' },
      {
        type: 'assistant_content',
        id: 'assistant-1',
        sessionId: 'session-1',
        block: { type: 'text', text: 'draft' },
      },
      {
        type: 'turn_completed',
        sessionId: 'session-1',
      },
      {
        type: 'assistant_snapshot',
        sessionId: 'session-1',
        id: 'assistant-1',
        content: [{ type: 'text', text: 'final answer' }],
      },
    ])

    expect(state.entries[0]).toEqual({
      type: 'assistant_message',
      id: 'assistant-1',
      state: 'completed',
      chunks: [
        { type: 'message', content: [{ type: 'text', text: 'final answer' }] },
      ],
    })
    expect(state.activeAssistantId).toBeNull()
    expect(state.phase).toBe('idle')
  })

  test('ignores actions for a stale session', () => {
    const state = initialThreadState('current')
    expect(
      threadStateReducer(state, {
        type: 'turn_started',
        sessionId: 'stale',
      }),
    ).toBe(state)
  })

  test('normalizes tool statuses and upserts tools by id', () => {
    expect(normalizeToolStatus('pending')).toBe('queued')
    expect(normalizeToolStatus('running')).toBe('in_progress')
    expect(normalizeToolStatus('complete')).toBe('completed')
    expect(normalizeToolStatus('result')).toBe('completed')
    expect(normalizeToolStatus('failed')).toBe('error')
    expect(normalizeToolStatus('canceled')).toBe('cancelled')

    const state = reduceThreadState(initialThreadState('session-1'), [
      {
        type: 'tool_upsert',
        sessionId: 'session-1',
        toolCall: { id: 'tool-1', title: 'Read', status: 'running' },
      },
      {
        type: 'tool_upsert',
        sessionId: 'session-1',
        toolCall: { id: 'tool-1', title: 'Read file', status: 'completed' },
      },
    ])

    expect(state.entries).toEqual([
      {
        type: 'tool_call',
        toolCall: { id: 'tool-1', title: 'Read file', status: 'completed' },
      },
    ])
  })

  test('merges partial tool updates and defaults new tools', () => {
    const content = [
      {
        type: 'content' as const,
        content: { type: 'text' as const, text: 'reading' },
      },
    ]
    const state = reduceThreadState(initialThreadState('session-1'), [
      {
        type: 'tool_upsert',
        sessionId: 'session-1',
        toolCall: {
          id: 'tool-1',
          title: 'Read',
          status: 'running',
          content,
          rawInput: { path: '/tmp/a' },
        },
      },
      {
        type: 'tool_upsert',
        sessionId: 'session-1',
        toolCall: {
          id: 'tool-1',
          status: 'completed',
          title: undefined,
          content: undefined,
        },
      },
      {
        type: 'tool_upsert',
        sessionId: 'session-1',
        toolCall: { id: 'tool-1', title: 'Read file', rawInput: undefined },
      },
      {
        type: 'tool_upsert',
        sessionId: 'session-1',
        toolCall: { id: 'tool-2' },
      },
    ])

    expect(state.entries).toEqual([
      {
        type: 'tool_call',
        toolCall: {
          id: 'tool-1',
          title: 'Read file',
          status: 'completed',
          content,
          rawInput: { path: '/tmp/a' },
        },
      },
      {
        type: 'tool_call',
        toolCall: { id: 'tool-2', title: 'tool-2', status: 'queued' },
      },
    ])
  })

  test('merges and explicitly clears permission request patches', () => {
    const state = reduceThreadState(initialThreadState('session-1'), [
      {
        type: 'tool_upsert',
        sessionId: 'session-1',
        toolCall: {
          id: 'tool-1',
          isStandalonePermission: true,
          permissionRequest: {
            requestId: 'request-1',
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
          },
        },
      },
      {
        type: 'tool_upsert',
        sessionId: 'session-1',
        toolCall: {
          id: 'tool-1',
          permissionRequest: { requestId: 'request-2' },
        },
      },
    ])

    expect(state.entries[0]).toMatchObject({
      type: 'tool_call',
      toolCall: {
        permissionRequest: {
          requestId: 'request-2',
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        },
      },
    })

    const cleared = threadStateReducer(state, {
      type: 'tool_upsert',
      sessionId: 'session-1',
      toolCall: {
        id: 'tool-1',
        permissionRequest: undefined,
        isStandalonePermission: undefined,
      },
    })
    expect(cleared.entries[0]).toEqual({
      type: 'tool_call',
      toolCall: { id: 'tool-1', title: 'tool-1', status: 'queued' },
    })
  })

  test('derives tool phase consistently from normalized status', () => {
    const created = reduceThreadState(initialThreadState('session-1'), [
      { type: 'turn_started', sessionId: 'session-1' },
      {
        type: 'assistant_content',
        sessionId: 'session-1',
        id: 'assistant-1',
        block: { type: 'text', text: 'working' },
      },
      {
        type: 'tool_upsert',
        sessionId: 'session-1',
        toolCall: { id: 'tool-1', status: 'running' },
      },
    ])
    expect(created.phase).toBe('using_tool')

    const completed = threadStateReducer(created, {
      type: 'tool_upsert',
      sessionId: 'session-1',
      toolCall: { id: 'tool-1', status: 'completed' },
    })
    expect(completed.phase).toBe('using_tool')
    expect(completed.activeAssistantId).toBe('assistant-1')
    expect(completed.entries[0]).toMatchObject({ state: 'streaming' })

    const responding = threadStateReducer(completed, {
      type: 'phase_changed',
      sessionId: 'session-1',
      phase: 'responding',
    })
    const failed = threadStateReducer(responding, {
      type: 'tool_upsert',
      sessionId: 'session-1',
      toolCall: { id: 'tool-1', status: 'error' },
    })
    expect(failed.phase).toBe('responding')

    const waiting = threadStateReducer(failed, {
      type: 'tool_upsert',
      sessionId: 'session-1',
      toolCall: { id: 'tool-1', status: 'waiting_for_confirmation' },
    })
    expect(waiting.phase).toBe('using_tool')
  })

  test('starts a turn without an empty assistant and creates it on first delta', () => {
    const started = threadStateReducer(initialThreadState('session-1'), {
      type: 'turn_started',
      sessionId: 'session-1',
    })
    expect(started.entries).toEqual([])
    expect(started.activeAssistantId).toBeNull()
    expect(started.phase).toBe('requesting')

    const responding = threadStateReducer(started, {
      type: 'assistant_content',
      sessionId: 'session-1',
      id: 'assistant-1',
      block: { type: 'text', text: 'hello' },
    })
    expect(responding.entries[0]).toMatchObject({
      type: 'assistant_message',
      id: 'assistant-1',
      state: 'streaming',
    })
    expect(responding.activeAssistantId).toBe('assistant-1')
    expect(responding.phase).toBe('responding')
  })

  test.each([
    ['turn_completed', 'completed', 'idle'],
    ['turn_cancelled', 'cancelled', 'idle'],
    ['turn_failed', 'error', 'error'],
  ] as const)('%s terminates the active assistant', (type:
    | 'turn_completed'
    | 'turn_cancelled'
    | 'turn_failed', assistantState: 'completed' | 'cancelled' | 'error', phase:
    | 'idle'
    | 'error') => {
    const active = reduceThreadState(initialThreadState('session-1'), [
      { type: 'turn_started', sessionId: 'session-1' },
      {
        type: 'assistant_content',
        sessionId: 'session-1',
        id: 'assistant-1',
        block: { type: 'text', text: 'hello' },
      },
    ])
    const state = threadStateReducer(active, { type, sessionId: 'session-1' })

    expect(state.entries[0]).toMatchObject({
      id: 'assistant-1',
      state: assistantState,
    })
    expect(state.activeAssistantId).toBeNull()
    expect(state.phase).toBe(phase)
  })

  test('assistant_stream_completed closes only the assistant stream', () => {
    const responding = reduceThreadState(initialThreadState('session-1'), [
      { type: 'turn_started', sessionId: 'session-1' },
      {
        type: 'assistant_content',
        sessionId: 'session-1',
        id: 'assistant-1',
        block: { type: 'text', text: 'done' },
      },
      { type: 'assistant_stream_completed', sessionId: 'session-1' },
    ])
    expect(responding.entries[0]).toMatchObject({ state: 'completed' })
    expect(responding.activeAssistantId).toBeNull()
    expect(responding.phase).toBe('responding')

    const usingTool = reduceThreadState(initialThreadState('session-1'), [
      { type: 'turn_started', sessionId: 'session-1' },
      {
        type: 'assistant_content',
        sessionId: 'session-1',
        id: 'assistant-1',
        block: { type: 'text', text: 'working' },
      },
      {
        type: 'tool_upsert',
        sessionId: 'session-1',
        toolCall: { id: 'tool-1', status: 'in_progress' },
      },
      { type: 'assistant_stream_completed', sessionId: 'session-1' },
    ])
    expect(usingTool.entries[0]).toMatchObject({ state: 'completed' })
    expect(usingTool.activeAssistantId).toBeNull()
    expect(usingTool.phase).toBe('using_tool')
  })

  test('represents optimistic user delivery and preserves ACP chunk order', () => {
    const optimistic = reduceThreadState(initialThreadState('session-1'), [
      {
        type: 'user_message_added',
        sessionId: 'session-1',
        entry: {
          type: 'user_message',
          id: 'optimistic-1',
          content: [{ type: 'text', text: 'prompt' }],
          deliveryState: 'sending',
        },
      },
      {
        type: 'user_message_delivery',
        sessionId: 'session-1',
        id: 'optimistic-1',
        deliveryState: 'sent',
      },
    ])
    expect(optimistic.entries[0]).toEqual({
      type: 'user_message',
      id: 'optimistic-1',
      content: [{ type: 'text', text: 'prompt' }],
      deliveryState: 'sent',
    })

    const chunks = reduceThreadState(initialThreadState('session-1'), [
      {
        type: 'user_content',
        sessionId: 'session-1',
        id: 'history-1',
        block: { type: 'text', text: 'a' },
      },
      {
        type: 'user_content',
        sessionId: 'session-1',
        id: 'history-1',
        block: { type: 'image', mimeType: 'image/png', data: 'abc' },
      },
      {
        type: 'user_content',
        sessionId: 'session-1',
        id: 'history-1',
        block: { type: 'text', text: 'b' },
      },
    ])

    expect(chunks.entries).toEqual([
      {
        type: 'user_message',
        id: 'history-1',
        content: [
          { type: 'text', text: 'a' },
          { type: 'image', mimeType: 'image/png', data: 'abc' },
          { type: 'text', text: 'b' },
        ],
        deliveryState: 'sent',
      },
    ])

    const failed = threadStateReducer(optimistic, {
      type: 'user_message_delivery',
      sessionId: 'session-1',
      id: 'optimistic-1',
      deliveryState: 'failed',
    })
    expect(failed.entries[0]).toMatchObject({ deliveryState: 'failed' })
  })

  test('replaces the last plan and removes plans for empty entries', () => {
    const planEntry = {
      content: 'Ship it',
      priority: 'high' as const,
      status: 'in_progress' as const,
    }
    const state = reduceThreadState(initialThreadState('session-1'), [
      {
        type: 'plan_replace',
        sessionId: 'session-1',
        id: 'plan-1',
        entries: [planEntry],
      },
      {
        type: 'plan_replace',
        sessionId: 'session-1',
        id: 'plan-2',
        entries: [{ ...planEntry, content: 'Verify it' }],
      },
    ])
    expect(state.entries).toEqual([
      {
        type: 'plan',
        id: 'plan-1',
        entries: [{ ...planEntry, content: 'Verify it' }],
      },
    ])

    const removed = threadStateReducer(state, {
      type: 'plan_remove',
      sessionId: 'session-1',
    })
    expect(removed.entries).toEqual([])
  })
})

describe('acpUpdateToThreadActions', () => {
  const map = (update: SessionUpdate, assistantId = 'assistant-stable') =>
    acpUpdateToThreadActions('session-1', update, assistantId)

  test('maps assistant renderable blocks with a stable assistant id', () => {
    const image = { type: 'image' as const, mimeType: 'image/png', data: 'abc' }
    const resource = {
      type: 'resource_link' as const,
      uri: 'file:///report.md',
      name: 'report.md',
    }
    expect(
      map({ sessionUpdate: 'agent_message_chunk', content: image }),
    ).toEqual([
      {
        type: 'assistant_content',
        sessionId: 'session-1',
        id: 'assistant-stable',
        block: image,
      },
    ])
    expect(
      map({ sessionUpdate: 'agent_message_chunk', content: resource }),
    ).toEqual([
      {
        type: 'assistant_content',
        sessionId: 'session-1',
        id: 'assistant-stable',
        block: resource,
      },
    ])
  })

  test('maps text, thinking, and user non-text chunks', () => {
    expect(
      map({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      }),
    ).toEqual([
      {
        type: 'assistant_content',
        sessionId: 'session-1',
        id: 'assistant-stable',
        block: { type: 'text', text: 'hello' },
      },
    ])
    expect(
      map({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thinking' },
      }),
    ).toEqual([
      {
        type: 'assistant_thought',
        sessionId: 'session-1',
        id: 'assistant-stable',
        text: 'thinking',
      },
    ])
    expect(
      map({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'image', mimeType: 'image/png', data: 'abc' },
      }),
    ).toEqual([
      {
        type: 'user_content',
        sessionId: 'session-1',
        id: expect.any(String),
        block: { type: 'image', mimeType: 'image/png', data: 'abc' },
      },
    ])
    expect(
      map({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'history' },
      }),
    ).toEqual([
      {
        type: 'user_content',
        sessionId: 'session-1',
        id: expect.any(String),
        block: { type: 'text', text: 'history' },
      },
    ])
    expect(
      map({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'resource_link', uri: 'file:///a', name: 'a' },
      }),
    ).toEqual([
      {
        type: 'user_content',
        sessionId: 'session-1',
        id: expect.any(String),
        block: { type: 'resource_link', uri: 'file:///a', name: 'a' },
      },
    ])
  })

  test('maps tool updates as partial upserts without inventing fields', () => {
    expect(
      map({
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Read',
        status: 'in_progress',
        rawInput: { path: '/tmp/a' },
      }),
    ).toEqual([
      {
        type: 'tool_upsert',
        sessionId: 'session-1',
        toolCall: {
          id: 'tool-1',
          title: 'Read',
          status: 'in_progress',
          rawInput: { path: '/tmp/a' },
        },
      },
    ])
    expect(
      map({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'completed',
        title: undefined,
        content: undefined,
      }),
    ).toEqual([
      {
        type: 'tool_upsert',
        sessionId: 'session-1',
        toolCall: { id: 'tool-1', status: 'completed' },
      },
    ])
  })

  test('maps plan replacement/removal and ignores unknown blocks', () => {
    const entry = {
      content: 'Do it',
      priority: 'medium' as const,
      status: 'pending' as const,
    }
    expect(map({ sessionUpdate: 'plan', entries: [entry] })).toEqual([
      {
        type: 'plan_replace',
        sessionId: 'session-1',
        id: expect.any(String),
        entries: [entry],
      },
    ])
    expect(map({ sessionUpdate: 'plan', entries: [] })).toEqual([
      { type: 'plan_remove', sessionId: 'session-1' },
    ])
    expect(
      map({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'unsupported' },
      }),
    ).toEqual([])
    expect(
      map({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'image', mimeType: 'image/png', data: 'x' },
      }),
    ).toEqual([])
  })

  test('keeps assistant identity in reducer state across stale updates', () => {
    let state = initialThreadState('new-session')
    state = reduceThreadState(
      state,
      acpUpdateToThreadActions('new-session', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'first' },
      }),
    )
    const assistantId = state.activeAssistantId
    expect(assistantId).toEqual(expect.any(String))

    state = reduceThreadState(
      state,
      acpUpdateToThreadActions('old-session', {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'stale' },
      }),
    )
    state = reduceThreadState(
      state,
      acpUpdateToThreadActions(
        'new-session',
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: ' second' },
        },
        state.activeAssistantId ?? undefined,
      ),
    )

    expect(state.activeAssistantId).toBe(assistantId)
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0]).toMatchObject({
      id: assistantId,
      chunks: [
        { type: 'message', content: [{ type: 'text', text: 'first second' }] },
      ],
    })
  })

  test('creates an assistant for a restored session without a local submit', () => {
    const state = reduceThreadState(
      initialThreadState('restored'),
      acpUpdateToThreadActions('restored', {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'replayed thought' },
      }),
    )
    expect(state.activeAssistantId).toEqual(expect.any(String))
    expect(state.entries[0]).toMatchObject({
      id: state.activeAssistantId,
      state: 'streaming',
    })
  })

  test('separates replayed assistant turns and completes the final replay turn', () => {
    let state = initialThreadState('replay')
    const replay = (update: SessionUpdate) => {
      state = reduceThreadState(
        state,
        acpUpdateToThreadActionsForState(state, 'replay', update),
      )
    }

    replay({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'first question' },
    })
    replay({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'first answer' },
    })
    replay({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'second question' },
    })
    replay({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'second answer' },
    })
    state = reduceThreadState(
      state,
      acpHistoryReplayCompletedActions(state, 'replay'),
    )

    expect(state.phase).toBe('idle')
    expect(state.activeAssistantId).toBeNull()
    expect(state.entries.map(entry => entry.type)).toEqual([
      'user_message',
      'assistant_message',
      'user_message',
      'assistant_message',
    ])
    const assistants = state.entries.filter(
      entry => entry.type === 'assistant_message',
    )
    expect(assistants).toHaveLength(2)
    expect(assistants[0]?.id).not.toBe(assistants[1]?.id)
    expect(assistants.map(entry => entry.state)).toEqual([
      'completed',
      'completed',
    ])
  })

  test('uses message ids to preserve assistant and tool ordering', () => {
    let state = initialThreadState('session-1')
    const update = (value: SessionUpdate) => {
      state = reduceThreadState(
        state,
        acpUpdateToThreadActionsForState(state, 'session-1', value),
      )
    }

    update({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm1',
      content: { type: 'text', text: 'first' },
    })
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Read',
      status: 'completed',
    })
    update({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm2',
      content: { type: 'text', text: 'second' },
    })
    update({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm2',
      content: { type: 'image', mimeType: 'image/png', data: 'image' },
    })

    expect(state.entries.map(entry => entry.type)).toEqual([
      'assistant_message',
      'tool_call',
      'assistant_message',
    ])
    expect(state.entries[0]).toMatchObject({ id: 'm1', state: 'completed' })
    expect(state.entries[2]).toMatchObject({
      id: 'm2',
      state: 'streaming',
      chunks: [
        {
          type: 'message',
          content: [
            { type: 'text', text: 'second' },
            { type: 'image', mimeType: 'image/png', data: 'image' },
          ],
        },
      ],
    })
  })

  test('merges user blocks only when their message ids match', () => {
    let state = initialThreadState('session-1')
    for (const update of [
      {
        sessionUpdate: 'user_message_chunk' as const,
        messageId: 'u1',
        content: { type: 'text' as const, text: 'one' },
      },
      {
        sessionUpdate: 'user_message_chunk' as const,
        messageId: 'u1',
        content: {
          type: 'image' as const,
          mimeType: 'image/png',
          data: 'image',
        },
      },
      {
        sessionUpdate: 'user_message_chunk' as const,
        messageId: 'u2',
        content: { type: 'text' as const, text: 'two' },
      },
    ]) {
      state = reduceThreadState(
        state,
        acpUpdateToThreadActionsForState(state, 'session-1', update),
      )
    }

    expect(state.entries).toMatchObject([
      { id: 'u1', content: [{ type: 'text' }, { type: 'image' }] },
      { id: 'u2', content: [{ type: 'text', text: 'two' }] },
    ])
  })
})

describe('submitAcpPrompt', () => {
  test('starts before image preparation and renders the prepared blocks it sends', async () => {
    let state = initialThreadState('session-1')
    let finishPreparation: (image: {
      type: 'image'
      mimeType: string
      data: string
    }) => void = () => {}
    const sent: unknown[] = []
    const submission = submitAcpPrompt({
      sessionId: 'session-1',
      userId: 'user-1',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
      ],
      prepareImage: () =>
        new Promise(resolve => {
          finishPreparation = resolve
        }),
      sendPrompt: async content => {
        sent.push(content)
      },
      dispatch: action => {
        state = threadStateReducer(state, action)
      },
    })

    expect(state.phase).toBe('requesting')
    expect(state.entries).toEqual([])
    finishPreparation({
      type: 'image',
      mimeType: 'image/jpeg',
      data: '/9j/',
    })
    await submission

    const prepared: RenderableContentBlock[] = [
      { type: 'text', text: 'look' },
      { type: 'image', mimeType: 'image/jpeg', data: '/9j/' },
    ]
    expect(sent).toEqual([prepared])
    expect(state.entries[0]).toEqual({
      type: 'user_message',
      id: 'user-1',
      content: prepared,
      deliveryState: 'sent',
    })
  })

  test('records the original input as failed and does not send when preparation fails', async () => {
    let state = initialThreadState('session-1')
    let sendCount = 0
    const result = await submitAcpPrompt({
      sessionId: 'session-1',
      userId: 'user-1',
      content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }],
      prepareImage: async () => {
        throw new Error('compression failed')
      },
      sendPrompt: async () => {
        sendCount++
      },
      dispatch: action => {
        state = threadStateReducer(state, action)
      },
    })

    expect(sendCount).toBe(0)
    expect(acpPromptFailureMessage(result)).toBe(
      'Could not prepare image: compression failed',
    )
    expect(state.phase).toBe('error')
    expect(state.entries[0]).toMatchObject({
      content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }],
      deliveryState: 'failed',
    })
  })

  test('marks prepared content failed when send throws', async () => {
    let state = initialThreadState('session-1')
    const result = await submitAcpPrompt({
      sessionId: 'session-1',
      userId: 'user-1',
      content: [{ type: 'text', text: 'hello' }],
      prepareImage: async image => image,
      sendPrompt: async () => {
        throw new Error('send failed')
      },
      dispatch: action => {
        state = threadStateReducer(state, action)
      },
    })

    expect(state.phase).toBe('error')
    expect(acpPromptFailureMessage(result)).toBe(
      'Could not send message: send failed',
    )
    expect(state.entries[0]).toMatchObject({
      content: [{ type: 'text', text: 'hello' }],
      deliveryState: 'failed',
    })
  })

  test('prevalidates every image before preparing any of them', async () => {
    let prepareCount = 0
    let sendCount = 0
    const result = await submitAcpPrompt({
      sessionId: 'session-1',
      content: [
        { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
        { type: 'image', mimeType: 'image/svg+xml', data: 'unsupported' },
      ],
      prepareImage: async image => {
        prepareCount++
        return image
      },
      sendPrompt: async () => {
        sendCount++
      },
      dispatch: () => {},
    })

    expect(result.status).toBe('prepare_failed')
    expect(prepareCount).toBe(0)
    expect(sendCount).toBe(0)
    expect(acpPromptFailureMessage(result)).toBe(
      'Could not prepare image: Unsupported image type "image/svg+xml". Use JPEG, PNG, GIF, or WebP.',
    )
  })

  test('rejects malformed base64 before preparing any ACP image', async () => {
    let prepareCount = 0
    let sendCount = 0
    const result = await submitAcpPrompt({
      sessionId: 'session-1',
      content: [
        { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
        { type: 'image', mimeType: 'image/png', data: 'bad===' },
      ],
      prepareImage: async image => {
        prepareCount++
        return image
      },
      sendPrompt: async () => {
        sendCount++
      },
      dispatch: () => {},
    })
    expect(result.status).toBe('prepare_failed')
    expect(prepareCount).toBe(0)
    expect(sendCount).toBe(0)
  })

  test('rejects base64 whose bytes do not match the declared ACP image type', async () => {
    let prepareCount = 0
    const result = await submitAcpPrompt({
      sessionId: 'session-1',
      content: [{ type: 'image', mimeType: 'image/png', data: 'YWJj' }],
      prepareImage: async image => {
        prepareCount++
        return image
      },
      sendPrompt: async () => {},
      dispatch: () => {},
    })
    expect(result.status).toBe('prepare_failed')
    expect(prepareCount).toBe(0)
  })

  test('validates prepared ACP images again before upstream send', async () => {
    let sendCount = 0
    const result = await submitAcpPrompt({
      sessionId: 'session-1',
      content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }],
      prepareImage: async () => ({
        type: 'image',
        mimeType: 'image/svg+xml',
        data: 'PHN2Zz4=',
      }),
      sendPrompt: async () => {
        sendCount++
      },
      dispatch: () => {},
    })
    expect(result.status).toBe('prepare_failed')
    expect(sendCount).toBe(0)
  })
})

describe('ACP control helpers', () => {
  test('cancels queued, active, and waiting tools while preserving terminal tools', () => {
    const state = reduceThreadState(initialThreadState('session-1'), [
      {
        type: 'tool_upsert',
        sessionId: 'session-1',
        toolCall: { id: 'queued', status: 'queued' },
      },
      {
        type: 'tool_upsert',
        sessionId: 'session-1',
        toolCall: { id: 'active', status: 'in_progress' },
      },
      {
        type: 'tool_upsert',
        sessionId: 'session-1',
        toolCall: {
          id: 'waiting',
          status: 'waiting_for_confirmation',
          permissionRequest: { requestId: 'request-1', options: [] },
        },
      },
      {
        type: 'tool_upsert',
        sessionId: 'session-1',
        toolCall: { id: 'done', status: 'completed' },
      },
    ])
    const cancelled = reduceThreadState(state, cancelThreadActions(state))

    expect(cancelled.phase).toBe('cancelling')
    expect(
      cancelled.entries
        .filter(entry => entry.type === 'tool_call')
        .map(entry => [
          entry.toolCall.id,
          entry.toolCall.status,
          entry.toolCall.permissionRequest,
        ]),
    ).toEqual([
      ['queued', 'cancelled', undefined],
      ['active', 'cancelled', undefined],
      ['waiting', 'cancelled', undefined],
      ['done', 'completed', undefined],
    ])
  })

  test('treats a missing permission option as rejected rather than approved', () => {
    expect(permissionResponseToolStatus(null, 'allow_once', false)).toBe(
      'rejected',
    )
    expect(permissionResponseToolStatus('allow', 'allow_once', false)).toBe(
      'in_progress',
    )
    expect(permissionResponseToolStatus('allow', 'allow_once', true)).toBe(
      'completed',
    )
  })

  test('keeps stale and uncorrelated errors from failing the current session', () => {
    const current = reduceThreadState(initialThreadState('session-new'), [
      { type: 'turn_started', sessionId: 'session-new' },
    ])

    expect(
      reduceThreadState(current, acpErrorToThreadActions('session-old')),
    ).toEqual(current)
    expect(acpErrorToThreadActions(undefined)).toEqual([])
    expect(
      reduceThreadState(current, acpErrorToThreadActions('session-new')).phase,
    ).toBe('error')
    expect(shouldHandleAcpError('session-new', 'session-old')).toBe(false)
    expect(shouldHandleAcpError('session-new', undefined)).toBe(true)
  })
})

describe('toRenderableContentBlock', () => {
  test('accepts renderable blocks and rejects unsupported blocks', () => {
    expect(toRenderableContentBlock({ type: 'text', text: 'hello' })).toEqual({
      type: 'text',
      text: 'hello',
    })
    expect(
      toRenderableContentBlock({ type: 'tool_use', id: 'tool-1' }),
    ).toBeNull()
  })

  test('reconstructs blocks without leaking invalid optional fields', () => {
    const image = {
      type: 'image',
      mimeType: 'image/png',
      data: 'abc',
      uri: 42,
      extra: 'discarded',
    }
    const resource = {
      type: 'resource_link',
      uri: 'file:///report.md',
      name: 'report.md',
      title: 42,
      description: 'Report',
      mimeType: null,
      size: '42',
    }

    expect(toRenderableContentBlock(image)).toEqual({
      type: 'image',
      mimeType: 'image/png',
      data: 'abc',
    })
    expect(toRenderableContentBlock(resource)).toEqual({
      type: 'resource_link',
      uri: 'file:///report.md',
      name: 'report.md',
      description: 'Report',
      mimeType: null,
    })
  })

  test('preserves audio and marks only strict allowlisted base64 as playable', () => {
    const audio = {
      type: 'audio' as const,
      mimeType: 'audio/mpeg',
      data: '//uQZA==',
      annotations: { audience: ['user'] as Array<'user'> },
      _meta: { source: 'fixture' },
    }
    expect(toRenderableContentBlock(audio)).toEqual({
      type: 'audio',
      mimeType: 'audio/mpeg',
      data: '//uQZA==',
      annotations: { audience: ['user'] },
      _meta: { source: 'fixture' },
      playable: true,
    })
    expect(
      acpUpdateToThreadActions('session-1', {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'assistant-audio',
        content: audio,
      }),
    ).toEqual([
      {
        type: 'assistant_content',
        sessionId: 'session-1',
        id: 'assistant-audio',
        block: {
          ...audio,
          playable: true,
        },
      },
    ])
    expect(
      toRenderableContentBlock({
        type: 'audio',
        mimeType: 'text/html',
        data: 'PHNjcmlwdD4=',
      }),
    ).toMatchObject({ type: 'audio', playable: false })
    expect(
      toRenderableContentBlock({
        type: 'audio',
        mimeType: 'audio/mpeg',
        data: 'bad base64!',
      }),
    ).toMatchObject({ type: 'audio', playable: false })
  })

  test('preserves ACP metadata on every renderable content shape and sanitizes optional fields', () => {
    const annotations = {
      _meta: { annotation: true },
      audience: ['user'] as Array<'user'>,
      lastModified: '2026-08-26T00:00:00Z',
      priority: 0.5,
    }
    const meta = { traceId: 'trace-1' }
    const metadata = { annotations, _meta: meta }
    const blocks = [
      { type: 'text', text: 'hello', ...metadata },
      {
        type: 'image',
        mimeType: 'image/png',
        data: 'abc',
        uri: null,
        ...metadata,
      },
      { type: 'audio', mimeType: 'audio/mpeg', data: '//uQZA==', ...metadata },
      {
        type: 'resource_link',
        uri: 'file:///report.md',
        name: 'report.md',
        icons: [
          {
            src: 'https://example.test/icon.png',
            mimeType: 'image/png',
            sizes: ['32x32'],
            theme: 'dark',
            extra: 'discarded',
          },
          { src: 42 },
        ],
        ...metadata,
      },
      {
        type: 'resource',
        resource: {
          uri: 'memory://notes.txt',
          mimeType: 'text/plain',
          text: 'notes',
          _meta: { resource: true },
          extra: 'discarded',
        },
        ...metadata,
      },
      {
        type: 'resource',
        resource: {
          uri: 'memory://archive.bin',
          blob: 'YmluYXJ5',
          _meta: { resource: true },
        },
        ...metadata,
      },
    ]

    expect(blocks.map(toRenderableContentBlock)).toEqual([
      { type: 'text', text: 'hello', ...metadata },
      {
        type: 'image',
        mimeType: 'image/png',
        data: 'abc',
        uri: null,
        ...metadata,
      },
      {
        type: 'audio',
        mimeType: 'audio/mpeg',
        data: '//uQZA==',
        playable: true,
        ...metadata,
      },
      {
        type: 'resource_link',
        uri: 'file:///report.md',
        name: 'report.md',
        icons: [
          {
            src: 'https://example.test/icon.png',
            mimeType: 'image/png',
            sizes: ['32x32'],
            theme: 'dark',
          },
        ],
        ...metadata,
      },
      {
        type: 'resource',
        resource: {
          uri: 'memory://notes.txt',
          mimeType: 'text/plain',
          text: 'notes',
          _meta: { resource: true },
        },
        ...metadata,
      },
      {
        type: 'resource',
        resource: {
          uri: 'memory://archive.bin',
          blob: 'YmluYXJ5',
          _meta: { resource: true },
        },
        ...metadata,
      },
    ])

    expect(
      toRenderableContentBlock({
        type: 'resource_link',
        uri: 'file:///invalid',
        name: 'invalid',
        annotations: { audience: ['system'], priority: 'high', extra: true },
        _meta: 'invalid',
        icons: [{ src: 'icon.png', sizes: [42], theme: 'sepia', extra: true }],
      }),
    ).toEqual({
      type: 'resource_link',
      uri: 'file:///invalid',
      name: 'invalid',
      annotations: {},
      icons: [{ src: 'icon.png' }],
    })
  })

  test('preserves embedded text and blob resources through ACP updates', () => {
    const textResource = {
      type: 'resource' as const,
      resource: {
        uri: 'memory://notes.txt',
        mimeType: 'text/plain',
        text: 'notes',
      },
    }
    const blobResource = {
      type: 'resource' as const,
      resource: {
        uri: 'memory://archive.bin',
        mimeType: 'application/octet-stream',
        blob: 'YmluYXJ5',
      },
    }

    expect(toRenderableContentBlock(textResource)).toEqual(textResource)
    expect(
      acpUpdateToThreadActions('session-1', {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'assistant-1',
        content: blobResource,
      }),
    ).toEqual([
      {
        type: 'assistant_content',
        sessionId: 'session-1',
        id: 'assistant-1',
        block: blobResource,
      },
    ])
  })
})
