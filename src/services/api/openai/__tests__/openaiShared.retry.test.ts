/**
 * Tests for withTransientOpenAIRetry / isTransientOpenAIError in openaiShared.ts.
 *
 * Regression: a single `503 Service temporarily unavailable` from an
 * OpenAI-compatible provider used to fail the whole turn because the OpenAI
 * path bypasses withRetry.ts and the SDK client is created with maxRetries: 0.
 */
import { describe, expect, test } from 'bun:test'
import { ProviderAPIError } from '@ant/model-provider'
import { APIConnectionError } from 'openai'
import {
  getTransientOpenAIMaxRetries,
  isTransientOpenAIError,
  withTransientOpenAIRetry,
} from '../openaiShared.js'

/** 503 with a tiny server-directed delay so tests stay fast. */
const transient503 = () =>
  new ProviderAPIError(503, '503 Service temporarily unavailable', null, 1)

describe('isTransientOpenAIError', () => {
  test('classifies 5xx / 408 / 409 as transient', () => {
    expect(isTransientOpenAIError(transient503())).toBe(true)
    expect(isTransientOpenAIError({ status: 500, message: 'boom' })).toBe(true)
    expect(isTransientOpenAIError({ status: 502 })).toBe(true)
    expect(isTransientOpenAIError({ status: 408 })).toBe(true)
    expect(isTransientOpenAIError({ status: 409 })).toBe(true)
    // ProviderAPIError carries statusCode, not status.
    expect(isTransientOpenAIError({ statusCode: 529 })).toBe(true)
  })

  test('does not classify 4xx client errors as transient', () => {
    expect(isTransientOpenAIError({ status: 400 })).toBe(false)
    expect(isTransientOpenAIError({ status: 401 })).toBe(false)
    expect(isTransientOpenAIError({ status: 413 })).toBe(false)
    // 429 stays with the layered APIProviderRateLimitError handling.
    expect(isTransientOpenAIError({ status: 429 })).toBe(false)
  })

  test('classifies SDK connection errors (no status) as transient', () => {
    expect(
      isTransientOpenAIError(
        new APIConnectionError({ message: 'Connection error.' }),
      ),
    ).toBe(true)
  })

  test('rejects non-objects and plain errors', () => {
    expect(isTransientOpenAIError(null)).toBe(false)
    expect(isTransientOpenAIError('503')).toBe(false)
    expect(isTransientOpenAIError(new Error('boom'))).toBe(false)
  })
})

describe('withTransientOpenAIRetry', () => {
  test('returns the result without retrying on success', async () => {
    let calls = 0
    const result = await withTransientOpenAIRetry(
      async () => {
        calls++
        return 'ok'
      },
      { signal: new AbortController().signal },
    )
    expect(result).toBe('ok')
    expect(calls).toBe(1)
  })

  test('retries a 503 and succeeds on the next attempt', async () => {
    let calls = 0
    const retries: number[] = []
    const result = await withTransientOpenAIRetry(
      async () => {
        calls++
        if (calls === 1) throw transient503()
        return 'recovered'
      },
      {
        signal: new AbortController().signal,
        onRetry: info => retries.push(info.delayMs),
      },
    )
    expect(result).toBe('recovered')
    expect(calls).toBe(2)
    // Server-directed Retry-After (1ms) wins over exponential backoff.
    expect(retries).toEqual([1])
  })

  test('rethrows after maxRetries transient failures', async () => {
    let calls = 0
    await expect(
      withTransientOpenAIRetry(
        async () => {
          calls++
          throw transient503()
        },
        { signal: new AbortController().signal, maxRetries: 2 },
      ),
    ).rejects.toThrow('503 Service temporarily unavailable')
    expect(calls).toBe(3) // initial + 2 retries
  })

  test('does not retry non-transient errors', async () => {
    let calls = 0
    await expect(
      withTransientOpenAIRetry(
        async () => {
          calls++
          throw new ProviderAPIError(400, 'bad request')
        },
        { signal: new AbortController().signal, maxRetries: 3 },
      ),
    ).rejects.toThrow('bad request')
    expect(calls).toBe(1)
  })

  test('does not retry once the signal is aborted', async () => {
    const controller = new AbortController()
    let calls = 0
    await expect(
      withTransientOpenAIRetry(
        async () => {
          calls++
          controller.abort()
          throw transient503()
        },
        { signal: controller.signal, maxRetries: 3 },
      ),
    ).rejects.toThrow('503 Service temporarily unavailable')
    expect(calls).toBe(1)
  })
})

describe('getTransientOpenAIMaxRetries', () => {
  test('honors CLAUDE_CODE_MAX_RETRIES and falls back to default', () => {
    const prev = process.env.CLAUDE_CODE_MAX_RETRIES
    try {
      process.env.CLAUDE_CODE_MAX_RETRIES = '2'
      expect(getTransientOpenAIMaxRetries()).toBe(2)
      delete process.env.CLAUDE_CODE_MAX_RETRIES
      expect(getTransientOpenAIMaxRetries()).toBe(5)
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_MAX_RETRIES
      else process.env.CLAUDE_CODE_MAX_RETRIES = prev
    }
  })
})
