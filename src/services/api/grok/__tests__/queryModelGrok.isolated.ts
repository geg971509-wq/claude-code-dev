import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type {
  AssistantMessage,
  StreamEvent,
} from '../../../../types/message.js'
import * as realModelProvider from '../../../../../packages/@ant/model-provider/src/index.js'
import { debugMock } from '../../../../../tests/mocks/debug'

mock.module('src/utils/debug.ts', debugMock)

type AttemptPlan = {
  events?: BetaRawMessageStreamEvent[]
  handshakeError?: unknown
  streamError?: unknown
  requestId?: string
  hang?: boolean
  hangAfterEvents?: boolean
}

let attemptPlans: AttemptPlan[] = []
let createCalls = 0
let lastController: AbortController | null = null
let bodyCancelCalls = 0

function eventStream(
  plan: AttemptPlan,
): AsyncIterable<BetaRawMessageStreamEvent> {
  if (plan.hang) {
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<BetaRawMessageStreamEvent>>(() => {}),
          return: async () => ({ done: true, value: undefined }),
        }
      },
    }
  }
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of plan.events ?? []) yield event
      if (plan.hangAfterEvents) {
        await new Promise<void>(() => {})
      }
      if (plan.streamError !== undefined) throw plan.streamError
    },
  }
}

mock.module('@ant/model-provider', () => ({
  ...realModelProvider,
  resolveGrokModel: (model: string) => model,
  anthropicMessagesToOpenAI: () => [],
  anthropicToolsToOpenAI: () => [],
  anthropicToolChoiceToOpenAI: () => undefined,
  adaptOpenAIStreamToAnthropic: (stream: AsyncIterable<unknown>) => stream,
}))

mock.module('src/services/api/grok/client.ts', () => ({
  getGrokClient: () => ({
    chat: {
      completions: {
        create: () => ({
          withResponse: async () => {
            const plan = attemptPlans[createCalls++] ?? { events: [] }
            if (plan.handshakeError !== undefined) throw plan.handshakeError
            const controller = new AbortController()
            lastController = controller
            return {
              data: Object.assign(eventStream(plan), { controller }),
              response: {
                status: 200,
                headers: new Headers({
                  'x-request-id': plan.requestId ?? 'req_grok_test',
                }),
                body: {
                  cancel: async () => {
                    bodyCancelCalls++
                  },
                },
              },
              request_id: plan.requestId ?? 'req_grok_test',
            }
          },
        }),
      },
    },
  }),
  clearGrokClientCache: () => {},
}))

mock.module('src/utils/messages.ts', () => ({
  normalizeMessagesForAPI: (messages: unknown[]) => messages,
  normalizeContentFromAPI: (blocks: Array<Record<string, unknown>>) =>
    blocks.map(block =>
      block.type === 'tool_use' && typeof block.input === 'string'
        ? { ...block, input: JSON.parse(block.input || '{}') }
        : block,
    ),
  createAssistantAPIErrorMessage: ({ content }: { content: string }) => ({
    type: 'assistant',
    isApiErrorMessage: true,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: content }],
    },
    uuid: 'error-message',
  }),
  createSystemAPIErrorMessage: (
    error: Error,
    retryInMs: number,
    retryAttempt: number,
    maxRetries: number,
  ) => ({
    type: 'system',
    subtype: 'api_error',
    error,
    retryInMs,
    retryAttempt,
    maxRetries,
  }),
}))

mock.module('src/utils/api.ts', () => ({
  toolToAPISchema: async (tool: unknown) => tool,
}))

mock.module('src/services/api/errors.ts', () => ({
  isProviderContextOverflowError: () => false,
  isProviderRequestTooLargeError: () => false,
  isProviderRateLimitError: () => false,
  getAssistantMessageFromError: () => {
    throw new Error('unreachable')
  },
}))

mock.module('src/cost-tracker.ts', () => ({
  addToTotalSessionCost: () => {},
}))

mock.module('src/utils/modelCost.ts', () => ({
  calculateUSDCost: () => 0,
}))

mock.module('src/services/langfuse/tracing.ts', () => ({
  recordLLMObservation: () => {},
}))

function messageStart(): BetaRawMessageStreamEvent {
  return {
    type: 'message_start',
    message: {
      id: 'msg_grok_test',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'grok-test',
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 11,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  } as unknown as BetaRawMessageStreamEvent
}

function blockStart(
  index: number,
  block: Record<string, unknown>,
): BetaRawMessageStreamEvent {
  return {
    type: 'content_block_start',
    index,
    content_block: block,
  } as unknown as BetaRawMessageStreamEvent
}

function blockDelta(
  index: number,
  delta: Record<string, unknown>,
): BetaRawMessageStreamEvent {
  return {
    type: 'content_block_delta',
    index,
    delta,
  } as unknown as BetaRawMessageStreamEvent
}

function blockStop(index: number): BetaRawMessageStreamEvent {
  return { type: 'content_block_stop', index } as BetaRawMessageStreamEvent
}

function messageDelta(): BetaRawMessageStreamEvent {
  return {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as BetaRawMessageStreamEvent
}

function messageStop(): BetaRawMessageStreamEvent {
  return { type: 'message_stop' } as BetaRawMessageStreamEvent
}

function completedEvents(): BetaRawMessageStreamEvent[] {
  return [
    messageStart(),
    blockStart(0, { type: 'thinking', thinking: '', signature: '' }),
    blockDelta(0, { type: 'thinking_delta', thinking: 'plan' }),
    blockDelta(0, { type: 'signature_delta', signature: 'sig' }),
    blockStop(0),
    blockStart(1, { type: 'text', text: '' }),
    blockDelta(1, { type: 'text_delta', text: 'answer' }),
    blockStop(1),
    blockStart(2, {
      type: 'tool_use',
      id: 'toolu_test',
      name: 'Bash',
      input: {},
    }),
    blockDelta(2, {
      type: 'input_json_delta',
      partial_json: '{"command":"pwd"}',
    }),
    blockStop(2),
    messageDelta(),
    messageStop(),
  ]
}

async function runQuery(plans: AttemptPlan[]) {
  attemptPlans = plans
  createCalls = 0
  lastController = null
  bodyCancelCalls = 0

  const { queryModelGrok } = await import('../index.js')
  const assistantMessages: AssistantMessage[] = []
  const streamEvents: StreamEvent[] = []

  for await (const item of queryModelGrok(
    [],
    [] as never,
    [],
    new AbortController().signal,
    {
      model: 'grok-test',
      tools: [],
      agents: [],
      querySource: 'main_loop',
      getToolPermissionContext: async () => ({
        alwaysAllow: [],
        alwaysDeny: [],
        needsPermission: [],
        mode: 'default',
        isBypassingPermissions: false,
      }),
    } as never,
  )) {
    if (item.type === 'assistant') {
      assistantMessages.push(item as AssistantMessage)
    } else if (item.type === 'stream_event') {
      streamEvents.push(item as StreamEvent)
    }
  }

  return { assistantMessages, streamEvents }
}

function normalMessages(messages: AssistantMessage[]): AssistantMessage[] {
  return messages.filter(
    message =>
      !(message as AssistantMessage & { isApiErrorMessage?: boolean })
        .isApiErrorMessage,
  )
}

function errorMessages(messages: AssistantMessage[]): AssistantMessage[] {
  return messages.filter(
    message =>
      (message as AssistantMessage & { isApiErrorMessage?: boolean })
        .isApiErrorMessage,
  )
}

beforeEach(() => {
  process.env.CLAUDE_CODE_MAX_RETRIES = '2'
  delete process.env.OPENAI_STREAM_IDLE_TIMEOUT_MS
  delete process.env.OPENAI_STREAM_MAX_RETRIES
})

afterEach(() => {
  delete process.env.OPENAI_STREAM_IDLE_TIMEOUT_MS
  delete process.env.OPENAI_STREAM_MAX_RETRIES
})

describe('queryModelGrok terminal assembly', () => {
  test('emits one complete assistant message after message_stop', async () => {
    const events = completedEvents()
    const result = await runQuery([{ events, requestId: 'req_complete' }])
    const messages = normalMessages(result.assistantMessages)

    expect(messages).toHaveLength(1)
    expect(messages[0]!.requestId).toBe('req_complete')
    expect(messages[0]!.message.stop_reason).toBe('tool_use')
    expect(messages[0]!.message.usage).toEqual({
      input_tokens: 11,
      output_tokens: 7,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
    expect(messages[0]!.message.content).toEqual([
      { type: 'thinking', thinking: 'plan', signature: 'sig' },
      { type: 'text', text: 'answer' },
      {
        type: 'tool_use',
        id: 'toolu_test',
        name: 'Bash',
        input: { command: 'pwd' },
      },
    ])
    expect(result.streamEvents).toHaveLength(events.length)
    expect(lastController?.signal.aborted).toBe(true)
  })

  test('does not commit partial success when message_stop is missing', async () => {
    const events = completedEvents().slice(0, -1)
    const result = await runQuery([{ events }])

    expect(normalMessages(result.assistantMessages)).toHaveLength(0)
    expect(errorMessages(result.assistantMessages)).toHaveLength(1)
  })

  test('does not commit partial success when the stream iterator fails', async () => {
    const events = completedEvents().slice(0, 8)
    const result = await runQuery([
      { events, streamError: new Error('socket closed') },
    ])

    expect(normalMessages(result.assistantMessages)).toHaveLength(0)
    expect(errorMessages(result.assistantMessages)).toHaveLength(1)
  })

  test('aborts and reports a stream that stays idle', async () => {
    process.env.OPENAI_STREAM_IDLE_TIMEOUT_MS = '5'
    process.env.OPENAI_STREAM_MAX_RETRIES = '0'
    const result = await runQuery([{ hang: true, requestId: 'req_idle' }])

    expect(createCalls).toBe(1)
    expect(normalMessages(result.assistantMessages)).toHaveLength(0)
    expect(errorMessages(result.assistantMessages)).toHaveLength(1)
    expect(lastController?.signal.aborted).toBe(true)
    expect(bodyCancelCalls).toBe(1)
  })

  test('retries an idle stream and commits the recovered attempt', async () => {
    process.env.OPENAI_STREAM_IDLE_TIMEOUT_MS = '5'
    process.env.OPENAI_STREAM_MAX_RETRIES = '1'
    const result = await runQuery([
      { hang: true, requestId: 'req_idle' },
      { events: completedEvents(), requestId: 'req_idle_recovered' },
    ])

    expect(createCalls).toBe(2)
    expect(normalMessages(result.assistantMessages)).toHaveLength(1)
    expect(errorMessages(result.assistantMessages)).toHaveLength(0)
    expect(normalMessages(result.assistantMessages)[0]!.requestId).toBe(
      'req_idle_recovered',
    )
  })

  test('retries after thinking-only then idle', async () => {
    process.env.OPENAI_STREAM_IDLE_TIMEOUT_MS = '5'
    process.env.OPENAI_STREAM_MAX_RETRIES = '1'
    const result = await runQuery([
      {
        events: [
          messageStart(),
          blockStart(0, { type: 'thinking', thinking: '', signature: '' }),
          blockDelta(0, { type: 'thinking_delta', thinking: 'plan' }),
        ],
        hangAfterEvents: true,
        requestId: 'req_think_idle',
      },
      { events: completedEvents(), requestId: 'req_think_recovered' },
    ])

    expect(createCalls).toBe(2)
    expect(normalMessages(result.assistantMessages)).toHaveLength(1)
    expect(errorMessages(result.assistantMessages)).toHaveLength(0)
    expect(normalMessages(result.assistantMessages)[0]!.requestId).toBe(
      'req_think_recovered',
    )
  })

  test('retries a stream that opens and then goes idle', async () => {
    process.env.OPENAI_STREAM_IDLE_TIMEOUT_MS = '5'
    process.env.OPENAI_STREAM_MAX_RETRIES = '1'
    const result = await runQuery([
      {
        events: [messageStart(), blockStart(0, { type: 'text', text: '' })],
        hangAfterEvents: true,
        requestId: 'req_opened_then_idle',
      },
      { events: completedEvents(), requestId: 'req_idle_recovered' },
    ])

    expect(createCalls).toBe(2)
    expect(normalMessages(result.assistantMessages)).toHaveLength(1)
    expect(errorMessages(result.assistantMessages)).toHaveLength(0)
    expect(normalMessages(result.assistantMessages)[0]!.requestId).toBe(
      'req_idle_recovered',
    )
    expect(result.streamEvents).toHaveLength(completedEvents().length)
  })

  test('retries once semantic content has been yielded', async () => {
    process.env.OPENAI_STREAM_IDLE_TIMEOUT_MS = '5'
    process.env.OPENAI_STREAM_MAX_RETRIES = '3'
    const result = await runQuery([
      {
        events: completedEvents().slice(0, 7),
        hangAfterEvents: true,
        requestId: 'req_committed',
      },
      { events: completedEvents(), requestId: 'req_committed_recovered' },
    ])

    expect(createCalls).toBe(2)
    expect(normalMessages(result.assistantMessages)).toHaveLength(1)
    expect(errorMessages(result.assistantMessages)).toHaveLength(0)
    expect(normalMessages(result.assistantMessages)[0]!.requestId).toBe(
      'req_committed_recovered',
    )
  })

  test('cuts a thinking loop without retrying the same prompt', async () => {
    process.env.OPENAI_STREAM_MAX_RETRIES = '3'
    const repeated =
      'The leftover test is still not written. I need to write it now. Also I need to look at the idle timeout more carefully. '
    const result = await runQuery([
      {
        events: [
          messageStart(),
          blockStart(0, { type: 'thinking', thinking: '', signature: '' }),
          ...Array.from({ length: 8 }, () =>
            blockDelta(0, { type: 'thinking_delta', thinking: repeated }),
          ),
        ],
        requestId: 'req_think_loop',
      },
      { events: completedEvents(), requestId: 'req_must_not_retry' },
    ])

    expect(createCalls).toBe(1)
    expect(normalMessages(result.assistantMessages)).toHaveLength(0)
    expect(errorMessages(result.assistantMessages)).toHaveLength(1)
    expect(
      (
        errorMessages(result.assistantMessages)[0]!.message.content![0] as {
          text: string
        }
      ).text,
    ).toContain('Thinking loop detected')
  })

  test('retries request establishment and uses the successful request ID', async () => {
    const retryable = new realModelProvider.ProviderAPIError(
      503,
      'temporarily unavailable',
      null,
      0,
    )
    const result = await runQuery([
      { handshakeError: retryable },
      { events: completedEvents(), requestId: 'req_recovered' },
    ])

    expect(createCalls).toBe(2)
    expect(normalMessages(result.assistantMessages)).toHaveLength(1)
    expect(errorMessages(result.assistantMessages)).toHaveLength(0)
    expect(normalMessages(result.assistantMessages)[0]!.requestId).toBe(
      'req_recovered',
    )
  })
})
