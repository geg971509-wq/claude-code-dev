import { describe, expect, test } from 'bun:test'
import {
  APIProviderRateLimitError,
  ProviderStreamError,
} from '@ant/model-provider'
import { isTransientOpenAIError } from '../../openai/openaiShared.js'
import { streamCodexAttempt } from '../streaming.js'

function makeResponse(
  id = 'resp_1',
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    object: 'response',
    created_at: 0,
    status: 'completed',
    model: 'gpt-5.4',
    output: [],
    output_text: '',
    usage: {
      input_tokens: 1,
      output_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
    },
    ...overrides,
  }
}

function eventStream(events: object[], finalResponse?: object) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event
      }
    },
    async finalResponse() {
      return finalResponse
    },
  }
}

function clientFor(stream: ReturnType<typeof eventStream>) {
  return {
    responses: {
      stream: () => stream,
    },
  } as unknown as Parameters<typeof streamCodexAttempt>[0]['client']
}

async function drain(stream: AsyncGenerator<unknown, unknown>) {
  const events: unknown[] = []
  try {
    while (true) {
      const next = await stream.next()
      if (next.done) {
        return { events, value: next.value, error: undefined }
      }
      events.push(next.value)
    }
  } catch (error) {
    return { events, value: undefined, error }
  }
}

describe('streamCodexAttempt Responses terminal semantics', () => {
  test('throws a typed retryable error for response.failed', async () => {
    const created = makeResponse('resp_failed_created', {
      status: 'in_progress',
    })
    const failed = makeResponse('resp_failed', {
      status: 'failed',
      error: {
        code: 'rate_limit_exceeded',
        message: 'Please try again in 0.25 seconds.',
      },
    })
    const stream = streamCodexAttempt({
      client: clientFor(
        eventStream([
          { type: 'response.created', response: created },
          { type: 'response.failed', response: failed },
        ]),
      ),
      requestBody: { model: 'gpt-5.4', input: [] } as never,
      signal: new AbortController().signal,
      start: Date.now(),
    })

    const { error, value } = await drain(stream)

    expect(value).toBeUndefined()
    expect(error).toBeInstanceOf(APIProviderRateLimitError)
    expect((error as APIProviderRateLimitError).retryAfterMs).toBe(250)
    expect(isTransientOpenAIError(error)).toBe(true)
  })

  test('throws for response.incomplete instead of emitting message_stop', async () => {
    const created = makeResponse('resp_incomplete_created', {
      status: 'in_progress',
    })
    const incomplete = makeResponse('resp_incomplete', {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    })
    const stream = streamCodexAttempt({
      client: clientFor(
        eventStream([
          { type: 'response.created', response: created },
          { type: 'response.incomplete', response: incomplete },
        ]),
      ),
      requestBody: { model: 'gpt-5.4', input: [] } as never,
      signal: new AbortController().signal,
      start: Date.now(),
    })

    const { error, events, value } = await drain(stream)

    expect(value).toBeUndefined()
    expect(error).toBeInstanceOf(ProviderStreamError)
    expect((error as ProviderStreamError).kind).toBe('incomplete')
    expect((error as ProviderStreamError).retryable).toBe(true)
    expect(events).not.toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({ type: 'message_stop' }),
      }),
    )
  })

  test('classifies top-level Responses error events', async () => {
    const stream = streamCodexAttempt({
      client: clientFor(
        eventStream([
          {
            type: 'error',
            code: 'server_is_overloaded',
            message: 'The service is overloaded.',
            request_id: 'req_overloaded',
          },
        ]),
      ),
      requestBody: { model: 'gpt-5.4', input: [] } as never,
      signal: new AbortController().signal,
      start: Date.now(),
    })

    const { error } = await drain(stream)

    expect(error).toBeInstanceOf(ProviderStreamError)
    expect((error as ProviderStreamError).code).toBe('server_is_overloaded')
    expect((error as ProviderStreamError).requestId).toBe('req_overloaded')
    expect((error as ProviderStreamError).retryable).toBe(true)
    expect(isTransientOpenAIError(error)).toBe(true)
  })

  test('concatenates all completed output text parts into one block', async () => {
    const created = makeResponse('resp_text_created', {
      status: 'in_progress',
    })
    const completed = makeResponse('resp_text')
    const completedItem = {
      type: 'message',
      id: 'msg_text',
      status: 'completed',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: 'hello ',
          annotations: [],
          logprobs: [],
        },
        {
          type: 'output_text',
          text: 'world',
          annotations: [],
          logprobs: [],
        },
      ],
    }
    const stream = streamCodexAttempt({
      client: clientFor(
        eventStream(
          [
            { type: 'response.created', response: created },
            {
              type: 'response.output_item.added',
              output_index: 0,
              item: { ...completedItem, status: 'in_progress', content: [] },
            },
            {
              type: 'response.output_text.delta',
              output_index: 0,
              content_index: 0,
              item_id: 'msg_text',
              delta: 'hello ',
              logprobs: [],
            },
            {
              type: 'response.output_text.done',
              output_index: 0,
              content_index: 0,
              item_id: 'msg_text',
              text: 'hello ',
              logprobs: [],
            },
            {
              type: 'response.output_text.delta',
              output_index: 0,
              content_index: 1,
              item_id: 'msg_text',
              delta: 'world',
              logprobs: [],
            },
            {
              type: 'response.output_text.done',
              output_index: 0,
              content_index: 1,
              item_id: 'msg_text',
              text: 'world',
              logprobs: [],
            },
            {
              type: 'response.output_item.done',
              output_index: 0,
              item: completedItem,
            },
            { type: 'response.completed', response: completed },
          ],
          completed,
        ),
      ),
      requestBody: { model: 'gpt-5.4', input: [] } as never,
      signal: new AbortController().signal,
      start: Date.now(),
    })

    const { error, events, value } = await drain(stream)

    expect(error).toBeUndefined()
    expect((value as { assistantBlocks: unknown[] }).assistantBlocks).toEqual([
      { type: 'text', text: 'hello world' },
    ])
    const stops = events.filter(
      candidate =>
        (candidate as { event?: { type?: string } }).event?.type ===
        'content_block_stop',
    )
    expect(stops).toHaveLength(1)
  })
})
