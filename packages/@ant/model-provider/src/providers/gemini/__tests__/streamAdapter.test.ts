import { describe, expect, test } from 'bun:test'
import { ProviderStreamError } from '../../../types/providerErrors.js'
import { adaptGeminiStreamToAnthropic } from '../streamAdapter.js'
import type { GeminiStreamChunk } from '../types.js'

function mockStream(
  chunks: GeminiStreamChunk[],
): AsyncIterable<GeminiStreamChunk> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0
      return {
        async next() {
          if (index >= chunks.length) {
            return { done: true, value: undefined }
          }
          return { done: false, value: chunks[index++] }
        },
      }
    },
  }
}

async function collectEvents(chunks: GeminiStreamChunk[]) {
  const events: any[] = []
  for await (const event of adaptGeminiStreamToAnthropic(
    mockStream(chunks),
    'gemini-2.5-flash',
  )) {
    events.push(event)
  }
  return events
}

function eventSequence(events: any[]) {
  return events.map(event =>
    'index' in event ? `${event.type}#${event.index}` : event.type,
  )
}

describe('adaptGeminiStreamToAnthropic', () => {
  test('rejects an empty stream without emitting protocol events', async () => {
    const events: Array<{ type: string }> = []
    const consume = async () => {
      for await (const event of adaptGeminiStreamToAnthropic(
        mockStream([]),
        'gemini-2.5-flash',
      )) {
        events.push(event)
      }
    }

    const error = await consume().catch(error => error)
    expect(error).toBeInstanceOf(ProviderStreamError)
    expect(error).toMatchObject({
      kind: 'premature_eof',
      retryable: true,
      terminal: false,
      completionState: 'incomplete',
      incompleteReason: 'empty_stream',
    })
    expect(events).toEqual([])
  })

  test('converts text chunks', async () => {
    const events = await collectEvents([
      {
        candidates: [
          {
            content: {
              parts: [{ text: 'Hello' }],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              parts: [{ text: ' world' }],
            },
            finishReason: 'STOP',
          },
        ],
      },
    ])

    const textDeltas = events.filter(
      event =>
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta',
    )

    expect(events[0].type).toBe('message_start')
    expect(textDeltas).toHaveLength(2)
    expect(textDeltas[0].delta.text).toBe('Hello')
    expect(textDeltas[1].delta.text).toBe(' world')

    const messageDelta = events.find(event => event.type === 'message_delta')
    expect(messageDelta.delta.stop_reason).toBe('end_turn')
  })

  test('rejects text EOF without finishReason', async () => {
    const events: Array<{ type: string }> = []
    const consume = async () => {
      for await (const event of adaptGeminiStreamToAnthropic(
        mockStream([
          {
            candidates: [
              {
                content: {
                  parts: [{ text: 'partial' }],
                },
              },
            ],
          },
        ]),
        'gemini-2.5-flash',
      )) {
        events.push(event)
      }
    }

    const error = await consume().catch(error => error)
    expect(error).toBeInstanceOf(ProviderStreamError)
    expect(error).toMatchObject({
      kind: 'premature_eof',
      retryable: true,
      terminal: false,
      incompleteReason: 'missing_finish_reason',
    })
    expect(events.some(event => event.type === 'content_block_stop')).toBe(
      false,
    )
    expect(events.some(event => event.type === 'message_delta')).toBe(false)
    expect(events.some(event => event.type === 'message_stop')).toBe(false)
  })

  test('rejects function-call EOF without finishReason', async () => {
    const events: Array<{ type: string }> = []
    const consume = async () => {
      for await (const event of adaptGeminiStreamToAnthropic(
        mockStream([
          {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: {
                        name: 'bash',
                        args: { command: 'ls' },
                      },
                    },
                  ],
                },
              },
            ],
          },
        ]),
        'gemini-2.5-flash',
      )) {
        events.push(event)
      }
    }

    await expect(consume()).rejects.toMatchObject({
      name: 'ProviderStreamError',
      kind: 'premature_eof',
      incompleteReason: 'missing_finish_reason',
    })
    expect(events.some(event => event.type === 'content_block_stop')).toBe(
      false,
    )
    expect(events.some(event => event.type === 'message_delta')).toBe(false)
    expect(events.some(event => event.type === 'message_stop')).toBe(false)
  })

  test('preserves thinking to text block ordering', async () => {
    const events = await collectEvents([
      {
        candidates: [
          {
            content: {
              parts: [{ text: 'Think', thought: true }],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              parts: [{ text: 'Answer' }],
            },
            finishReason: 'STOP',
          },
        ],
      },
    ])

    expect(eventSequence(events)).toEqual([
      'message_start',
      'content_block_start#0',
      'content_block_delta#0',
      'content_block_stop#0',
      'content_block_start#1',
      'content_block_delta#1',
      'content_block_stop#1',
      'message_delta',
      'message_stop',
    ])
  })

  test('preserves text to tool block ordering', async () => {
    const events = await collectEvents([
      {
        candidates: [
          {
            content: {
              parts: [{ text: 'Run this' }],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'bash',
                    args: { command: 'ls' },
                  },
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      },
    ])

    expect(eventSequence(events)).toEqual([
      'message_start',
      'content_block_start#0',
      'content_block_delta#0',
      'content_block_stop#0',
      'content_block_start#1',
      'content_block_delta#1',
      'content_block_stop#1',
      'message_delta',
      'message_stop',
    ])
  })

  test('rejects multi-block EOF without leaking buffered events', async () => {
    const events: Array<{ type: string }> = []
    const consume = async () => {
      for await (const event of adaptGeminiStreamToAnthropic(
        mockStream([
          {
            candidates: [
              {
                content: {
                  parts: [{ text: 'Think', thought: true }],
                },
              },
            ],
          },
          {
            candidates: [
              {
                content: {
                  parts: [{ text: 'partial' }],
                },
              },
            ],
          },
        ]),
        'gemini-2.5-flash',
      )) {
        events.push(event)
      }
    }

    await expect(consume()).rejects.toMatchObject({
      name: 'ProviderStreamError',
      kind: 'premature_eof',
      incompleteReason: 'missing_finish_reason',
    })
    expect(eventSequence(events)).toEqual([
      'message_start',
      'content_block_start#0',
      'content_block_delta#0',
    ])
  })

  test('converts thinking chunks and signatures', async () => {
    const events = await collectEvents([
      {
        candidates: [
          {
            content: {
              parts: [{ text: 'Think', thought: true }],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              parts: [{ thought: true, thoughtSignature: 'sig-123' }],
            },
            finishReason: 'STOP',
          },
        ],
      },
    ])

    const blockStart = events.find(
      event => event.type === 'content_block_start',
    )
    expect(blockStart.content_block.type).toBe('thinking')

    const signatureDelta = events.find(
      event =>
        event.type === 'content_block_delta' &&
        event.delta.type === 'signature_delta',
    )
    expect(signatureDelta.delta.signature).toBe('sig-123')
  })

  test('converts function calls to tool_use blocks', async () => {
    const events = await collectEvents([
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'bash',
                    args: { command: 'ls' },
                  },
                  thoughtSignature: 'sig-tool',
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      },
    ])

    const blockStart = events.find(
      event => event.type === 'content_block_start',
    )
    expect(blockStart.content_block.type).toBe('tool_use')
    expect(blockStart.content_block.name).toBe('bash')

    const signatureDelta = events.find(
      event =>
        event.type === 'content_block_delta' &&
        event.delta.type === 'signature_delta',
    )
    expect(signatureDelta.delta.signature).toBe('sig-tool')

    const inputDelta = events.find(
      event =>
        event.type === 'content_block_delta' &&
        event.delta.type === 'input_json_delta',
    )
    expect(inputDelta.delta.partial_json).toBe('{"command":"ls"}')

    const messageDelta = events.find(event => event.type === 'message_delta')
    expect(messageDelta.delta.stop_reason).toBe('tool_use')
  })

  test('maps usage metadata into output tokens', async () => {
    const events = await collectEvents([
      {
        candidates: [
          {
            content: {
              parts: [{ text: 'Hello' }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          thoughtsTokenCount: 2,
        },
      },
    ])

    const messageStart = events.find(event => event.type === 'message_start')
    expect(messageStart.message.usage.input_tokens).toBe(10)

    const messageDelta = events.find(event => event.type === 'message_delta')
    expect(messageDelta.usage.output_tokens).toBe(7)
  })
})
