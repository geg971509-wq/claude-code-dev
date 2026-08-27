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
  asOpenAIRetryError,
  createThinkingLoopDetector,
  createThinkingLoopError,
  getOpenAIRequestMaxRetries,
  getThinkingLoopMaxRetries,
  isThinkingLoopError,
  getOpenAIRetryDelayMs,
  getOpenAIStreamIdleTimeoutMs,
  getOpenAIStreamStallTimeoutMs,
  getOpenAIStreamMaxRetries,
  getTransientOpenAIMaxRetries,
  isSemanticOpenAIEvent,
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

  test('classifies message-only 5xx gateway copy as transient', () => {
    expect(
      isTransientOpenAIError(new Error('502 Upstream request failed')),
    ).toBe(true)
    expect(
      isTransientOpenAIError(new Error('Error: 503 Service Unavailable')),
    ).toBe(true)
    expect(isTransientOpenAIError(new Error('502 status code (no body)'))).toBe(
      true,
    )
    expect(
      isTransientOpenAIError(
        new Error('Grok failed: 502: Upstream request failed'),
      ),
    ).toBe(true)
    expect(isTransientOpenAIError(new Error('400 Bad Request'))).toBe(false)
    expect(isTransientOpenAIError(new Error('attempt 502/5 failed'))).toBe(
      false,
    )
  })
})

describe('isSemanticOpenAIEvent', () => {
  test('treats thinking-only as non-semantic so idle stays retryable', () => {
    expect(
      isSemanticOpenAIEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: 'plan', signature: '' },
      } as never),
    ).toBe(false)
    expect(
      isSemanticOpenAIEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'plan' },
      } as never),
    ).toBe(false)
    expect(
      isSemanticOpenAIEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig' },
      } as never),
    ).toBe(false)
    expect(
      isSemanticOpenAIEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hi' },
      } as never),
    ).toBe(true)
  })
})

describe('createThinkingLoopDetector', () => {
  const sentence =
    'The leftover test is still not written. I need to write it now. '

  test('trips after the same sentence repeats past the threshold', () => {
    const detector = createThinkingLoopDetector({ minChars: 20, repeat: 6 })
    const hits = Array.from({ length: 8 }, () => detector.push(sentence))
    expect(hits.slice(0, 5).every(hit => hit === false)).toBe(true)
    expect(hits[5]).toBe(true)
  })

  test('does not trip on distinct planning sentences', () => {
    const detector = createThinkingLoopDetector({ minChars: 20, repeat: 6 })
    expect(
      detector.push('First I will inspect the leftover token path. '),
    ).toBe(false)
    expect(
      detector.push('Then I will compare official Codex idle handling. '),
    ).toBe(false)
    expect(
      detector.push(
        'Finally I will implement the thinking-not-committed fix. ',
      ),
    ).toBe(false)
  })

  test('also trips when one chunk is the whole repeated sentence', () => {
    const detector = createThinkingLoopDetector({ minChars: 20, repeat: 3 })
    const chunk =
      'The leftover test is still not written. I need to write it now. Also I need to look at the idle timeout more carefully.'
    expect(detector.push(chunk)).toBe(false)
    expect(detector.push(chunk)).toBe(false)
    expect(detector.push(chunk)).toBe(true)
  })
})

describe('thinking-loop resample helpers', () => {
  test('clamps OPENAI_THINKING_LOOP_MAX_RETRIES to 0–5', () => {
    withEnv({ OPENAI_THINKING_LOOP_MAX_RETRIES: undefined }, () => {
      expect(getThinkingLoopMaxRetries()).toBe(2)
    })
    withEnv({ OPENAI_THINKING_LOOP_MAX_RETRIES: '0' }, () => {
      expect(getThinkingLoopMaxRetries()).toBe(0)
    })
    withEnv({ OPENAI_THINKING_LOOP_MAX_RETRIES: '99' }, () => {
      expect(getThinkingLoopMaxRetries()).toBe(5)
    })
  })

  test('thinking-loop errors are retryable and identifiable', () => {
    const error = createThinkingLoopError('req_loop')
    expect(isThinkingLoopError(error)).toBe(true)
    expect(isTransientOpenAIError(error)).toBe(true)
    expect(error.retryable).toBe(true)
    expect(error.terminal).toBe(false)
    expect(
      isThinkingLoopError(
        new ProviderStreamError('OpenAI stream ended before message_stop', {
          kind: 'premature_eof',
          retryable: true,
          terminal: false,
        }),
      ),
    ).toBe(false)
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

  test('retries a message-only 502 and succeeds on the next attempt', async () => {
    let calls = 0
    const result = await withTransientOpenAIRetry(
      async () => {
        calls++
        if (calls === 1) throw new Error('502 Upstream request failed')
        return 'recovered'
      },
      { signal: new AbortController().signal },
    )
    expect(result).toBe('recovered')
    expect(calls).toBe(2)
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
    OPENAI_STREAM_STALL_TIMEOUT_MS: undefined,
    CLAUDE_CODE_MAX_RETRIES: undefined,
  }

  test('uses Codex-aligned request and stream defaults', () => {
    withEnv(cleared, () => {
      expect(getOpenAIRequestMaxRetries()).toBe(4)
      expect(getOpenAIStreamMaxRetries()).toBe(5)
      expect(getOpenAIStreamIdleTimeoutMs()).toBe(300_000)
      expect(getOpenAIStreamStallTimeoutMs()).toBe(300_000)
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
        OPENAI_STREAM_STALL_TIMEOUT_MS: '0',
      },
      () => {
        expect(getOpenAIRequestMaxRetries()).toBe(4)
        expect(getOpenAIStreamMaxRetries()).toBe(5)
        expect(getOpenAIStreamIdleTimeoutMs()).toBe(300_000)
        expect(getOpenAIStreamStallTimeoutMs()).toBe(300_000)
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

  test('uses class-capped exponential backoff without provider guidance', () => {
    expect(getOpenAIRetryDelayMs(new Error('x'), 1)).toBe(500)
    expect(getOpenAIRetryDelayMs(new Error('x'), 20)).toBe(30_000)
    expect(getOpenAIRetryDelayMs({ status: 503, message: 'busy' }, 20)).toBe(
      8_000,
    )
    expect(
      getOpenAIRetryDelayMs(
        { status: 502, message: '502 status code (no body)' },
        20,
      ),
    ).toBe(2_000)
  })

  test('honors explicit 5xx delays up to the global 30s ceiling', () => {
    expect(
      getOpenAIRetryDelayMs(new ProviderAPIError(503, 'busy', null, 60_000), 1),
    ).toBe(30_000)

    const empty502 = Object.assign(new Error('502 status code (no body)'), {
      status: 502,
      headers: new Headers({ 'retry-after': '18' }),
    })
    expect(getOpenAIRetryDelayMs(empty502, 1)).toBe(18_000)
    expect(getOpenAIRetryDelayMs(empty502, 1, 25_000)).toBe(18_000)
    expect(getOpenAIRetryDelayMs({ status: 503 }, 1, 25_000)).toBe(25_000)
  })

  test('keeps full ceiling for 429 rate limits', () => {
    const rateLimit = new ProviderAPIError(429, 'rate limited', null, 25_000)
    expect(getOpenAIRetryDelayMs(rateLimit, 1)).toBe(25_000)
  })
})

describe('asOpenAIRetryError', () => {
  test('defaults to a concise UI message and preserves retry metadata', () => {
    const headers = new Headers({ 'cf-ray': 'abc' })
    const err = Object.assign(new Error('502 status code (no body)'), {
      status: 502,
      statusCode: 502,
      headers,
      requestID: 'req_sdk',
      requestId: 'req_compat',
    })
    const wrapped = asOpenAIRetryError(err)
    expect(wrapped.message).toBe('502 status code (no body)')
    expect(wrapped.message).not.toMatch(/^\s*at /m)
    expect(wrapped.cause).toBe(err)
    expect(wrapped).toMatchObject({
      status: 502,
      statusCode: 502,
      headers,
      requestID: 'req_sdk',
      requestId: 'req_compat',
    })
    expect(isTransientOpenAIError(wrapped)).toBe(true)
  })

  test('includes a bounded stack only when explicitly requested', () => {
    const err = new Error('502 status code (no body)')
    expect(asOpenAIRetryError(err, true, 4).message).toMatch(/^\s*at /m)
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

  test('uses the shorter stall window after the first chunk', async () => {
    const stream: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        let sent = false
        return {
          next: () => {
            if (sent) return new Promise<IteratorResult<string>>(() => {})
            sent = true
            return Promise.resolve({ done: false, value: 'chunk' })
          },
          return: async () => ({ done: true, value: undefined }),
        }
      },
    }

    const started = Date.now()
    let rejection: unknown
    const received: string[] = []
    try {
      for await (const chunk of withOpenAIStreamIdleTimeout(stream, {
        timeoutMs: 60_000,
        stallTimeoutMs: 5,
        abortAttempt: () => {},
        userSignal: new AbortController().signal,
      })) {
        received.push(chunk)
      }
    } catch (error) {
      rejection = error
    }

    expect(received).toEqual(['chunk'])
    expect(rejection).toMatchObject({ kind: 'idle_timeout' })
    expect((rejection as Error).message).toContain('after 5ms')
    expect(Date.now() - started).toBeLessThan(60_000)
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
