import { afterEach, describe, expect, test } from 'bun:test'
import { ProviderStreamError } from '@ant/model-provider'
import { isTransientOpenAIError } from '../../openai/openaiShared.js'
import { streamCodexAttempt } from '../streaming.js'

function makeResponse(id = 'resp_1') {
  return {
    id,
    object: 'response',
    created_at: 0,
    model: 'gpt-5.4',
    output: [],
    output_text: '',
    usage: {
      input_tokens: 1,
      output_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
    },
  }
}

function hangingStream(events: object[], hang = false) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event
      }
      if (hang) {
        await new Promise(() => {})
      }
    },
    async finalResponse() {
      return undefined
    },
  }
}

function clientFor(stream: ReturnType<typeof hangingStream>) {
  return {
    responses: {
      stream: () => stream,
    },
  } as unknown as Parameters<typeof streamCodexAttempt>[0]['client']
}

async function drain(
  stream: AsyncGenerator<unknown, unknown>,
): Promise<{ error?: unknown; value?: unknown }> {
  try {
    while (true) {
      const next = await stream.next()
      if (next.done) return { value: next.value }
    }
  } catch (error) {
    return { error }
  }
}

describe('streamCodexAttempt retry gate', () => {
  const savedTimeout = process.env.OPENAI_STREAM_IDLE_TIMEOUT_MS

  afterEach(() => {
    if (savedTimeout === undefined)
      delete process.env.OPENAI_STREAM_IDLE_TIMEOUT_MS
    else process.env.OPENAI_STREAM_IDLE_TIMEOUT_MS = savedTimeout
  })

  test('idle hang after message_start stays retryable', async () => {
    process.env.OPENAI_STREAM_IDLE_TIMEOUT_MS = '20'
    const stream = streamCodexAttempt({
      client: clientFor(
        hangingStream(
          [{ type: 'response.created', response: makeResponse() }],
          true,
        ),
      ),
      requestBody: { model: 'gpt-5.4', input: [] } as never,
      signal: new AbortController().signal,
      start: Date.now(),
    })
    const { error } = await drain(stream)
    expect(error).toBeInstanceOf(ProviderStreamError)
    expect((error as ProviderStreamError).kind).toBe('idle_timeout')
    expect((error as ProviderStreamError).retryable).toBe(true)
    expect(isTransientOpenAIError(error)).toBe(true)
  })

  test('idle hang after text delta stays retryable', async () => {
    process.env.OPENAI_STREAM_IDLE_TIMEOUT_MS = '20'
    const stream = streamCodexAttempt({
      client: clientFor(
        hangingStream(
          [
            { type: 'response.created', response: makeResponse() },
            {
              type: 'response.output_text.delta',
              output_index: 0,
              delta: 'hello',
            },
          ],
          true,
        ),
      ),
      requestBody: { model: 'gpt-5.4', input: [] } as never,
      signal: new AbortController().signal,
      start: Date.now(),
    })
    const { error } = await drain(stream)
    expect(error).toBeInstanceOf(ProviderStreamError)
    expect((error as ProviderStreamError).kind).toBe('idle_timeout')
    expect((error as ProviderStreamError).retryable).toBe(true)
    expect(isTransientOpenAIError(error)).toBe(true)
  })

  test('missing terminal event is retryable premature_eof', async () => {
    const stream = streamCodexAttempt({
      client: clientFor(hangingStream([])),
      requestBody: { model: 'gpt-5.4', input: [] } as never,
      signal: new AbortController().signal,
      start: Date.now(),
    })
    const { error } = await drain(stream)
    expect(error).toBeInstanceOf(ProviderStreamError)
    expect((error as ProviderStreamError).kind).toBe('premature_eof')
    expect((error as ProviderStreamError).retryable).toBe(true)
    expect(isTransientOpenAIError(error)).toBe(true)
  })

  test('keeps interleaved parallel function call arguments separated', async () => {
    const response = makeResponse('resp_parallel')
    const stream = streamCodexAttempt({
      client: clientFor(
        hangingStream([
          { type: 'response.created', response },
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              type: 'function_call',
              id: 'item_shell',
              call_id: 'call_shell',
              name: 'Bash',
              arguments: '',
            },
          },
          {
            type: 'response.output_item.added',
            output_index: 1,
            item: {
              type: 'function_call',
              id: 'item_read',
              call_id: 'call_read',
              name: 'Read',
              arguments: '',
            },
          },
          {
            type: 'response.function_call_arguments.delta',
            output_index: 0,
            item_id: 'item_shell',
            delta: '{"command":"git ',
          },
          {
            type: 'response.function_call_arguments.delta',
            output_index: 1,
            item_id: 'item_read',
            delta: '{"file_path":"/tmp/',
          },
          {
            type: 'response.function_call_arguments.delta',
            output_index: 0,
            item_id: 'item_shell',
            delta: 'status"}',
          },
          {
            type: 'response.function_call_arguments.delta',
            output_index: 1,
            item_id: 'item_read',
            delta: 'a"}',
          },
          {
            type: 'response.function_call_arguments.done',
            output_index: 0,
            item_id: 'item_shell',
            name: 'Bash',
            arguments: '{"command":"git status"}',
          },
          {
            type: 'response.function_call_arguments.done',
            output_index: 1,
            item_id: 'item_read',
            name: 'Read',
            arguments: '{"file_path":"/tmp/a"}',
          },
          { type: 'response.completed', response },
        ]),
      ),
      requestBody: { model: 'gpt-5.4', input: [] } as never,
      signal: new AbortController().signal,
      start: Date.now(),
    })

    const { error, value } = await drain(stream)

    expect(error).toBeUndefined()
    expect((value as { assistantBlocks: unknown[] }).assistantBlocks).toEqual([
      {
        type: 'tool_use',
        id: 'call_shell',
        name: 'Bash',
        input: '{"command":"git status"}',
      },
      {
        type: 'tool_use',
        id: 'call_read',
        name: 'Read',
        input: '{"file_path":"/tmp/a"}',
      },
    ])
  })
})
