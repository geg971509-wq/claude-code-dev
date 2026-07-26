import { describe, expect, test } from 'bun:test'
import { ProviderStreamError } from '@ant/model-provider'
import { streamGeminiGenerateContent } from '../client.js'
import type { GeminiStreamChunk } from '@ant/model-provider'

const encoder = new TextEncoder()

function responseFromChunks(chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    }),
    { status: 200 },
  )
}

async function collectChunks(
  chunks: Uint8Array[],
): Promise<GeminiStreamChunk[]> {
  const results: GeminiStreamChunk[] = []
  const fetchOverride = (async () =>
    responseFromChunks(chunks)) as unknown as typeof fetch

  for await (const chunk of streamGeminiGenerateContent({
    model: 'gemini-test',
    body: { contents: [] },
    signal: new AbortController().signal,
    fetchOverride,
  })) {
    results.push(chunk)
  }

  return results
}

describe('streamGeminiGenerateContent', () => {
  test('yields a final SSE frame without a trailing delimiter', async () => {
    const payload = {
      candidates: [{ finishReason: 'STOP' }],
    } satisfies GeminiStreamChunk

    expect(
      await collectChunks([encoder.encode(`data: ${JSON.stringify(payload)}`)]),
    ).toEqual([payload])
  })

  test('preserves complete and delimiter-less final frame order', async () => {
    const first = {
      candidates: [{ content: { parts: [{ text: 'first' }] } }],
    } satisfies GeminiStreamChunk
    const final = {
      candidates: [{ finishReason: 'STOP' }],
    } satisfies GeminiStreamChunk

    expect(
      await collectChunks([
        encoder.encode(
          `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(final)}`,
        ),
      ]),
    ).toEqual([first, final])
  })

  test('flushes split UTF-8 input in a delimiter-less final frame', async () => {
    const payload = {
      candidates: [
        {
          content: { parts: [{ text: '回答' }] },
          finishReason: 'STOP',
        },
      ],
    } satisfies GeminiStreamChunk
    const encoded = encoder.encode(`data: ${JSON.stringify(payload)}`)
    const splitAt = `data: ${JSON.stringify(payload)}`.indexOf('回') + 1

    expect(
      await collectChunks([encoded.slice(0, splitAt), encoded.slice(splitAt)]),
    ).toEqual([payload])
  })

  test('rejects an oversized retained incomplete frame', async () => {
    const consume = collectChunks([
      encoder.encode(`data: ${'x'.repeat(1024 * 1024)}`),
    ])

    const error = await consume.catch(error => error)
    expect(error).toBeInstanceOf(ProviderStreamError)
    expect(error).toMatchObject({
      kind: 'protocol',
      retryable: false,
    })
  })

  test('bounds a multibyte retained frame split across small chunks', async () => {
    const bytes = encoder.encode(`data: ${'界'.repeat(350_000)}`)
    const chunks = Array.from(
      { length: Math.ceil(bytes.length / 1024) },
      (_, index) => bytes.slice(index * 1024, (index + 1) * 1024),
    )
    const consume = collectChunks(chunks)

    const error = await consume.catch(error => error)
    expect(error).toBeInstanceOf(ProviderStreamError)
    expect(error).toMatchObject({
      kind: 'protocol',
      retryable: false,
      terminal: false,
    })
  })

  test('reports invalid JSON in a delimiter-less final frame', async () => {
    await expect(
      collectChunks([encoder.encode('data: {not-json')]),
    ).rejects.toThrow('Failed to parse trailing Gemini SSE payload')
  })
})
