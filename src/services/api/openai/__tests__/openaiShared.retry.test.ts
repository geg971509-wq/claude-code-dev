/**
 * Tests for withTransientOpenAIRetry / isTransientOpenAIError in openaiShared.ts.
 *
 * Regression: a single `503 Service temporarily unavailable` from an
 * OpenAI-compatible provider used to fail the whole turn because the OpenAI
 * path bypasses withRetry.ts and the SDK client is created with maxRetries: 0.
 */
import { describe, expect, test } from 'bun:test'
import { ProviderAPIError, ProviderStreamError } from '@ant/model-provider'
import { APIConnectionError } from 'openai'
import {
  getOpenAIRequestMaxRetries,
  getOpenAIRetryDelayMs,
  getOpenAIStreamIdleTimeoutMs,
  getOpenAIStreamMaxRetries,
  getTransientOpenAIMaxRetries,
  isTransientOpenAIError,
  withOpenAIStreamIdleTimeout,
  withTransientOpenAIRetry,
} from '../openaiShared.js'

/** 503 with a tiny server-directed delay so tests stay fast. */
const transient503 = () =>
  new ProviderAPIError(503, '503 Service temporarily unavailable', null, 1)

function withEnv(
  overrides: Record<string, string | undefined>,
  run: () => void,
): void {
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    run()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

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

  test('classifies 429 but not non-retryable 4xx errors as transient', () => {
    expect(isTransientOpenAIError({ status: 400 })).toBe(false)
    expect(isTransientOpenAIError({ status: 401 })).toBe(false)
    expect(isTransientOpenAIError({ status: 413 })).toBe(false)
    expect(isTransientOpenAIError({ status: 429 })).toBe(true)
  })

  test('uses ProviderStreamError retryability', () => {
    expect(
      isTransientOpenAIError(
        new ProviderStreamError('disconnected', {
          kind: 'provider',
          retryable: true,
        }),
      ),
    ).toBe(true)
    expect(
      isTransientOpenAIError(
        new ProviderStreamError('invalid event', {
          kind: 'protocol',
          retryable: false,
        }),
      ),
    ).toBe(false)
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

describe('OpenAI retry configuration', () => {
  const cleared = {
    OPENAI_REQUEST_MAX_RETRIES: undefined,
    OPENAI_STREAM_MAX_RETRIES: undefined,
    OPENAI_STREAM_IDLE_TIMEOUT_MS: undefined,
    CLAUDE_CODE_MAX_RETRIES: undefined,
  }

  test('uses Codex-aligned request and stream defaults', () => {
    withEnv(cleared, () => {
      expect(getOpenAIRequestMaxRetries()).toBe(4)
      expect(getOpenAIStreamMaxRetries()).toBe(5)
      expect(getOpenAIStreamIdleTimeoutMs()).toBe(300_000)
    })
  })

  test('uses compatibility override when dedicated variables are absent', () => {
    withEnv({ ...cleared, CLAUDE_CODE_MAX_RETRIES: '3' }, () => {
      expect(getOpenAIRequestMaxRetries()).toBe(3)
      expect(getOpenAIStreamMaxRetries()).toBe(3)
    })
  })

  test('prefers dedicated overrides and clamps retry counts', () => {
    withEnv(
      {
        ...cleared,
        CLAUDE_CODE_MAX_RETRIES: '3',
        OPENAI_REQUEST_MAX_RETRIES: '-2',
        OPENAI_STREAM_MAX_RETRIES: '101',
      },
      () => {
        expect(getOpenAIRequestMaxRetries()).toBe(0)
        expect(getOpenAIStreamMaxRetries()).toBe(100)
      },
    )
  })

  test('falls back for invalid retry and timeout values', () => {
    withEnv(
      {
        ...cleared,
        OPENAI_REQUEST_MAX_RETRIES: 'invalid',
        OPENAI_STREAM_MAX_RETRIES: 'invalid',
        OPENAI_STREAM_IDLE_TIMEOUT_MS: '0',
      },
      () => {
        expect(getOpenAIRequestMaxRetries()).toBe(4)
        expect(getOpenAIStreamMaxRetries()).toBe(5)
        expect(getOpenAIStreamIdleTimeoutMs()).toBe(300_000)
      },
    )
  })
})

describe('getOpenAIRetryDelayMs', () => {
  test('prefers provider and raw Retry-After values', () => {
    expect(getOpenAIRetryDelayMs(transient503(), 1)).toBe(1)
    expect(
      getOpenAIRetryDelayMs(
        { headers: new Headers({ 'retry-after': '2' }) },
        1,
      ),
    ).toBe(2_000)
  })

  test('uses capped exponential backoff without provider guidance', () => {
    expect(getOpenAIRetryDelayMs(new Error('x'), 1)).toBe(500)
    expect(getOpenAIRetryDelayMs(new Error('x'), 20)).toBe(30_000)
    expect(
      getOpenAIRetryDelayMs(new ProviderAPIError(503, 'x', null, 60_000), 1),
    ).toBe(30_000)
  })
})

describe('withOpenAIStreamIdleTimeout', () => {
  test('aborts the attempt and preserves idle-timeout classification', async () => {
    const attemptController = new AbortController()
    let returned = false
    const stream: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<string>>((_, reject) => {
              attemptController.signal.addEventListener(
                'abort',
                () =>
                  reject(
                    Object.assign(new Error('aborted'), { name: 'AbortError' }),
                  ),
                { once: true },
              )
            }),
          return: async () => {
            returned = true
            return { done: true, value: undefined }
          },
        }
      },
    }

    let rejection: unknown
    try {
      for await (const _ of withOpenAIStreamIdleTimeout(stream, {
        timeoutMs: 5,
        abortAttempt: () => attemptController.abort(),
        userSignal: new AbortController().signal,
        requestId: 'req_timeout',
      })) {
        // no events expected
      }
    } catch (error) {
      rejection = error
    }

    expect(rejection).toBeInstanceOf(ProviderStreamError)
    expect(rejection).toMatchObject({
      kind: 'idle_timeout',
      retryable: true,
      requestId: 'req_timeout',
    })
    expect(attemptController.signal.aborted).toBe(true)
    expect(returned).toBe(true)
  })

  test('propagates user cancellation without reclassifying it', async () => {
    const userController = new AbortController()
    const abortError = Object.assign(new Error('request was aborted'), {
      name: 'AbortError',
    })
    const stream: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.reject(abortError),
          return: async () => ({ done: true, value: undefined }),
        }
      },
    }
    userController.abort()

    let rejection: unknown
    try {
      for await (const _ of withOpenAIStreamIdleTimeout(stream, {
        timeoutMs: 5,
        abortAttempt: () => {},
        userSignal: userController.signal,
      })) {
        // no events expected
      }
    } catch (error) {
      rejection = error
    }

    expect(rejection).toBe(abortError)
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
