/**
 * Tests for queryModelOpenAI in index.ts.
 *
 * Focused on final-message assembly, strict terminal handling, and retry
 * boundaries. A normal AssistantMessage is emitted only after message_stop;
 * abrupt EOF must surface an API error instead of partial success.
 *
 * Strategy: mock getOpenAIClient + adaptOpenAIStreamToAnthropic so we can
 * feed pre-built Anthropic events directly into queryModelOpenAI and inspect
 * what it emits — without any real HTTP calls.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test'
import { APIUserAbortError } from '@anthropic-ai/sdk'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type {
  AssistantMessage,
  StreamEvent,
} from '../../../../types/message.js'
import * as realModelProvider from '../../../../../packages/@ant/model-provider/src/index.js'
import * as realSearchExtraTools from '../../../../utils/searchExtraTools.js'

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal message_start event */
function makeMessageStart(
  overrides: Record<string, any> = {},
): BetaRawMessageStreamEvent {
  return {
    type: 'message_start',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'test-model',
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      ...overrides,
    },
  } as any
}

/** Build a content_block_start event for the given block type */
function makeContentBlockStart(
  index: number,
  type: 'text' | 'tool_use' | 'thinking',
  extra: Record<string, any> = {},
): BetaRawMessageStreamEvent {
  const block =
    type === 'text'
      ? { type: 'text', text: '' }
      : type === 'tool_use'
        ? { type: 'tool_use', id: 'toolu_test', name: 'bash', input: {} }
        : { type: 'thinking', thinking: '', signature: '' }
  return {
    type: 'content_block_start',
    index,
    content_block: { ...block, ...extra },
  } as any
}

/** Build a text_delta content_block_delta event */
function makeTextDelta(index: number, text: string): BetaRawMessageStreamEvent {
  return {
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  } as any
}

/** Build an input_json_delta content_block_delta event */
function makeInputJsonDelta(
  index: number,
  json: string,
): BetaRawMessageStreamEvent {
  return {
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: json },
  } as any
}

/** Build a thinking_delta content_block_delta event */
function makeThinkingDelta(
  index: number,
  thinking: string,
): BetaRawMessageStreamEvent {
  return {
    type: 'content_block_delta',
    index,
    delta: { type: 'thinking_delta', thinking },
  } as any
}

function makeSignatureDelta(
  index: number,
  signature: string,
): BetaRawMessageStreamEvent {
  return {
    type: 'content_block_delta',
    index,
    delta: { type: 'signature_delta', signature },
  } as any
}

/** Build a content_block_stop event */
function makeContentBlockStop(index: number): BetaRawMessageStreamEvent {
  return { type: 'content_block_stop', index } as any
}

/** Build a message_delta event with stop_reason and output_tokens */
function makeMessageDelta(
  stopReason: string,
  outputTokens: number,
): BetaRawMessageStreamEvent {
  return {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  } as any
}

/** Build a message_stop event */
function makeMessageStop(): BetaRawMessageStreamEvent {
  return { type: 'message_stop' } as any
}

type AttemptPlan = {
  events?: BetaRawMessageStreamEvent[]
  handshakeError?: unknown
  streamError?: unknown
  requestId?: string
  retryAfter?: string
}

/** Async generator from a fixed array of events */
async function* eventStream(
  events: BetaRawMessageStreamEvent[],
  error?: unknown,
) {
  for (const e of events) yield e
  if (error !== undefined) throw error
}

/** Collect all outputs from queryModelOpenAI into typed buckets */
async function runQueryModel(
  events: BetaRawMessageStreamEvent[],
  envOverrides: Record<string, string | undefined> = {},
  attempts: AttemptPlan[] = [{ events }],
  signal: AbortSignal = new AbortController().signal,
) {
  _attemptPlans = attempts
  _activeAttempt = null
  _createCalls = 0
  // Save + apply env overrides
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(envOverrides)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }

  try {
    // We inline mock.module inside the try block.
    // Bun resolves mock.module at the call site synchronously (hoisted),
    // so we register once per test file, then re-import each time.
    const { queryModelOpenAI } = await import('../index.js')

    const assistantMessages: AssistantMessage[] = []
    const streamEvents: StreamEvent[] = []
    const otherOutputs: any[] = []

    const minimalOptions: any = {
      model: 'test-model',
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
    }

    for await (const item of queryModelOpenAI(
      [],
      { type: 'text', text: '' } as any,
      [],
      signal,
      minimalOptions,
    )) {
      if (item.type === 'assistant') {
        assistantMessages.push(item as AssistantMessage)
      } else if (item.type === 'stream_event') {
        streamEvents.push(item as StreamEvent)
      } else {
        otherOutputs.push(item)
      }
    }

    return { assistantMessages, streamEvents, otherOutputs }
  } finally {
    // Restore env
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

// ─── mock setup ──────────────────────────────────────────────────────────────

// We mock at module level. Bun's mock.module replaces the module for the
// entire file, so we configure the stream per-test via a shared variable.
let _nextEvents: BetaRawMessageStreamEvent[] = []
let _attemptPlans: AttemptPlan[] = []
let _activeAttempt: AttemptPlan | null = null
let _createCalls = 0
let _searchExtraToolsEnabled = false

/** Captured arguments from the last chat.completions.create() call */
let _lastCreateArgs: Record<string, any> | null = null
let _lastAdapterOptions: { includeCacheWriteTokens?: boolean } | undefined

beforeEach(() => {
  _nextEvents = []
  _attemptPlans = []
  _activeAttempt = null
  _createCalls = 0
  _lastCreateArgs = null
  _lastAdapterOptions = undefined
  _searchExtraToolsEnabled = false
})

mock.module('@ant/model-provider', () => ({
  ...realModelProvider,
  resolveOpenAIModel: (m: string) => m,
  adaptOpenAIStreamToAnthropic: (
    _stream: any,
    _model: string,
    options?: { includeCacheWriteTokens?: boolean },
  ) => {
    _lastAdapterOptions = options
    return eventStream(
      _activeAttempt?.events ?? _nextEvents,
      _activeAttempt?.streamError,
    )
  },
  anthropicMessagesToOpenAI: (messages: any[]) =>
    messages.map(msg => ({
      role: msg.message?.role ?? 'user',
      content: msg.message?.content ?? '',
    })),
  anthropicToolsToOpenAI: (tools: any[]) =>
    tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.input_schema ?? { type: 'object', properties: {} },
      },
    })),
  anthropicToolChoiceToOpenAI: () => undefined,
  normalizeOpenAIUsage: (params: {
    totalInputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }) => {
    const cacheRead = Math.min(
      Math.max(0, params.cacheReadTokens ?? 0),
      Math.max(0, params.totalInputTokens),
    )
    const remaining = Math.max(0, params.totalInputTokens - cacheRead)
    const cacheCreation = Math.min(
      Math.max(0, params.cacheWriteTokens ?? 0),
      remaining,
    )
    return {
      input_tokens: Math.max(0, remaining - cacheCreation),
      output_tokens: Math.max(0, params.outputTokens),
      cache_creation_input_tokens: cacheCreation,
      cache_read_input_tokens: cacheRead,
    }
  },
}))

mock.module('../../../../services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: (_key: string, fallback: unknown) =>
    fallback,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
  getFeatureValue_CACHED_WITH_REFRESH: (_key: string, fallback: unknown) =>
    fallback,
}))

// Force Chat Completions path so stream/client mocks apply (not Responses).
// Avoid partial mocks of bootstrap/state and envUtils — incomplete surfaces
// break transitive named imports when this file is run alone.
mock.module('../chatgptAuth.js', () => ({
  isChatGPTAuthEnabled: () => false,
  getValidChatGPTAuth: async () => null,
}))

mock.module('bun:bundle', () => ({
  feature: () => false,
}))

mock.module('../client.js', () => ({
  getOpenAIClient: () => ({
    chat: {
      completions: {
        create: (args: Record<string, any>) => {
          _lastCreateArgs = args
          const plan = _attemptPlans[_createCalls++] ?? { events: _nextEvents }
          const data = {
            controller: new AbortController(),
            [Symbol.asyncIterator]: async function* () {},
          }
          return {
            withResponse: async () => {
              if (plan.handshakeError !== undefined) {
                throw plan.handshakeError
              }
              _activeAttempt = plan
              const requestId = plan.requestId ?? 'req_test'
              return {
                data,
                response: {
                  status: 200,
                  headers: new Headers({
                    'x-request-id': requestId,
                    ...(plan.retryAfter && {
                      'retry-after': plan.retryAfter,
                    }),
                  }),
                  body: null,
                },
                request_id: requestId,
              }
            },
          }
        },
      },
    },
  }),
}))

mock.module('../streamAdapter.js', () => ({
  adaptOpenAIStreamToAnthropic: (_stream: any, _model: string) =>
    eventStream(_nextEvents),
}))

mock.module('../modelMapping.js', () => ({
  resolveOpenAIModel: (m: string) => m,
}))

mock.module('../convertMessages.js', () => ({
  anthropicMessagesToOpenAI: () => [],
}))

mock.module('../convertTools.js', () => ({
  anthropicToolsToOpenAI: () => [],
  anthropicToolChoiceToOpenAI: () => undefined,
}))

mock.module('../../../../utils/context.js', () => ({
  MODEL_CONTEXT_WINDOW_DEFAULT: 200_000,
  COMPACT_MAX_OUTPUT_TOKENS: 20_000,
  CAPPED_DEFAULT_MAX_TOKENS: 8_000,
  ESCALATED_MAX_TOKENS: 64_000,
  is1mContextDisabled: () => false,
  has1mContext: () => false,
  modelSupports1M: () => false,
  getModelMaxOutputTokens: () => ({ upperLimit: 8192, default: 8192 }),
  getContextWindowForModel: () => 200_000,
  getSonnet1mExpTreatmentEnabled: () => false,
  calculateContextPercentages: () => ({
    usedPercent: 0,
    remainingPercent: 100,
  }),
  getMaxThinkingTokensForModel: () => 0,
}))

mock.module('../../../../utils/api.js', () => ({
  toolToAPISchema: async (t: any) => t,
}))

mock.module('../../../../utils/searchExtraTools.js', () => ({
  ...realSearchExtraTools,
  isSearchExtraToolsEnabled: async () => _searchExtraToolsEnabled,
  extractDiscoveredToolNames: () => new Set(),
  isDeferredToolsDeltaEnabled: () => false,
}))

mock.module('../../../../cost-tracker.js', () => ({
  addToTotalSessionCost: () => {},
}))

mock.module('../../../../utils/modelCost.js', () => ({
  COST_TIER_3_15: {},
  COST_TIER_15_75: {},
  COST_TIER_5_25: {},
  COST_TIER_30_150: {},
  COST_HAIKU_35: {},
  COST_HAIKU_45: {},
  getOpus46CostTier: () => ({}),
  MODEL_COSTS: {},
  getModelCosts: () => ({}),
  calculateUSDCost: () => 0,
  calculateCostFromTokens: () => 0,
  formatModelPricing: () => '',
  getModelPricingString: () => undefined,
}))

mock.module('../../../../services/langfuse/tracing.js', () => ({
  createTrace: () => null,
  createSubagentTrace: () => null,
  createChildSpan: () => null,
  recordLLMObservation: () => {},
  recordToolObservation: () => {},
  endTrace: () => {},
  createToolBatchSpan: () => null,
  endToolBatchSpan: () => {},
}))

mock.module('../../../../services/langfuse/convert.js', () => ({
  convertMessagesToLangfuse: () => [],
  convertOutputToLangfuse: () => ({}),
  convertToolsToLangfuse: () => [],
}))

mock.module('../../../../utils/debug.js', () => ({
  logForDebugging: () => {},
  logAntError: () => {},
  isDebugMode: () => false,
  isDebugToStdErr: () => false,
  getDebugFilePath: () => null,
  getDebugLogPath: () => '',
  getDebugFilter: () => null,
  getMinDebugLogLevel: () => 'debug',
  enableDebugLogging: () => false,
  setHasFormattedOutput: () => {},
  getHasFormattedOutput: () => false,
  flushDebugLogs: async () => {},
}))

// ─── tests ───────────────────────────────────────────────────────────────────

describe('queryModelOpenAI — stop_reason propagation', () => {
  test('assembled AssistantMessage has stop_reason end_turn (not null)', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'Hello'),
      makeContentBlockStop(0),
      makeMessageDelta('end_turn', 10),
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]!.message.stop_reason).toBe('end_turn')
  })

  test('assembled AssistantMessage has stop_reason tool_use', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'tool_use'),
      makeInputJsonDelta(0, '{"cmd":"ls"}'),
      makeContentBlockStop(0),
      makeMessageDelta('tool_use', 20),
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]!.message.stop_reason).toBe('tool_use')
  })

  test('assembled AssistantMessage has stop_reason max_tokens', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'truncated'),
      makeContentBlockStop(0),
      makeMessageDelta('max_tokens', 8192),
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    expect(assistantMessages).toHaveLength(2)
    const contentMsg = assistantMessages[0]!
    expect(contentMsg.message.stop_reason).toBe('max_tokens')
    expect(assistantMessages[1]!.apiError).toBe('max_output_tokens')
  })

  test('does not assemble partial content when message_stop is missing', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'partial'),
      makeContentBlockStop(0),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]!.isApiErrorMessage).toBe(true)
    expect(assistantMessages[0]!.message.content).not.toContainEqual(
      expect.objectContaining({ text: 'partial' }),
    )
  })
})

describe('queryModelOpenAI — usage accumulation', () => {
  test('usage in assembled message reflects all four fields from message_delta', async () => {
    // message_start has all fields=0 (trailing-chunk pattern: usage not yet available).
    // message_delta carries the real values after stream ends.
    // The spread in the message_delta handler must override all zeros from message_start,
    // including cache_read_input_tokens which was previously missing from message_delta.
    _nextEvents = [
      makeMessageStart({
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'response'),
      makeContentBlockStop(0),
      // message_delta carries all four Anthropic usage fields (as emitted by the fixed streamAdapter)
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: {
          input_tokens: 30011,
          output_tokens: 190,
          cache_read_input_tokens: 19904,
          cache_creation_input_tokens: 0,
        },
      } as any,
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    expect(assistantMessages).toHaveLength(1)
    const usage = assistantMessages[0]!.message.usage as any
    expect(usage.input_tokens).toBe(30011)
    expect(usage.output_tokens).toBe(190)
    // cache_read_input_tokens from message_delta overrides the 0 from message_start
    expect(usage.cache_read_input_tokens).toBe(19904)
    expect(usage.cache_creation_input_tokens).toBe(0)
  })

  test('usage is zero when no usage events arrive (prevents false autocompact)', async () => {
    // If usage stays 0, tokenCountWithEstimation will undercount — so at least
    // verify the field exists and is numeric (to detect regressions).
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'hi'),
      makeContentBlockStop(0),
      makeMessageDelta('end_turn', 0),
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    const usage = assistantMessages[0]!.message.usage as any
    expect(typeof usage.input_tokens).toBe('number')
    expect(typeof usage.output_tokens).toBe('number')
  })
})

describe('queryModelOpenAI — terminal message assembly', () => {
  test('yields exactly one AssistantMessage per message_stop when content is present', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'only once'),
      makeContentBlockStop(0),
      makeMessageDelta('end_turn', 5),
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    expect(assistantMessages).toHaveLength(1)
  })

  test('thinking + text response yields exactly one AssistantMessage', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'thinking'),
      makeThinkingDelta(0, 'let me think'),
      makeContentBlockStop(0),
      makeContentBlockStart(1, 'text'),
      makeTextDelta(1, 'answer'),
      makeContentBlockStop(1),
      makeMessageDelta('end_turn', 30),
      makeMessageStop(),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    expect(assistantMessages).toHaveLength(1)
  })

  test('surfaces an API error when content is followed by abrupt EOF', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'abrupt end'),
    ]

    const { assistantMessages } = await runQueryModel(_nextEvents)

    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]!.isApiErrorMessage).toBe(true)
    expect(assistantMessages[0]!.message.content).not.toContainEqual(
      expect.objectContaining({ text: 'abrupt end' }),
    )
  })
})

describe('queryModelOpenAI — stream_events forwarded', () => {
  test('every adapted event is also yielded as stream_event for real-time display', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'hello'),
      makeContentBlockStop(0),
      makeMessageDelta('end_turn', 5),
      makeMessageStop(),
    ]

    const { streamEvents } = await runQueryModel(_nextEvents)

    const eventTypes = streamEvents.map(e => (e as any).event?.type)
    expect(eventTypes).toContain('message_start')
    expect(eventTypes).toContain('content_block_start')
    expect(eventTypes).toContain('content_block_delta')
    expect(eventTypes).toContain('content_block_stop')
    expect(eventTypes).toContain('message_delta')
    expect(eventTypes).toContain('message_stop')
  })
})

describe('queryModelOpenAI — retry boundaries', () => {
  const transientRequestError = () =>
    new realModelProvider.ProviderAPIError(
      503,
      'temporarily unavailable',
      null,
      1,
    )
  const transientStreamError = () =>
    new realModelProvider.ProviderStreamError('stream disconnected', {
      kind: 'provider',
      retryable: true,
      terminal: false,
      retryAfterMs: 1,
    })
  const completedEvents = (text: string) => [
    makeMessageStart(),
    makeContentBlockStart(0, 'text'),
    makeTextDelta(0, text),
    makeContentBlockStop(0),
    makeMessageDelta('end_turn', 5),
    makeMessageStop(),
  ]

  test('retries a transient handshake failure and emits api_retry metadata', async () => {
    const { assistantMessages, otherOutputs } = await runQueryModel(
      [],
      { OPENAI_REQUEST_MAX_RETRIES: '1' },
      [
        { handshakeError: transientRequestError() },
        { events: completedEvents('recovered'), requestId: 'req_recovered' },
      ],
    )

    expect(_createCalls).toBe(2)
    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]!.requestId).toBe('req_recovered')
    expect(otherOutputs).toHaveLength(1)
    expect(otherOutputs[0]).toMatchObject({
      type: 'system',
      subtype: 'api_error',
      retryAttempt: 1,
      maxRetries: 1,
      retryInMs: 1,
    })
  })

  test('honors explicit 502 delay and keeps retry UI concise by default', async () => {
    const empty502 = Object.assign(new Error('502 status code (no body)'), {
      status: 502,
      headers: new Headers({ 'retry-after': '0' }),
    })
    empty502.stack =
      'Error: 502 status code (no body)\n    at generate (/$bunfs/root/cli.js:1)\n    at makeRequest (/$bunfs/root/cli.js:2)'

    const { assistantMessages, otherOutputs } = await runQueryModel(
      [],
      { OPENAI_REQUEST_MAX_RETRIES: '1' },
      [
        { handshakeError: empty502 },
        { events: completedEvents('recovered'), requestId: 'req_recovered' },
      ],
    )

    expect(_createCalls).toBe(2)
    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]!.requestId).toBe('req_recovered')
    expect(otherOutputs).toHaveLength(1)
    expect(otherOutputs[0]).toMatchObject({
      type: 'system',
      subtype: 'api_error',
      retryAttempt: 1,
      maxRetries: 1,
      retryInMs: 0,
    })
    expect(otherOutputs[0].error.message).not.toContain('at generate')
    expect(otherOutputs[0].error.message).not.toContain('at makeRequest')
  })

  test('retries a pre-semantic stream failure without leaking its prelude', async () => {
    const { assistantMessages, streamEvents, otherOutputs } =
      await runQueryModel([], { OPENAI_STREAM_MAX_RETRIES: '1' }, [
        {
          events: [makeMessageStart(), makeContentBlockStart(0, 'text')],
          streamError: transientStreamError(),
        },
        { events: completedEvents('recovered') },
      ])

    expect(_createCalls).toBe(2)
    expect(assistantMessages).toHaveLength(1)
    expect(
      streamEvents.filter(e => (e as any).event.type === 'message_start'),
    ).toHaveLength(1)
    expect(otherOutputs[0]).toMatchObject({
      type: 'system',
      subtype: 'api_error',
      retryAttempt: 1,
      maxRetries: 1,
    })
  })

  test('uses response-level Retry-After for a pre-semantic stream retry', async () => {
    const streamError = new realModelProvider.ProviderStreamError(
      'stream disconnected',
      {
        kind: 'provider',
        retryable: true,
        terminal: false,
      },
    )
    const { assistantMessages, otherOutputs } = await runQueryModel(
      [],
      { OPENAI_STREAM_MAX_RETRIES: '1' },
      [
        {
          events: [makeMessageStart()],
          streamError,
          retryAfter: '0',
        },
        { events: completedEvents('recovered') },
      ],
    )

    expect(assistantMessages).toHaveLength(1)
    expect(otherOutputs[0]).toMatchObject({
      type: 'system',
      subtype: 'api_error',
      retryInMs: 0,
      retryAttempt: 1,
    })
  })

  test('keeps request and stream retry budgets independent', async () => {
    const { assistantMessages, otherOutputs } = await runQueryModel(
      [],
      {
        OPENAI_REQUEST_MAX_RETRIES: '1',
        OPENAI_STREAM_MAX_RETRIES: '1',
      },
      [
        { handshakeError: transientRequestError() },
        {
          events: [makeMessageStart()],
          streamError: transientStreamError(),
        },
        { events: completedEvents('recovered') },
      ],
    )

    expect(_createCalls).toBe(3)
    expect(assistantMessages).toHaveLength(1)
    expect(otherOutputs.map(output => output.retryAttempt)).toEqual([1, 1])
  })

  test('retries after thinking-only then stream error', async () => {
    const { assistantMessages, otherOutputs } = await runQueryModel(
      [],
      { OPENAI_STREAM_MAX_RETRIES: '1' },
      [
        {
          events: [
            makeMessageStart(),
            makeContentBlockStart(0, 'thinking'),
            makeThinkingDelta(0, 'visible'),
            makeSignatureDelta(0, 'signature'),
          ],
          streamError: transientStreamError(),
        },
        { events: completedEvents('recovered after think') },
      ],
    )

    expect(_createCalls).toBe(2)
    expect(otherOutputs).toHaveLength(1)
    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]!.isApiErrorMessage).toBeUndefined()
  })

  const committedFailures: Array<{
    name: string
    events: BetaRawMessageStreamEvent[]
  }> = [
    {
      name: 'text',
      events: [
        makeMessageStart(),
        makeContentBlockStart(0, 'text'),
        makeTextDelta(0, 'visible'),
      ],
    },
    {
      name: 'tool identity',
      events: [makeMessageStart(), makeContentBlockStart(0, 'tool_use')],
    },
    {
      name: 'tool arguments',
      events: [
        makeMessageStart(),
        makeContentBlockStart(0, 'tool_use', { id: '', name: '' }),
        makeInputJsonDelta(0, '{"cmd":"ls"}'),
      ],
    },
  ]

  for (const scenario of committedFailures) {
    test(`does not retry after ${scenario.name} becomes visible`, async () => {
      const { assistantMessages, otherOutputs } = await runQueryModel(
        [],
        { OPENAI_STREAM_MAX_RETRIES: '1' },
        [
          {
            events: scenario.events,
            streamError: transientStreamError(),
          },
          { events: completedEvents('must not replay') },
        ],
      )

      expect(_createCalls).toBe(1)
      expect(otherOutputs).toHaveLength(0)
      expect(assistantMessages).toHaveLength(1)
      expect(assistantMessages[0]!.isApiErrorMessage).toBe(true)
    })
  }

  test('propagates the successful request ID to the final assistant message', async () => {
    const { assistantMessages } = await runQueryModel(
      completedEvents('ok'),
      {},
      [{ events: completedEvents('ok'), requestId: 'req_final' }],
    )

    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]!.requestId).toBe('req_final')
  })

  test('does not retry user cancellation', async () => {
    const abort = Object.assign(new Error('request was aborted'), {
      name: 'AbortError',
    })

    let rejection: unknown
    try {
      await runQueryModel([], { OPENAI_REQUEST_MAX_RETRIES: '1' }, [
        { handshakeError: abort },
        { events: completedEvents('must not retry') },
      ])
    } catch (error) {
      rejection = error
    }

    expect(rejection).toBeInstanceOf(APIUserAbortError)
    expect(_createCalls).toBe(1)
  })
})

describe('queryModelOpenAI — max_tokens forwarded to request', () => {
  test('official OpenAI requests include max_tokens and a session cache key', async () => {
    _nextEvents = [
      makeMessageStart(),
      makeContentBlockStart(0, 'text'),
      makeTextDelta(0, 'hi'),
      makeContentBlockStop(0),
      makeMessageDelta('end_turn', 5),
      makeMessageStop(),
    ]

    await runQueryModel(_nextEvents, {
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
    })

    expect(_lastCreateArgs).not.toBeNull()
    expect(_lastCreateArgs!.max_tokens).toBe(8192)
    expect(_lastCreateArgs!.prompt_cache_key).toStartWith('ccb:')
    expect(_lastAdapterOptions?.includeCacheWriteTokens).toBe(true)
  })

  test('compatible providers do not receive OpenAI cache parameters', async () => {
    _nextEvents = [makeMessageStart(), makeMessageStop()]

    await runQueryModel(_nextEvents, {
      OPENAI_BASE_URL: 'https://api.deepseek.com/v1',
      OPENAI_PROMPT_CACHE_KEY: 'explicit-key',
    })

    expect(_lastCreateArgs).not.toBeNull()
    expect('prompt_cache_key' in _lastCreateArgs!).toBe(false)
    expect(_lastAdapterOptions?.includeCacheWriteTokens).toBe(false)
  })
})

describe('queryModelOpenAI — deferred MCP tool visibility', () => {
  test('prepends available deferred MCP tools to OpenAI messages', async () => {
    _searchExtraToolsEnabled = true
    _nextEvents = [makeMessageStart(), makeMessageStop()]

    try {
      const { queryModelOpenAI } = await import('../index.js')
      const tools: any[] = [
        {
          name: 'SearchExtraTools',
          isMcp: false,
          input_schema: { type: 'object', properties: {} },
          prompt: async () => 'Search deferred tools',
        },
        {
          name: 'mcp__wechat__send_message',
          isMcp: true,
          input_schema: { type: 'object', properties: {} },
          prompt: async () => 'Send a WeChat message',
        },
      ]

      const options: any = {
        model: 'test-model',
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
      }

      for await (const _item of queryModelOpenAI(
        [],
        { type: 'text', text: '' } as any,
        tools as any,
        new AbortController().signal,
        options,
      )) {
        // Exhaust generator so request body is built.
      }

      expect(_lastCreateArgs).not.toBeNull()
      expect(JSON.stringify(_lastCreateArgs!.messages)).toContain(
        '<available-deferred-tools>\\nmcp__wechat__send_message\\n</available-deferred-tools>',
      )
    } finally {
      _searchExtraToolsEnabled = false
    }
  })
})
