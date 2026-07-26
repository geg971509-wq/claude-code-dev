import { MAX_RETAINED_SSE_BUFFER_BYTES } from 'src/constants/apiLimits.js'
import { parseSSEFrames } from 'src/utils/sse.js'
import { errorMessage } from 'src/utils/errors.js'
import { getProxyFetchOptions } from 'src/utils/proxy.js'
import {
  ProviderStreamError,
  type GeminiGenerateContentRequest,
  type GeminiStreamChunk,
} from '@ant/model-provider'

const DEFAULT_GEMINI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta'

const STREAM_DECODE_OPTS: TextDecodeOptions = { stream: true }
const UTF8_ENCODER = new TextEncoder()

function getGeminiBaseUrl(): string {
  return (process.env.GEMINI_BASE_URL || DEFAULT_GEMINI_BASE_URL).replace(
    /\/+$/,
    '',
  )
}

function getGeminiModelPath(model: string): string {
  const normalized = model.replace(/^\/+/, '')
  return normalized.startsWith('models/') ? normalized : `models/${normalized}`
}

function parseGeminiPayload(
  data: string | undefined,
  trailing: boolean,
): GeminiStreamChunk | undefined {
  if (!data || data === '[DONE]') return undefined

  try {
    return JSON.parse(data) as GeminiStreamChunk
  } catch (error) {
    const location = trailing ? 'trailing Gemini' : 'Gemini'
    throw new Error(
      `Failed to parse ${location} SSE payload: ${errorMessage(error)}`,
    )
  }
}

function assertRetainedBufferWithinLimit(byteLength: number): void {
  if (byteLength <= MAX_RETAINED_SSE_BUFFER_BYTES) {
    return
  }

  throw new ProviderStreamError(
    `Gemini SSE retained buffer exceeded ${MAX_RETAINED_SSE_BUFFER_BYTES} bytes`,
    {
      kind: 'protocol',
      retryable: false,
      terminal: false,
    },
  )
}

export async function* streamGeminiGenerateContent(params: {
  model: string
  body: GeminiGenerateContentRequest
  signal: AbortSignal
  fetchOverride?: typeof fetch
}): AsyncGenerator<GeminiStreamChunk, void> {
  const fetchImpl = params.fetchOverride ?? fetch
  const url = `${getGeminiBaseUrl()}/${getGeminiModelPath(params.model)}:streamGenerateContent?alt=sse`

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': process.env.GEMINI_API_KEY || '',
    },
    body: JSON.stringify(params.body),
    signal: params.signal,
    ...getProxyFetchOptions({ forAnthropicAPI: false }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(
      `Gemini API request failed (${response.status} ${response.statusText}): ${body || 'empty response body'}`,
    )
  }

  if (!response.body) {
    throw new Error('Gemini API returned no response body')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let retainedByteLength = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const decoded = decoder.decode(value, STREAM_DECODE_OPTS)
      buffer += decoded
      retainedByteLength += UTF8_ENCODER.encode(decoded).byteLength
      const parsed = parseSSEFrames(buffer)
      const consumedLength = buffer.length - parsed.remaining.length
      if (consumedLength > 0) {
        retainedByteLength -= UTF8_ENCODER.encode(
          buffer.slice(0, consumedLength),
        ).byteLength
      }
      buffer = parsed.remaining

      for (const frame of parsed.frames) {
        const chunk = parseGeminiPayload(frame.data, false)
        if (chunk) yield chunk
      }
      assertRetainedBufferWithinLimit(retainedByteLength)
    }

    const decoded = decoder.decode()
    buffer += decoded
    retainedByteLength += UTF8_ENCODER.encode(decoded).byteLength
    const parsed = parseSSEFrames(buffer)
    const consumedLength = buffer.length - parsed.remaining.length
    if (consumedLength > 0) {
      retainedByteLength -= UTF8_ENCODER.encode(
        buffer.slice(0, consumedLength),
      ).byteLength
    }
    buffer = parsed.remaining
    for (const frame of parsed.frames) {
      const chunk = parseGeminiPayload(frame.data, true)
      if (chunk) yield chunk
    }
    assertRetainedBufferWithinLimit(retainedByteLength)

    if (buffer.trim()) {
      const trailing = parseSSEFrames(`${buffer}\n\n`)
      for (const frame of trailing.frames) {
        const chunk = parseGeminiPayload(frame.data, true)
        if (chunk) yield chunk
      }
    }
  } finally {
    // Release the lock first, then cancel the body. cancel() throws while the
    // stream is locked, and releaseLock() alone leaves the socket/TLS buffers
    // pinned until GC on early exit (throw, or generator abandoned mid-stream).
    reader.releaseLock()
    void response.body?.cancel().catch(() => {})
  }
}
