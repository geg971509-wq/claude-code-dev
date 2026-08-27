import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { normalizePayload } from '../../../src/services/transport'
import type { SessionEvent } from '../types'
import {
  initialThreadState,
  threadStateReducer,
  type ThreadState,
  type ThreadStateAction,
} from '../lib/thread-state'

const sentEvents: Array<{ sessionId: string; body: Record<string, unknown> }> =
  []
let sendError: Error | null = null
let controlError: Error | null = null
let historyEvents: SessionEvent[] = []
let bindImpl: (sessionId: string) => Promise<void> = async () => {}
let historyImpl: (sessionId: string) => Promise<{ events: SessionEvent[] }> =
  async () => ({
    events: historyEvents,
  })

mock.module('../api/client', () => ({
  apiBind: (sessionId: string) => bindImpl(sessionId),
  apiFetchSession: async () => ({ status: 'active' }),
  apiFetchSessionHistory: (sessionId: string) => historyImpl(sessionId),
  apiSendEvent: async (sessionId: string, body: Record<string, unknown>) => {
    sentEvents.push({ sessionId, body })
    if (sendError) throw sendError
  },
  apiSendControl: async () => {
    if (controlError) throw controlError
  },
  apiInterrupt: async () => {},
  getUuid: () => 'browser-uuid',
}))

const { RCSChatAdapter } = await import('../lib/rcs-chat-adapter')

function harness(sessionId = 'session-1') {
  let state = initialThreadState(sessionId)
  const actions: ThreadStateAction[] = []
  const dispatch = (action: ThreadStateAction) => {
    actions.push(action)
    state = threadStateReducer(state, action)
  }
  const adapter = new RCSChatAdapter(sessionId, dispatch, () => state)
  return {
    adapter,
    actions,
    dispatch,
    get state(): ThreadState {
      return state
    },
  }
}

function stream(event: Record<string, unknown>, legacy = false): SessionEvent {
  return {
    id: `event-${event.type}`,
    type: legacy ? 'partial_assistant' : 'stream_event',
    direction: 'inbound',
    payload: { event },
  }
}

describe('RCSChatAdapter', () => {
  beforeEach(() => {
    sentEvents.length = 0
    sendError = null
    controlError = null
    historyEvents = []
    bindImpl = async () => {}
    historyImpl = async () => ({ events: historyEvents })
  })

  test('uses one stream path for text, thinking, tool JSON, and legacy events', () => {
    const h = harness()
    h.adapter.handleEvent(
      stream({ type: 'message_start', message: { id: 'm1', content: [] } }),
    )
    h.adapter.handleEvent(
      stream({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      }),
    )
    h.adapter.handleEvent(
      stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'check' },
      }),
    )
    h.adapter.handleEvent(
      stream(
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        },
        true,
      ),
    )
    h.adapter.handleEvent(
      stream(
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'answer' },
        },
        true,
      ),
    )
    h.adapter.handleEvent(
      stream({
        type: 'content_block_start',
        index: 2,
        content_block: {
          type: 'tool_use',
          id: 'tool-1',
          name: 'Read',
          input: {},
        },
      }),
    )
    h.adapter.handleEvent(
      stream({
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '{"file_' },
      }),
    )
    h.adapter.handleEvent(
      stream({
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: 'path":"a"}' },
      }),
    )
    h.adapter.handleEvent(stream({ type: 'content_block_stop', index: 2 }))
    h.adapter.handleEvent(
      stream({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
    )

    expect(h.state.phase).toBe('using_tool')
    expect(h.state.entries).toEqual([
      {
        type: 'assistant_message',
        id: 'm1',
        state: 'streaming',
        chunks: [
          { type: 'thought', text: 'check' },
          { type: 'message', content: [{ type: 'text', text: 'answer' }] },
        ],
      },
      {
        type: 'tool_call',
        toolCall: {
          id: 'tool-1',
          title: 'Read',
          status: 'in_progress',
          rawInput: { file_path: 'a' },
        },
      },
    ])

    h.adapter.handleEvent(stream({ type: 'message_stop' }))
    expect(h.state.phase).toBe('using_tool')
    expect(h.state.entries[0]).toMatchObject({ state: 'completed' })
  })

  test('message_stop completes only the assistant stream until result arrives', () => {
    const h = harness()
    h.adapter.handleEvent(
      stream({ type: 'message_start', message: { id: 'm1', content: [] } }),
    )
    h.adapter.handleEvent(
      stream({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: 'answer' },
      }),
    )
    h.adapter.handleEvent(stream({ type: 'message_stop' }))
    expect(h.state.entries[0]).toMatchObject({ state: 'completed' })
    expect(h.state.phase).toBe('responding')
    expect(h.actions[h.actions.length - 1]).toEqual({
      type: 'assistant_stream_completed',
      sessionId: 'session-1',
    })

    h.adapter.handleEvent({ id: 'result', type: 'result', payload: {} })
    expect(h.state.phase).toBe('idle')
  })

  test('ignores deltas without a matching indexed block start', () => {
    const h = harness()
    h.adapter.handleEvent(
      stream({ type: 'message_start', message: { id: 'm1', content: [] } }),
    )
    h.adapter.handleEvent(
      stream({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      }),
    )
    for (const event of [
      { index: 4, delta: { type: 'text_delta', text: 'missing' } },
      { index: 0, delta: { type: 'text_delta', text: 'wrong kind' } },
      { index: 4, delta: { type: 'thinking_delta', thinking: 'missing' } },
    ]) {
      h.adapter.handleEvent(stream({ type: 'content_block_delta', ...event }))
    }
    expect(h.state.entries).toEqual([])
  })

  test('reads legacy stream events retained only in normalized raw payloads', () => {
    const h = harness()
    h.adapter.handleEvent({
      id: 'legacy-start',
      type: 'partial_assistant',
      direction: 'inbound',
      payload: {
        raw: {
          event: {
            type: 'message_start',
            message: { id: 'legacy-m1', content: [] },
          },
        },
      },
    })
    h.adapter.handleEvent({
      id: 'legacy-start-block',
      type: 'partial_assistant',
      direction: 'inbound',
      payload: {
        raw: {
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          },
        },
      },
    })
    h.adapter.handleEvent({
      id: 'legacy-delta',
      type: 'partial_assistant',
      direction: 'inbound',
      payload: {
        raw: {
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'legacy' },
          },
        },
      },
    })

    expect(h.state.entries[0]).toMatchObject({
      id: 'legacy-m1',
      chunks: [
        { type: 'message', content: [{ type: 'text', text: 'legacy' }] },
      ],
    })
  })

  test('consumes nonempty text and thinking from content block starts', () => {
    const h = harness()
    h.adapter.handleEvent(
      stream({ type: 'message_start', message: { id: 'm1', content: [] } }),
    )
    h.adapter.handleEvent(
      stream({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: 'seed thought' },
      }),
    )
    h.adapter.handleEvent(
      stream({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: 'seed text' },
      }),
    )

    expect(h.state.entries[0]).toMatchObject({
      chunks: [
        { type: 'thought', text: 'seed thought' },
        { type: 'message', content: [{ type: 'text', text: 'seed text' }] },
      ],
    })
  })

  test('consumes allowlisted base64 audio from content block starts', () => {
    const h = harness()
    h.adapter.handleEvent(
      stream({
        type: 'message_start',
        message: { id: 'audio-message', content: [] },
      }),
    )
    h.adapter.handleEvent(
      stream({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'audio',
          source: { type: 'base64', media_type: 'audio/ogg', data: 'T2dnUw==' },
          annotations: { audience: ['assistant'], priority: 0.75 },
          _meta: { stream: true },
        },
      }),
    )

    expect(h.state.entries[0]).toMatchObject({
      id: 'audio-message',
      chunks: [
        {
          type: 'message',
          content: [
            {
              type: 'audio',
              mimeType: 'audio/ogg',
              data: 'T2dnUw==',
              playable: true,
              annotations: { audience: ['assistant'], priority: 0.75 },
              _meta: { stream: true },
            },
          ],
        },
      ],
    })
  })

  test('reconciles final snapshots without duplication and preserves m1/tool/m2 order', () => {
    const h = harness()
    h.adapter.handleEvent(
      stream({ type: 'message_start', message: { id: 'm1', content: [] } }),
    )
    h.adapter.handleEvent(
      stream({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
    )
    h.adapter.handleEvent(
      stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'one' },
      }),
    )
    h.adapter.handleEvent({
      id: 'snapshot-1',
      type: 'assistant',
      direction: 'inbound',
      payload: {
        message: {
          id: 'm1',
          role: 'assistant',
          content: [
            { type: 'text', text: 'one' },
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Read',
              input: { file_path: 'a' },
            },
          ],
        },
      },
    })
    h.adapter.handleEvent({
      id: 'snapshot-2',
      type: 'assistant',
      direction: 'inbound',
      payload: {
        message: {
          id: 'm2',
          role: 'assistant',
          content: [{ type: 'text', text: 'two' }],
        },
      },
    })

    expect(
      h.state.entries.map(entry =>
        entry.type === 'tool_call' ? entry.toolCall.id : entry.id,
      ),
    ).toEqual(['m1', 'tool-1', 'm2'])
    expect(h.state.entries[0]).toMatchObject({
      chunks: [{ type: 'message', content: [{ type: 'text', text: 'one' }] }],
    })
  })

  test('applies a late full snapshot without reopening a completed turn', () => {
    const h = harness()
    h.adapter.handleEvent(
      stream({ type: 'message_start', message: { id: 'm1', content: [] } }),
    )
    h.adapter.handleEvent(
      stream({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
    )
    h.adapter.handleEvent(
      stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'draft' },
      }),
    )
    h.adapter.handleEvent(stream({ type: 'message_stop' }))
    h.adapter.handleEvent({ id: 'result', type: 'result', payload: {} })

    h.adapter.handleEvent({
      id: 'snapshot',
      type: 'assistant',
      direction: 'inbound',
      payload: {
        message: {
          id: 'm1',
          role: 'assistant',
          content: [
            { type: 'text', text: 'final' },
            { type: 'thinking', thinking: 'final thought' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'abc' },
            },
            {
              type: 'audio',
              data: '//uQZA==',
              mimeType: 'audio/mpeg',
              annotations: { audience: ['user'] },
              _meta: { snapshot: true },
            },
            {
              type: 'resource_link',
              uri: 'file:///report.md',
              name: 'report.md',
            },
            {
              type: 'resource',
              resource: {
                uri: 'memory://notes.txt',
                mimeType: 'text/plain',
                text: 'embedded notes',
              },
            },
          ],
        },
      },
    })

    expect(h.state.phase).toBe('idle')
    expect(h.state.activeAssistantId).toBeNull()
    expect(h.state.entries[0]).toMatchObject({
      state: 'completed',
      chunks: [
        {
          type: 'message',
          content: [{ type: 'text', text: 'final' }],
        },
        { type: 'thought', text: 'final thought' },
        {
          type: 'message',
          content: [
            { type: 'image', mimeType: 'image/png', data: 'abc' },
            {
              type: 'audio',
              mimeType: 'audio/mpeg',
              data: '//uQZA==',
              playable: true,
              annotations: { audience: ['user'] },
              _meta: { snapshot: true },
            },
            {
              type: 'resource_link',
              uri: 'file:///report.md',
              name: 'report.md',
            },
            {
              type: 'resource',
              resource: {
                uri: 'memory://notes.txt',
                mimeType: 'text/plain',
                text: 'embedded notes',
              },
            },
          ],
        },
      ],
    })
  })

  test('associates parallel permission requests by tool_use_id', () => {
    const h = harness()
    for (const id of ['tool-a', 'tool-b']) {
      h.adapter.handleEvent({
        id,
        type: 'tool_use',
        payload: { tool_call_id: id, tool_name: 'Read', tool_input: {} },
      })
    }
    h.adapter.handleEvent({
      id: 'permission-a',
      type: 'control_request',
      payload: {
        request_id: 'request-a',
        request: {
          subtype: 'can_use_tool',
          tool_use_id: 'tool-a',
          tool_name: 'Read',
          input: {},
        },
      },
    })

    expect(h.state.entries[0]).toMatchObject({
      toolCall: { id: 'tool-a', status: 'waiting_for_confirmation' },
    })
    expect(h.state.entries[1]).toMatchObject({
      toolCall: { id: 'tool-b', status: 'in_progress' },
    })
  })

  test('clears a live permission when control_cancel_request arrives', () => {
    const h = harness()
    h.adapter.handleEvent({
      id: 'tool-a',
      type: 'tool_use',
      payload: { tool_call_id: 'tool-a', tool_name: 'Read', tool_input: {} },
    })
    h.adapter.handleEvent({
      id: 'request-a',
      type: 'control_request',
      payload: {
        request_id: 'request-a',
        request: {
          subtype: 'can_use_tool',
          tool_use_id: 'tool-a',
          tool_name: 'Read',
          input: {},
        },
      },
    })
    h.adapter.handleEvent({
      id: 'cancel-a',
      type: 'control_cancel_request',
      payload: normalizePayload('control_cancel_request', {
        request_id: 'request-a',
      }),
    })
    expect(h.state.entries[0]).toMatchObject({
      toolCall: {
        id: 'tool-a',
        status: 'in_progress',
      },
    })
    expect(
      (h.state.entries[0] as any).toolCall.permissionRequest,
    ).toBeUndefined()
  })

  test('applies embedded and standalone tool results without ending the turn', () => {
    const h = harness()
    h.adapter.handleEvent({
      id: 'tool-use',
      type: 'tool_use',
      direction: 'inbound',
      payload: { tool_call_id: 'tool-1', tool_name: 'Read', tool_input: {} },
    })
    h.adapter.handleEvent({
      id: 'tool-result',
      type: 'user',
      direction: 'inbound',
      payload: {
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: 'nope',
              is_error: true,
            },
          ],
        },
      },
    })

    expect(h.state.entries[0]).toMatchObject({
      toolCall: {
        id: 'tool-1',
        status: 'error',
        rawOutput: { output: 'nope' },
      },
    })
    expect(h.state.phase).toBe('using_tool')

    h.adapter.handleEvent({
      id: 'tool-use-2',
      type: 'tool_use',
      direction: 'inbound',
      payload: { tool_call_id: 'tool-2', tool_name: 'Write', tool_input: {} },
    })
    h.adapter.handleEvent({
      id: 'tool-result-2',
      type: 'tool_result',
      direction: 'inbound',
      payload: { tool_use_id: 'tool-2', content: 'ok' },
    })
    expect(h.state.entries[1]).toMatchObject({
      toolCall: {
        id: 'tool-2',
        status: 'completed',
        rawOutput: { output: 'ok' },
      },
    })
  })

  test('reads standalone tool identity and results from normalized raw payloads', () => {
    const h = harness()
    const toolUse = normalizePayload('tool_use', {
      type: 'tool_use',
      tool_call_id: 'tool-raw',
      name: 'Read',
      input: { file_path: 'a' },
    }) as SessionEvent['payload']
    const toolResult = normalizePayload('tool_result', {
      type: 'tool_result',
      tool_use_id: 'tool-raw',
      content: 'failed',
      is_error: true,
    }) as SessionEvent['payload']
    h.adapter.handleEvent({
      id: 'normalized-use',
      type: 'tool_use',
      direction: 'inbound',
      payload: toolUse,
    })
    h.adapter.handleEvent({
      id: 'normalized-result',
      type: 'tool_result',
      direction: 'inbound',
      payload: toolResult,
    })

    expect(h.state.entries[0]).toMatchObject({
      toolCall: {
        id: 'tool-raw',
        title: 'Read',
        status: 'error',
        rawInput: { file_path: 'a' },
        rawOutput: { output: 'failed' },
      },
    })
  })

  test('preserves audio tool results through RCS normalization', () => {
    const h = harness()
    h.adapter.handleEvent({
      id: 'tool-audio-use',
      type: 'tool_use',
      direction: 'inbound',
      payload: {
        tool_call_id: 'tool-audio',
        tool_name: 'Audio',
        tool_input: {},
      },
    })
    h.adapter.handleEvent({
      id: 'tool-audio-result',
      type: 'tool_result',
      direction: 'inbound',
      payload: normalizePayload('tool_result', {
        tool_use_id: 'tool-audio',
        content: [
          {
            type: 'audio',
            mimeType: 'audio/ogg',
            data: 'T2dnUw==',
            annotations: { audience: ['assistant'] },
            _meta: { tool: true },
          },
        ],
      }) as SessionEvent['payload'],
    })

    expect(h.state.entries[0]).toMatchObject({
      toolCall: {
        id: 'tool-audio',
        status: 'completed',
        content: [
          {
            type: 'content',
            content: {
              type: 'audio',
              mimeType: 'audio/ogg',
              data: 'T2dnUw==',
              playable: true,
              annotations: { audience: ['assistant'] },
              _meta: { tool: true },
            },
          },
        ],
      },
    })
  })

  test('preserves object tool output through RCS normalization', () => {
    const h = harness()
    h.adapter.handleEvent({
      id: 'tool-object-use',
      type: 'tool_use',
      direction: 'inbound',
      payload: {
        tool_call_id: 'tool-object',
        tool_name: 'Shell',
        tool_input: {},
      },
    })
    h.adapter.handleEvent({
      id: 'tool-object-result',
      type: 'tool_result',
      direction: 'inbound',
      payload: normalizePayload('tool_result', {
        tool_use_id: 'tool-object',
        content: { stdout: 'complete output' },
      }) as SessionEvent['payload'],
    })

    expect(h.state.entries[0]).toMatchObject({
      toolCall: {
        id: 'tool-object',
        status: 'completed',
        rawOutput: { output: { stdout: 'complete output' } },
      },
    })
  })

  test('replays outbound user history through the same mapping without inventing a terminal event', async () => {
    historyEvents = [
      {
        id: 'user-1',
        type: 'user',
        direction: 'outbound',
        payload: {
          uuid: 'user-1',
          message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        },
      },
      {
        id: 'assistant-1',
        type: 'assistant',
        direction: 'inbound',
        payload: {
          message: {
            id: 'm1',
            role: 'assistant',
            content: [{ type: 'text', text: 'hi' }],
          },
        },
      },
    ]
    const h = harness()

    await h.adapter.loadHistory()

    expect(h.state.entries).toEqual([
      {
        type: 'user_message',
        id: 'user-1',
        content: [{ type: 'text', text: 'hello' }],
        deliveryState: 'sent',
      },
      {
        type: 'assistant_message',
        id: 'm1',
        chunks: [{ type: 'message', content: [{ type: 'text', text: 'hi' }] }],
        state: 'streaming',
      },
    ])
  })

  test('keeps unfinished historical tools active and ignores resolved permission prompts', async () => {
    const permissions: string[] = []
    historyEvents = [
      {
        id: 'tool-a',
        type: 'tool_use',
        seqNum: 1,
        payload: { tool_call_id: 'tool-a', tool_name: 'Read', tool_input: {} },
      },
      {
        id: 'request-a',
        type: 'control_request',
        seqNum: 2,
        payload: {
          request_id: 'request-a',
          request: {
            subtype: 'can_use_tool',
            tool_use_id: 'tool-a',
            tool_name: 'Read',
            input: {},
          },
        },
      },
      {
        id: 'response-a',
        type: 'control_response',
        seqNum: 3,
        payload: normalizePayload('control_response', {
          response: { request_id: 'request-a', approved: true },
        }),
      },
    ]
    const h = harness()
    const adapter = new RCSChatAdapter('session-1', h.dispatch, () => h.state, {
      onPermissionRequest: value => permissions.push(value.requestId),
    })

    await adapter.loadHistory()

    expect(permissions).toEqual([])
    expect(h.state.phase).toBe('using_tool')
    expect(h.state.entries).toHaveLength(1)
    expect(h.state.entries[0]).toMatchObject({
      toolCall: { id: 'tool-a', status: 'in_progress' },
    })
  })

  test('does not recreate a historically cancelled permission prompt', async () => {
    historyEvents = [
      {
        id: 'tool-a',
        type: 'tool_use',
        seqNum: 1,
        payload: { tool_call_id: 'tool-a', tool_name: 'Read', tool_input: {} },
      },
      {
        id: 'request-a',
        type: 'control_request',
        seqNum: 2,
        payload: normalizePayload('control_request', {
          request_id: 'request-a',
          request: {
            subtype: 'can_use_tool',
            tool_use_id: 'tool-a',
            tool_name: 'Read',
            input: {},
          },
        }),
      },
      {
        id: 'cancel-a',
        type: 'control_cancel_request',
        seqNum: 3,
        payload: normalizePayload('control_cancel_request', {
          request_id: 'request-a',
        }),
      },
    ]
    const permissions: string[] = []
    const h = harness()
    const adapter = new RCSChatAdapter('session-1', h.dispatch, () => h.state, {
      onPermissionRequest: permission => permissions.push(permission.requestId),
    })
    await adapter.loadHistory()
    expect(permissions).toEqual([])
    expect(h.state.entries[0]).toMatchObject({
      toolCall: { id: 'tool-a', status: 'in_progress' },
    })
  })

  test('replays historical stream events through the live stream mapping', async () => {
    historyEvents = [
      stream({
        type: 'message_start',
        message: { id: 'history-m1', content: [] },
      }),
      stream({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'history' },
      }),
      stream({ type: 'message_stop' }),
    ]
    const h = harness()

    await h.adapter.loadHistory()

    expect(h.state.entries).toEqual([
      {
        type: 'assistant_message',
        id: 'history-m1',
        chunks: [
          { type: 'message', content: [{ type: 'text', text: 'history' }] },
        ],
        state: 'completed',
      },
    ])
  })

  test('sends exact multimodal and image-only payloads with optimistic uuid dedupe', async () => {
    const h = harness()
    await h.adapter.sendMessage('', [
      { mimeType: 'image/png', data: 'iVBORw0KGgo=' },
    ])

    const user = h.state.entries[0]
    expect(user?.type).toBe('user_message')
    if (user?.type !== 'user_message') return
    expect(user.deliveryState).toBe('sent')
    expect(sentEvents[0]).toEqual({
      sessionId: 'session-1',
      body: {
        type: 'user',
        uuid: user.id,
        content: '',
        message: {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'iVBORw0KGgo=',
              },
            },
          ],
        },
      },
    })

    h.adapter.handleEvent({
      id: 'echo',
      type: 'user',
      direction: 'outbound',
      payload: { uuid: user.id, message: sentEvents[0]?.body.message },
    })
    expect(h.state.entries).toHaveLength(1)

    await h.adapter.sendMessage('look', [
      { mimeType: 'image/jpeg', data: '/9j/' },
    ])
    expect(sentEvents[1]?.body).toMatchObject({
      content: 'look',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: '/9j/',
            },
          },
        ],
      },
    })
  })

  test('rejects every unsupported or malformed image before upstream send', async () => {
    const errors: string[] = []
    const h = harness()
    const adapter = new RCSChatAdapter('session-1', h.dispatch, () => h.state, {
      onError: error => errors.push(error),
    })

    for (const image of [
      { mimeType: 'image/svg+xml', data: 'PHN2Zz4=' },
      { mimeType: 'image/heic', data: 'YWJj' },
      { mimeType: 'image/png', data: 'not base64!' },
      { mimeType: 'image/png', data: 'YWJj' },
    ]) {
      await expect(adapter.sendMessage('', [image])).rejects.toThrow()
    }

    expect(sentEvents).toEqual([])
    expect(errors).toHaveLength(4)
    expect(h.state.entries).toHaveLength(4)
    expect(
      h.state.entries.every(
        entry =>
          entry.type === 'user_message' && entry.deliveryState === 'failed',
      ),
    ).toBe(true)
  })

  test('prevalidates all images before sending a multimodal batch', async () => {
    const h = harness()
    await expect(
      h.adapter.sendMessage('look', [
        { mimeType: 'image/png', data: 'iVBORw0KGgo=' },
        { mimeType: 'image/png', data: 'bad===' },
      ]),
    ).rejects.toThrow()
    expect(sentEvents).toEqual([])
  })

  test('waits for SSE open, then buffers the history gap and merges once by seqNum', async () => {
    const sources: FakeEventSource[] = []
    class FakeEventSource {
      listeners = new Map<string, Array<(event: MessageEvent) => void>>()
      closed = false
      constructor(readonly url: string) {
        sources.push(this)
      }
      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        const listeners = this.listeners.get(type) ?? []
        listeners.push(listener)
        this.listeners.set(type, listeners)
      }
      open() {
        for (const listener of this.listeners.get('open') ?? [])
          listener({} as MessageEvent)
      }
      emit(event: SessionEvent) {
        for (const listener of this.listeners.get('message') ?? [])
          listener({ data: JSON.stringify(event) } as MessageEvent)
      }
      close() {
        this.closed = true
      }
    }
    const original = globalThis.EventSource
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
    let resolveHistory: (value: { events: SessionEvent[] }) => void = () => {}
    let historyRequested = false
    historyImpl = () =>
      new Promise(resolve => {
        historyRequested = true
        resolveHistory = resolve
      })
    const h = harness()
    try {
      const initializing = h.adapter.init()
      await Promise.resolve()
      expect(sources).toHaveLength(1)
      expect(historyRequested).toBe(false)
      sources[0]?.open()
      await Promise.resolve()
      await Promise.resolve()
      expect(historyRequested).toBe(true)
      sources[0]?.emit({
        id: 'live-2',
        seqNum: 2,
        type: 'assistant',
        payload: {
          message: { id: 'm2', content: [{ type: 'text', text: 'two' }] },
        },
      })
      resolveHistory({
        events: [
          {
            id: 'history-1',
            seqNum: 1,
            type: 'user',
            payload: {
              uuid: 'u1',
              message: { content: [{ type: 'text', text: 'one' }] },
            },
          },
          {
            id: 'duplicate-2',
            seqNum: 2,
            type: 'assistant',
            payload: {
              message: { id: 'm2', content: [{ type: 'text', text: 'two' }] },
            },
          },
        ],
      })
      await initializing
      expect(
        h.state.entries.map(entry =>
          entry.type === 'tool_call' ? entry.toolCall.id : entry.id,
        ),
      ).toEqual(['u1', 'm2'])
    } finally {
      h.adapter.disconnect()
      globalThis.EventSource = original
    }
  })

  test('rejects initialization on a pre-open SSE error', async () => {
    const sources: FakeEventSource[] = []
    class FakeEventSource {
      listeners = new Map<string, Array<(event: Event) => void>>()
      closed = false
      constructor(_url: string) {
        sources.push(this)
      }
      addEventListener(type: string, listener: (event: Event) => void) {
        const listeners = this.listeners.get(type) ?? []
        listeners.push(listener)
        this.listeners.set(type, listeners)
      }
      error() {
        for (const listener of this.listeners.get('error') ?? [])
          listener(new Event('error'))
      }
      close() {
        this.closed = true
      }
    }
    const original = globalThis.EventSource
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
    const adapter = harness().adapter
    try {
      const initializing = adapter.init()
      await Promise.resolve()
      sources[0]?.error()
      await expect(initializing).rejects.toThrow('SSE connection failed')
      expect(sources[0]?.closed).toBe(true)
    } finally {
      adapter.disconnect()
      globalThis.EventSource = original
    }
  })

  test('rejects and cleans up when SSE does not open before the timeout', async () => {
    let source: FakeEventSource | undefined
    class FakeEventSource {
      closed = false
      constructor() {
        source = this
      }
      addEventListener() {}
      close() {
        this.closed = true
      }
    }
    let timeout: (() => void) | undefined
    const originalEventSource = globalThis.EventSource
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
    globalThis.setTimeout = ((callback: TimerHandler) => {
      timeout = callback as () => void
      return 1
    }) as typeof setTimeout
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout
    const adapter = harness().adapter
    try {
      const initializing = adapter.init()
      await Promise.resolve()
      timeout?.()
      await expect(initializing).rejects.toThrow('SSE connection timed out')
      expect(source?.closed).toBe(true)
    } finally {
      adapter.disconnect()
      globalThis.EventSource = originalEventSource
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    }
  })

  test('ignores the open timeout after the SSE connection settles', async () => {
    let open: (() => void) | undefined
    let timeout: (() => void) | undefined
    class FakeEventSource {
      addEventListener(type: string, listener: (event: Event) => void) {
        if (type === 'open') open = () => listener(new Event('open'))
      }
      close() {}
    }
    const originalEventSource = globalThis.EventSource
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
    globalThis.setTimeout = ((callback: TimerHandler) => {
      timeout = callback as () => void
      return 1
    }) as typeof setTimeout
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout
    const adapter = harness().adapter
    try {
      const initializing = adapter.init()
      open?.()
      timeout?.()
      await initializing
    } finally {
      adapter.disconnect()
      globalThis.EventSource = originalEventSource
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    }
  })

  test('a stale init cannot replay history or replace the next session SSE', async () => {
    const sources: FakeEventSource[] = []
    class FakeEventSource {
      constructor(readonly url: string) {
        sources.push(this)
      }
      addEventListener(type: string, listener: (event: Event) => void) {
        if (type === 'open') queueMicrotask(() => listener(new Event('open')))
      }
      closed = false
      close() {
        this.closed = true
      }
    }
    const original = globalThis.EventSource
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
    let resolveOld: (value: { events: SessionEvent[] }) => void = () => {}
    historyImpl = sessionId =>
      sessionId === 'old'
        ? new Promise(resolve => {
            resolveOld = resolve
          })
        : Promise.resolve({ events: [] })
    const old = harness('old')
    const next = harness('next')
    try {
      const oldInit = old.adapter.init()
      await Promise.resolve()
      old.adapter.disconnect()
      await next.adapter.init()
      const nextSource = sources[sources.length - 1]
      resolveOld({
        events: [{ id: 'stale', type: 'user', payload: { content: 'stale' } }],
      })
      await oldInit
      expect(old.state.entries).toEqual([])
      expect(nextSource?.closed).toBe(false)
      expect(sources).toHaveLength(2)
    } finally {
      next.adapter.disconnect()
      globalThis.EventSource = original
    }
  })

  test('supports the StrictMode init-disconnect-init lifecycle on one adapter', async () => {
    const sources: FakeEventSource[] = []
    class FakeEventSource {
      closed = false
      constructor(_url: string) {
        sources.push(this)
      }
      addEventListener(type: string, listener: (event: Event) => void) {
        if (type === 'open') queueMicrotask(() => listener(new Event('open')))
      }
      close() {
        this.closed = true
      }
    }
    const original = globalThis.EventSource
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
    let historyCalls = 0
    historyImpl = async () => {
      historyCalls++
      return { events: [] }
    }
    const adapter = harness().adapter
    try {
      const first = adapter.init()
      adapter.disconnect()
      const second = adapter.init()
      await Promise.all([first, second])
      expect(sources).toHaveLength(2)
      expect(sources[0]?.closed).toBe(true)
      expect(sources[1]?.closed).toBe(false)
      expect(historyCalls).toBe(1)
    } finally {
      adapter.disconnect()
      globalThis.EventSource = original
    }
  })

  test('ignores delayed callbacks from a replaced EventSource', async () => {
    const sources: FakeEventSource[] = []
    class FakeEventSource {
      listeners = new Map<string, Array<(event: MessageEvent) => void>>()
      closed = false
      constructor(_url: string) {
        sources.push(this)
      }
      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        const listeners = this.listeners.get(type) ?? []
        listeners.push(listener)
        this.listeners.set(type, listeners)
      }
      dispatch(type: string, event: MessageEvent = {} as MessageEvent) {
        for (const listener of this.listeners.get(type) ?? []) listener(event)
      }
      emit(event: SessionEvent) {
        this.dispatch('message', {
          data: JSON.stringify(event),
        } as MessageEvent)
      }
      close() {
        this.closed = true
      }
    }
    const original = globalThis.EventSource
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
    const h = harness()
    try {
      const first = h.adapter.init()
      h.adapter.disconnect()
      const second = h.adapter.init()
      sources[1]?.dispatch('open')
      await Promise.all([first, second])

      sources[0]?.dispatch('open')
      sources[0]?.dispatch('error')
      sources[0]?.emit({
        id: 'stale-user',
        type: 'user',
        payload: { uuid: 'stale-user', content: 'stale' },
      })
      expect(h.state.entries).toEqual([])
      expect(sources[1]?.closed).toBe(false)
    } finally {
      h.adapter.disconnect()
      globalThis.EventSource = original
    }
  })

  test('does not swallow exceptions thrown by SSE event handlers', async () => {
    let source: FakeEventSource | undefined
    class FakeEventSource {
      listeners = new Map<string, Array<(event: MessageEvent) => void>>()
      constructor() {
        source = this
      }
      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        const listeners = this.listeners.get(type) ?? []
        listeners.push(listener)
        this.listeners.set(type, listeners)
      }
      dispatch(type: string, event: MessageEvent = {} as MessageEvent) {
        for (const listener of this.listeners.get(type) ?? []) listener(event)
      }
      close() {}
    }
    const original = globalThis.EventSource
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
    const adapter = new RCSChatAdapter(
      'session-1',
      () => {
        throw new Error('reducer exploded')
      },
      () => initialThreadState('session-1'),
    )
    try {
      const ready = adapter.connectSSE()
      source?.dispatch('open')
      await ready
      expect(() =>
        source?.dispatch('message', {
          data: JSON.stringify({
            id: 'user-1',
            type: 'user',
            payload: { uuid: 'user-1', content: 'hello' },
          }),
        } as MessageEvent),
      ).toThrow('reducer exploded')
    } finally {
      adapter.disconnect()
      globalThis.EventSource = original
    }
  })

  test('propagates non-idempotent bind and history failures', async () => {
    class FakeEventSource {
      addEventListener(type: string, listener: (event: Event) => void) {
        if (type === 'open') queueMicrotask(() => listener(new Event('open')))
      }
      close() {}
    }
    const original = globalThis.EventSource
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
    try {
      bindImpl = async () => {
        throw new Error('network down')
      }
      await expect(harness().adapter.init()).rejects.toThrow('network down')
      bindImpl = async () => {}
      historyImpl = async () => {
        throw new Error('history down')
      }
      await expect(harness().adapter.init()).rejects.toThrow('history down')
    } finally {
      globalThis.EventSource = original
    }
  })

  test('handles result, cancellation, error, and inactive terminal events', () => {
    const errors: string[] = []
    const base = harness()
    const adapter = new RCSChatAdapter(
      'session-1',
      base.dispatch,
      () => base.state,
      {
        onError: error => errors.push(error),
      },
    )

    adapter.handleEvent(
      stream({ type: 'message_start', message: { id: 'm1', content: [] } }),
    )
    adapter.handleEvent({
      id: 'cancel',
      type: 'result',
      payload: { subtype: 'cancelled' },
    })
    expect(base.state.phase).toBe('idle')

    adapter.handleEvent(
      stream({ type: 'message_start', message: { id: 'm2', content: [] } }),
    )
    adapter.handleEvent({
      id: 'error',
      type: 'error',
      payload: { message: 'broken' },
    })
    expect(base.state.phase).toBe('error')
    expect(errors).toEqual(['broken'])

    adapter.handleEvent(
      stream({ type: 'message_start', message: { id: 'm3', content: [] } }),
    )
    adapter.handleEvent({
      id: 'result-error',
      type: 'result',
      payload: normalizePayload('result', {
        subtype: 'error_during_execution',
        is_error: true,
        result: 'execution failed',
      }),
    })
    expect(base.state.phase).toBe('error')
    expect(errors).toEqual(['broken', 'execution failed'])

    adapter.handleEvent({
      id: 'inactive',
      type: 'session_status',
      payload: { status: 'inactive' },
    })
    expect(base.state.phase).toBe('idle')
  })

  test('marks optimistic messages failed and reports send errors', async () => {
    const errors: string[] = []
    const h = harness()
    const adapter = new RCSChatAdapter('session-1', h.dispatch, () => h.state, {
      onError: error => errors.push(error),
    })
    sendError = new Error('send failed')

    await expect(adapter.sendMessage('hello')).rejects.toThrow('send failed')

    expect(h.state.entries[0]).toMatchObject({ deliveryState: 'failed' })
    expect(errors).toEqual(['send failed'])
  })

  test('keeps a permission pending when the response POST fails', async () => {
    const h = harness()
    h.adapter.handleEvent({
      id: 'request-a',
      type: 'control_request',
      payload: {
        request_id: 'request-a',
        request: { subtype: 'can_use_tool', tool_name: 'Read', input: {} },
      },
    })
    controlError = new Error('permission send failed')
    await expect(
      h.adapter.respondPermission('request-a', true),
    ).rejects.toThrow('permission send failed')
    expect(h.state.entries[0]).toMatchObject({
      toolCall: {
        status: 'waiting_for_confirmation',
        permissionRequest: { requestId: 'request-a' },
      },
    })
  })
})
