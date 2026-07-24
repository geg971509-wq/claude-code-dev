import { parseSSEFrames } from 'src/cli/transports/SSETransport.js'
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
const MAX_RETAINED_SSE_BUFFER_BYTES = 1024 * 1024

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

function assertRetainedBufferWithinLimit(buffer: string): void {
  if (buffer.length <= MAX_RETAINED_SSE_BUFFER_BYTES) return

  throw new ProviderStreamError(
    `Gemini SSE retained buffer exceeded ${MAX_RETAINED_SSE_BUFFER_BYTES} bytes`,
    {
      kind: 'protocol',
      retryable: true,
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

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, STREAM_DECODE_OPTS)
      const { frames, remaining } = parseSSEFrames(buffer)
      buffer = remaining

      for (const frame of frames) {
        const chunk = parseGeminiPayload(frame.data, false)
        if (chunk) yield chunk
      }
      assertRetainedBufferWithinLimit(buffer)
    }

    buffer += decoder.decode()
    const parsed = parseSSEFrames(buffer)
    buffer = parsed.remaining
    for (const frame of parsed.frames) {
      const chunk = parseGeminiPayload(frame.data, true)
      if (chunk) yield chunk
    }
    assertRetainedBufferWithinLimit(buffer)

    if (buffer.trim()) {
      const trailing = parseSSEFrames(`${buffer}\n\n`)
      for (const frame of trailing.frames) {
        const chunk = parseGeminiPayload(frame.data, true)
        if (chunk) yield chunk
      }
    }
  } finally {
    reader.releaseLock()
  }
}
