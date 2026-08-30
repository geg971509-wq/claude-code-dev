import { afterEach, describe, expect, test } from 'bun:test'
import { adaptResponsesStreamToAnthropic } from '../responsesAdapter.js'
import {
  executeOpenAIStream,
  type OpenAIStreamAttempt,
  type OpenAIStreamExecutionSummary,
} from '../streamExecutor.js'

const saved = {
  idle: process.env.OPENAI_STREAM_IDLE_TIMEOUT_MS,
  stall: process.env.OPENAI_STREAM_STALL_TIMEOUT_MS,
  retries: process.env.OPENAI_STREAM_MAX_RETRIES,
}

afterEach(() => {
  for (const [key, value] of Object.entries({
    OPENAI_STREAM_IDLE_TIMEOUT_MS: saved.idle,
    OPENAI_STREAM_STALL_TIMEOUT_MS: saved.stall,
    OPENAI_STREAM_MAX_RETRIES: saved.retries,
  })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function attempt(
  stream: AsyncIterable<Record<string, unknown>>,
): OpenAIStreamAttempt {
  return {
    stream,
    status: 200,
    requestId: 'req_1',
    retryAfterMs: 1,
    cleanup: () => {},
  }
}

async function drain(
  createAttempt: () => Promise<OpenAIStreamAttempt>,
): Promise<{ output: unknown[]; summary: OpenAIStreamExecutionSummary }> {
  const generator = executeOpenAIStream({
    preparedAttempt: { route: 'codex-responses', createAttempt },
    adapter: adaptResponsesStreamToAnthropic,
    model: 'gpt-5.4',
    tools: [],
    signal: new AbortController().signal,
    maxTokenDisplayLimit: 4096,
  })
  const output: unknown[] = []
  while (true) {
    const next = await generator.next()
    if (next.done) return { output, summary: next.value }
    output.push(next.value)
  }
}

async function* hangingAfterText(): AsyncIterable<Record<string, unknown>> {
  yield { type: 'response.output_text.delta', delta: 'stale' }
  await new Promise(() => {})
}

async function* completed(
  text: string,
): AsyncIterable<Record<string, unknown>> {
  yield { type: 'response.output_text.delta', delta: text }
  yield {
    type: 'response.completed',
    response: {
      id: 'resp_1',
      status: 'completed',
      usage: { input_tokens: 3, output_tokens: 1 },
    },
  }
}

describe('executeOpenAIStream retry state', () => {
  test('retries an idle partial stream without carrying its message state', async () => {
    process.env.OPENAI_STREAM_IDLE_TIMEOUT_MS = '20'
    process.env.OPENAI_STREAM_STALL_TIMEOUT_MS = '20'
    process.env.OPENAI_STREAM_MAX_RETRIES = '1'
    let calls = 0

    const result = await drain(async () =>
      attempt(calls++ === 0 ? hangingAfterText() : completed('fresh')),
    )

    expect(calls).toBe(2)
    expect(result.summary.collectedMessages).toHaveLength(1)
    expect(result.summary.collectedMessages[0]?.message.content).toEqual([
      { type: 'text', text: 'fresh' },
    ])
    expect(
      result.output.some(
        event => (event as { type?: string }).type === 'system',
      ),
    ).toBe(true)
  })

  test('retries premature EOF and completes from a fresh attempt', async () => {
    process.env.OPENAI_STREAM_MAX_RETRIES = '1'
    let calls = 0

    const result = await drain(async () =>
      attempt(
        calls++ === 0 ? (async function* () {})() : completed('recovered'),
      ),
    )

    expect(calls).toBe(2)
    expect(result.summary.collectedMessages).toHaveLength(1)
    expect(result.summary.collectedMessages[0]?.message.content).toEqual([
      { type: 'text', text: 'recovered' },
    ])
  })
})
