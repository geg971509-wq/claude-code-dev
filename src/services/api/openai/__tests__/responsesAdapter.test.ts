import { describe, expect, test } from 'bun:test'
import { ProviderAPIError } from '@ant/model-provider'
import { calculateCacheHitRate } from '../../../../utils/cacheWarning.js'
import {
  adaptResponsesStreamToAnthropic,
  buildResponsesRequest,
  extractUsage,
  parseSSE,
} from '../responsesAdapter.js'
import {
  formatHttpStatusError,
  formatOpenAIErrorMessage,
  formatOpenAIErrorStack,
  formatOpenAIErrorWithStack,
  formatOpenAIPromptCacheKey,
  isOpenAIUserAbortError,
  throwHttpStatusError,
  toProviderHttpError,
} from '../openaiShared.js'

async function collectStopReason(
  events: Array<Record<string, unknown>>,
): Promise<string | null | undefined> {
  async function* stream() {
    for (const event of events) yield event
  }
  let stopReason: string | null | undefined
  for await (const event of adaptResponsesStreamToAnthropic(
    stream(),
    'gpt-5.5',
  )) {
    if (event.type === 'message_delta') {
      stopReason = (event as { delta?: { stop_reason?: string | null } }).delta
        ?.stop_reason
    }
  }
  return stopReason
}

describe('buildResponsesRequest', () => {
  const promptCacheKey = formatOpenAIPromptCacheKey('session-abc-123')

  test('includes max reasoning effort for ChatGPT Responses requests', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
      reasoningEffort: 'max',
      promptCacheKey,
    })

    expect(request.reasoning).toEqual({ effort: 'max' })
  })

  test('includes reasoning effort for ChatGPT Responses requests', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
      reasoningEffort: 'xhigh',
      promptCacheKey,
    })

    expect(request.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' })
  })

  test('user content is input_text parts; assistant text is output_text parts', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,abc' },
            },
          ],
        },
      ],
      tools: [],
      toolChoice: undefined,
    })

    expect(request.input).toContainEqual({
      role: 'user',
      content: [{ type: 'input_text', text: 'hello' }],
    })
    expect(request.input).toContainEqual({
      role: 'assistant',
      content: [{ type: 'output_text', text: 'hi there' }],
    })
    expect(request.input).toContainEqual({
      role: 'user',
      content: [
        { type: 'input_text', text: 'look' },
        { type: 'input_image', image_url: 'data:image/png;base64,abc' },
      ],
    })
  })

  test('omits max_output_tokens when not provided (Codex path)', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
      promptCacheKey,
    }) as Record<string, unknown>

    expect('max_output_tokens' in request).toBe(false)
  })

  test('includes stable prompt_cache_key for session-sticky cache routing', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
      promptCacheKey,
    })

    expect(request.prompt_cache_key).toBe('ccb:session-abc-123')
  })

  test('prompt_cache_key is stable across turns (not derived from messages)', () => {
    const key = formatOpenAIPromptCacheKey('same-session')
    const turn1 = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'first' }],
      tools: [],
      toolChoice: undefined,
      promptCacheKey: key,
    })
    const turn2 = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'second' },
      ],
      tools: [],
      toolChoice: undefined,
      promptCacheKey: key,
    })

    expect(turn1.prompt_cache_key).toBe(turn2.prompt_cache_key)
    expect(turn1.prompt_cache_key).toBe('ccb:same-session')
  })
})

describe('extractUsage (OpenAI Responses → Anthropic usage)', () => {
  test('subtracts cached_tokens so hit rate uses OpenAI total as denominator', () => {
    const usage = extractUsage({
      usage: {
        input_tokens: 30_000,
        output_tokens: 100,
        input_tokens_details: { cached_tokens: 20_000 },
      },
    })

    expect(usage).toEqual({
      input_tokens: 10_000,
      output_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 20_000,
    })

    // Was 40% under the double-count bug; correct is 66.7%.
    const hitRate = calculateCacheHitRate(usage)
    expect(hitRate).toBeCloseTo((20_000 / 30_000) * 100, 5)
  })

  test('full cache hit can report 100% (not capped at 50%)', () => {
    const usage = extractUsage({
      usage: {
        input_tokens: 30_000,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 30_000 },
      },
    })

    expect(usage.input_tokens).toBe(0)
    expect(usage.cache_read_input_tokens).toBe(30_000)
    expect(calculateCacheHitRate(usage)).toBe(100)
  })

  test('maps cache_write_tokens to cache_creation without double-counting total', () => {
    const usage = extractUsage({
      usage: {
        input_tokens: 10_000,
        output_tokens: 10,
        input_tokens_details: {
          cached_tokens: 6_000,
          cache_write_tokens: 2_000,
        },
      },
    })

    expect(usage).toEqual({
      input_tokens: 2_000,
      output_tokens: 10,
      cache_creation_input_tokens: 2_000,
      cache_read_input_tokens: 6_000,
    })
    // segments sum to OpenAI total
    expect(
      usage.input_tokens +
        usage.cache_creation_input_tokens +
        usage.cache_read_input_tokens,
    ).toBe(10_000)
    expect(calculateCacheHitRate(usage)).toBeCloseTo(60, 5)
  })

  test('clamps overlapping write/read that exceed total input', () => {
    const usage = extractUsage({
      usage: {
        input_tokens: 5_000,
        output_tokens: 0,
        input_tokens_details: {
          cached_tokens: 4_000,
          cache_write_tokens: 4_000,
        },
      },
    })

    expect(
      usage.input_tokens +
        usage.cache_creation_input_tokens +
        usage.cache_read_input_tokens,
    ).toBe(5_000)
    expect(usage.cache_read_input_tokens).toBe(4_000)
    expect(usage.cache_creation_input_tokens).toBe(1_000)
    expect(usage.input_tokens).toBe(0)
  })
})

describe('buildResponsesRequest protocol fields', () => {
  test('includes max_output_tokens for official Responses when provided', () => {
    const request = buildResponsesRequest({
      model: 'o3',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
      maxOutputTokens: 64000,
    }) as Record<string, unknown>

    expect(request.max_output_tokens).toBe(64000)
  })

  test('includes encrypted reasoning by default; store false unless Azure', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
      store: false,
    }) as Record<string, unknown>

    expect(request.include).toEqual(['reasoning.encrypted_content'])
    expect(request.store).toBe(false)
  })

  test('store true when explicitly set (Azure Responses)', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
      store: true,
    }) as Record<string, unknown>

    expect(request.store).toBe(true)
  })

  test('includes prompt_cache_key when provided', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
      promptCacheKey: 'session-abc',
    }) as Record<string, unknown>

    expect(request.prompt_cache_key).toBe('session-abc')
  })

  test('replays encrypted reasoning from prior assistant message', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: 'ok',
          encrypted_content: 'enc_abc',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'Bash', arguments: '{}' },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: 'done',
        },
      ],
      tools: [],
      toolChoice: undefined,
    })

    expect(request.input).toContainEqual({
      type: 'reasoning',
      encrypted_content: 'enc_abc',
      summary: [],
    })
  })
})

describe('adaptResponsesStreamToAnthropic stop_reason', () => {
  test('function_call stream maps to tool_use', async () => {
    const stopReason = await collectStopReason([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'function_call',
          call_id: 'call_1',
          name: 'Bash',
        },
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: '{"command":"ls"}',
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'function_call',
          call_id: 'call_1',
          name: 'Bash',
          arguments: '{"command":"ls"}',
        },
      },
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ])

    expect(stopReason).toBe('tool_use')
  })

  test('text-only complete stream maps to end_turn', async () => {
    const stopReason = await collectStopReason([
      {
        type: 'response.output_text.delta',
        delta: 'hello',
      },
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: { input_tokens: 3, output_tokens: 1 },
        },
      },
    ])

    expect(stopReason).toBe('end_turn')
  })

  test('incomplete stream without max_output_tokens fails closed', async () => {
    await expect(
      collectStopReason([
        { type: 'response.output_text.delta', delta: 'partial' },
        {
          type: 'response.incomplete',
          response: {
            status: 'incomplete',
            incomplete_details: { reason: 'server_error' },
            usage: { input_tokens: 3, output_tokens: 1 },
          },
        },
      ]),
    ).rejects.toMatchObject({
      name: 'ProviderStreamError',
      kind: 'incomplete',
      retryable: true,
      incompleteReason: 'server_error',
    })
  })

  test('incomplete_details.max_output_tokens maps to max_tokens', async () => {
    const stopReason = await collectStopReason([
      {
        type: 'response.output_text.delta',
        delta: 'partial',
      },
      {
        type: 'response.incomplete',
        response: {
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          usage: { input_tokens: 3, output_tokens: 1 },
        },
      },
    ])

    expect(stopReason).toBe('max_tokens')
  })
})

describe('adaptResponsesStreamToAnthropic errors', () => {
  test('top-level error event throws with code:message', async () => {
    async function* stream() {
      yield {
        type: 'error',
        code: 'rate_limit_exceeded',
        message: 'Slow down',
      }
    }
    await expect(async () => {
      for await (const _ of adaptResponsesStreamToAnthropic(stream(), 'o3')) {
        // drain
      }
    }).toThrow(/rate_limit_exceeded: Slow down/)
  })
})

describe('adaptResponsesStreamToAnthropic item_id tool deltas', () => {
  test('function_call_arguments.delta keyed by item_id still streams args', async () => {
    async function* stream() {
      yield {
        type: 'response.output_item.added',
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'Bash',
        },
      }
      yield {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        delta: '{"command":"pwd"}',
      }
      yield {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'Bash',
          arguments: '{"command":"pwd"}',
        },
      }
      yield {
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }
    }

    const events: Array<{ type: string }> = []
    for await (const event of adaptResponsesStreamToAnthropic(stream(), 'o3')) {
      events.push(event as { type: string })
    }
    const deltas = events.filter(
      e =>
        e.type === 'content_block_delta' &&
        (e as { delta?: { type?: string } }).delta?.type === 'input_json_delta',
    )
    expect(deltas.length).toBeGreaterThan(0)
    const stop = events.find(e => e.type === 'message_delta') as
      | { delta?: { stop_reason?: string } }
      | undefined
    expect(stop?.delta?.stop_reason).toBe('tool_use')
  })
})

describe('adaptResponsesStreamToAnthropic tool JSON + encrypted reasoning', () => {
  test('rejects invalid tool arguments at finish', async () => {
    async function* stream() {
      yield {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'function_call',
          call_id: 'call_bad',
          name: 'Bash',
        },
      }
      yield {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: '{not-json',
      }
      yield {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'function_call',
          call_id: 'call_bad',
          name: 'Bash',
          arguments: '{not-json',
        },
      }
    }

    await expect(async () => {
      for await (const _ of adaptResponsesStreamToAnthropic(stream(), 'o3')) {
        // drain
      }
    }).toThrow(/invalid JSON arguments/)
  })

  test('maps reasoning_tokens and encrypted signature', async () => {
    async function* stream() {
      yield {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: 'rs_1',
          encrypted_content: 'enc_xyz',
        },
      }
      yield {
        type: 'response.reasoning_summary_text.delta',
        delta: 'think',
      }
      yield {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: 'rs_1',
          encrypted_content: 'enc_xyz',
        },
      }
      yield {
        type: 'response.output_text.delta',
        delta: 'hi',
      }
      yield {
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            output_tokens_details: { reasoning_tokens: 3 },
          },
        },
      }
    }

    const events = []
    for await (const event of adaptResponsesStreamToAnthropic(
      stream(),
      'gpt-5',
    )) {
      events.push(event)
    }

    const sig = events.find(
      e =>
        e.type === 'content_block_delta' &&
        (e as { delta?: { type?: string } }).delta?.type === 'signature_delta',
    ) as { delta?: { signature?: string } } | undefined
    expect(sig?.delta?.signature).toBe('enc_xyz')

    const delta = events.find(e => e.type === 'message_delta') as {
      usage?: { reasoning_tokens?: number }
    }
    expect(delta.usage?.reasoning_tokens).toBe(3)
  })

  test('separates reasoning summary parts and items', async () => {
    async function* stream() {
      yield {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_1' },
      }
      yield {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        delta: '**Inspecting WireGuard ',
      }
      yield {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        delta: 'runtime API**',
      }
      yield {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 1,
        delta: '**Planning exact dependency reads**',
      }
      yield {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_1' },
      }
      yield {
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'reasoning', id: 'rs_2' },
      }
      yield {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_2',
        output_index: 1,
        summary_index: 0,
        delta: '**Checking runtime exports**',
      }
      yield {
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }
    }

    const fragments: string[] = []
    for await (const event of adaptResponsesStreamToAnthropic(
      stream(),
      'gpt-5',
    )) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'thinking_delta'
      ) {
        fragments.push(event.delta.thinking)
      }
    }

    expect(fragments.join('')).toBe(
      '**Inspecting WireGuard runtime API**\n\n' +
        '**Planning exact dependency reads**\n\n' +
        '**Checking runtime exports**',
    )
  })

  test('keeps reasoning item identity across partial identifiers', async () => {
    async function* stream() {
      yield {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_1' },
      }
      yield {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_1',
        summary_index: 0,
        delta: 'A',
      }
      yield {
        type: 'response.reasoning_summary_text.delta',
        output_index: 0,
        summary_index: 0,
        delta: 'B',
      }
      yield {
        type: 'response.completed',
        response: { status: 'completed' },
      }
    }

    const fragments: string[] = []
    for await (const event of adaptResponsesStreamToAnthropic(
      stream(),
      'gpt-5',
    )) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'thinking_delta'
      ) {
        fragments.push(event.delta.thinking)
      }
    }

    expect(fragments.join('')).toBe('AB')
  })
})

describe('adaptResponsesStreamToAnthropic terminal lifecycle', () => {
  test('rejects completed events without matching response status', async () => {
    async function* stream() {
      yield { type: 'response.completed' }
    }
    await expect(
      (async () => {
        for await (const _ of adaptResponsesStreamToAnthropic(stream(), 'o3')) {
          // drain
        }
      })(),
    ).rejects.toMatchObject({
      name: 'ProviderStreamError',
      kind: 'protocol',
      retryable: false,
    })
  })

  test('rejects provider error objects without a top-level type', async () => {
    async function* stream() {
      yield {
        error: {
          message: 'provider exploded',
          code: 'server_error',
          type: 'server_error',
        },
      }
      yield {
        type: 'response.completed',
        response: { status: 'completed' },
      }
    }
    await expect(
      (async () => {
        for await (const _ of adaptResponsesStreamToAnthropic(stream(), 'o3')) {
          // drain
        }
      })(),
    ).rejects.toMatchObject({
      name: 'ProviderStreamError',
      kind: 'provider',
      code: 'server_error',
      type: 'server_error',
    })
  })

  test('throws when stream ends without response.completed/incomplete', async () => {
    async function* stream() {
      yield {
        type: 'response.output_text.delta',
        delta: 'partial',
      }
    }
    await expect(async () => {
      for await (const _ of adaptResponsesStreamToAnthropic(stream(), 'o3')) {
        // drain
      }
    }).toThrow(/stream closed before response\.completed/)
  })

  test('empty stream without terminal event also fails closed', async () => {
    async function* stream() {
      // no events
    }
    await expect(async () => {
      for await (const _ of adaptResponsesStreamToAnthropic(stream(), 'o3')) {
        // drain
      }
    }).toThrow(/stream closed before response\.completed/)
  })
})

function sseResponseFromChunks(chunks: string[]): Response {
  const encoder = new TextEncoder()
  let i = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[i++]))
    },
  })
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

describe('parseSSE framing', () => {
  test('parses LF-delimited frames', async () => {
    const response = sseResponseFromChunks([
      'data: {"type":"response.output_text.delta","delta":"a"}\n\n',
      'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ])
    const events: Array<Record<string, unknown>> = []
    for await (const event of parseSSE(response)) events.push(event)
    expect(events.map(e => e.type)).toEqual([
      'response.output_text.delta',
      'response.completed',
    ])
  })

  test('parses CRLF-delimited frames and split chunks', async () => {
    // Split mid-frame and use \r\n\r\n separators (common on Windows proxies).
    const response = sseResponseFromChunks([
      'data: {"type":"response.output_text.delta","del',
      'ta":"hi"}\r\n\r\ndata: {"type":"response.completed","response":{"status":"completed"}}\r\n\r\n',
    ])
    const events: Array<Record<string, unknown>> = []
    for await (const event of parseSSE(response)) events.push(event)
    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({
      type: 'response.output_text.delta',
      delta: 'hi',
    })
    expect(events[1]?.type).toBe('response.completed')
  })

  test('flushes trailing frame without final blank line', async () => {
    const response = sseResponseFromChunks([
      'data: {"type":"response.completed","response":{"status":"completed"}}',
    ])
    const events: Array<Record<string, unknown>> = []
    for await (const event of parseSSE(response)) events.push(event)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('response.completed')
  })

  test('malformed SSE JSON throws greppable parse error', async () => {
    const response = sseResponseFromChunks(['data: {not-json}\n\n'])
    await expect(async () => {
      for await (const _ of parseSSE(response)) {
        // drain
      }
    }).toThrow(/Responses SSE JSON parse failed/)
  })
})

describe('isOpenAIUserAbortError', () => {
  test('detects AbortError / APIUserAbortError names', () => {
    expect(
      isOpenAIUserAbortError(
        Object.assign(new Error('x'), { name: 'AbortError' }),
      ),
    ).toBe(true)
    expect(
      isOpenAIUserAbortError(
        Object.assign(new Error('x'), { name: 'APIUserAbortError' }),
      ),
    ).toBe(true)
  })

  test('detects undici abort code and common messages', () => {
    expect(isOpenAIUserAbortError({ code: 'ABORT_ERR', message: '' })).toBe(
      true,
    )
    expect(isOpenAIUserAbortError(new Error('Request was aborted'))).toBe(true)
    expect(isOpenAIUserAbortError(new Error('403 status code (no body)'))).toBe(
      false,
    )
  })
})

describe('formatOpenAIErrorMessage', () => {
  test('keeps SDK empty-body status message', () => {
    expect(
      formatOpenAIErrorMessage(new Error('403 status code (no body)')),
    ).toBe('403 status code (no body)')
  })

  test('promotes numeric status/code when absent from message', () => {
    const err = Object.assign(new Error('permission denied'), {
      status: 403,
      code: 'model_not_found',
    })
    expect(formatOpenAIErrorMessage(err)).toBe(
      '403 permission denied (code=model_not_found)',
    )
  })

  test('does not duplicate status already present in message', () => {
    const err = Object.assign(new Error('403 status code (no body)'), {
      status: 403,
      code: 'insufficient_quota',
    })
    expect(formatOpenAIErrorMessage(err)).toBe(
      '403 status code (no body) (code=insufficient_quota)',
    )
  })

  test('status-only error synthesizes SDK empty-body wording', () => {
    expect(formatOpenAIErrorMessage({ status: 403 })).toBe(
      '403 status code (no body)',
    )
  })

  test('accepts statusCode alias', () => {
    expect(
      formatOpenAIErrorMessage({ statusCode: 502, message: 'bad gateway' }),
    ).toBe('502 bad gateway')
  })
})

describe('formatHttpStatusError', () => {
  test('empty body matches SDK wording', () => {
    expect(formatHttpStatusError('OpenAI Responses API request', 403)).toBe(
      'OpenAI Responses API request failed: 403 status code (no body)',
    )
  })

  test('includes clipped body text', () => {
    expect(
      formatHttpStatusError('ChatGPT Responses API request', 500, ' boom '),
    ).toBe('ChatGPT Responses API request failed: 500: boom')
  })

  test('preserves structured diagnostics from a raw provider body', () => {
    let rejection: unknown
    try {
      throwHttpStatusError(
        'OpenAI Responses API request',
        429,
        JSON.stringify({
          error: {
            message: 'The configured model is temporarily overloaded',
            code: 'model_overloaded',
            type: 'server_error',
            param: 'model',
          },
        }),
        new Headers({
          'x-request-id': 'req_raw',
          'retry-after': '2',
        }),
      )
    } catch (error) {
      rejection = error
    }

    expect(rejection).toBeInstanceOf(ProviderAPIError)
    expect(rejection).toMatchObject({
      requestId: 'req_raw',
      retryAfterMs: 2_000,
      code: 'model_overloaded',
      type: 'server_error',
      param: 'model',
    })
    expect((rejection as ProviderAPIError).bodyPreview).toContain(
      'configured model',
    )
    expect((rejection as Error).message).toBe(
      'OpenAI Responses API request failed: 429: The configured model is temporarily overloaded',
    )
  })

  test('preserves bounded diagnostics from an SDK error', () => {
    const error = Object.assign(new Error('invalid request'), {
      status: 400,
      requestID: 'req_sdk',
      code: 'invalid_request_error',
      type: 'invalid_request_error',
      param: 'input',
      headers: new Headers({ 'retry-after': '3' }),
      error: {
        message: 'The input is invalid',
        code: 'invalid_request_error',
      },
    })
    const layered = toProviderHttpError(error)

    expect(layered).toMatchObject({
      requestId: 'req_sdk',
      retryAfterMs: 3_000,
      code: 'invalid_request_error',
      type: 'invalid_request_error',
      param: 'input',
    })
    expect(layered?.bodyPreview).toContain('The input is invalid')
  })

  test('caps raw response detail at 500 characters', () => {
    const body = 'x'.repeat(600)
    expect(
      formatHttpStatusError('OpenAI Responses API request', 500, body),
    ).toBe(`OpenAI Responses API request failed: 500: ${'x'.repeat(499)}…`)
  })
})

describe('formatOpenAIErrorStack / withStack', () => {
  test('includes at frames from Error.stack', () => {
    const err = new Error('403 status code (no body)')
    err.stack =
      'Error: 403 status code (no body)\n    at queryModelOpenAI (index.ts:1)\n    at query (query.ts:2)'
    const stack = formatOpenAIErrorStack(err, 8)
    expect(stack).toContain('queryModelOpenAI')
    expect(stack).toContain('at query')
  })

  test('includes cause chain', () => {
    const root = new Error('upstream denied')
    root.stack = 'Error: upstream denied\n    at proxy (proxy.ts:1)'
    const err = new Error('403 status code (no body)')
    err.stack = 'Error: 403 status code (no body)\n    at openai (index.ts:1)'
    ;(err as Error & { cause?: unknown }).cause = root
    const stack = formatOpenAIErrorStack(err, 8)
    expect(stack).toContain('Caused by:')
    expect(stack).toContain('upstream denied')
  })

  test('user surface keeps message and short stack', () => {
    const err = Object.assign(new Error('permission denied'), {
      status: 403,
      stack:
        'Error: permission denied\n    at a (a.ts:1)\n    at b (b.ts:2)\n    at c (c.ts:3)',
    })
    const text = formatOpenAIErrorWithStack(err, 8)
    expect(text).toContain('403')
    expect(text).toContain('permission denied')
    expect(text).toContain('at a')
  })
})
