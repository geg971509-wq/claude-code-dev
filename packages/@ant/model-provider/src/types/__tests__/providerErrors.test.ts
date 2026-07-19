import { describe, expect, test } from 'bun:test'
import {
  APIContextOverflowError,
  APIProviderRateLimitError,
  APIRequestTooLargeError,
  classifyProviderHttpError,
  getProviderRetryAfterMs,
  parseRetryAfterMs,
  ProviderAPIError,
} from '../providerErrors.js'

describe('classifyProviderHttpError', () => {
  test('429 → rate limit with retryAfterMs from headers', () => {
    const err = classifyProviderHttpError(429, 'Too many requests', {
      headers: { 'retry-after': '12' },
    })
    expect(err).toBeInstanceOf(APIProviderRateLimitError)
    expect(err.statusCode).toBe(429)
    expect(err.retryAfterMs).toBe(12_000)
  })

  test('400 prompt-too-long → context overflow', () => {
    const err = classifyProviderHttpError(
      400,
      'Prompt is too long: 200000 tokens > 180000 maximum',
    )
    expect(err).toBeInstanceOf(APIContextOverflowError)
  })

  test('413 Vertex prompt-too-long → context overflow (not body size)', () => {
    const err = classifyProviderHttpError(413, 'Prompt is too long')
    expect(err).toBeInstanceOf(APIContextOverflowError)
    expect(err).not.toBeInstanceOf(APIRequestTooLargeError)
  })

  test('413 entity too large → request too large', () => {
    const err = classifyProviderHttpError(413, 'Request Entity Too Large')
    expect(err).toBeInstanceOf(APIRequestTooLargeError)
  })

  test('413 bare → request too large', () => {
    const err = classifyProviderHttpError(413, '')
    expect(err).toBeInstanceOf(APIRequestTooLargeError)
  })

  test('500 → generic ProviderAPIError', () => {
    const err = classifyProviderHttpError(500, 'boom')
    expect(err).toBeInstanceOf(ProviderAPIError)
    expect(err).not.toBeInstanceOf(APIContextOverflowError)
    expect(err.name).toBe('ProviderAPIError')
  })
})

describe('parseRetryAfterMs / getProviderRetryAfterMs', () => {
  test('seconds string', () => {
    expect(parseRetryAfterMs('5')).toBe(5000)
    expect(parseRetryAfterMs(null)).toBeNull()
  })

  test('reads retryAfterMs from typed error', () => {
    const err = new APIProviderRateLimitError('slow down', null, 3000)
    expect(getProviderRetryAfterMs(err)).toBe(3000)
    expect(getProviderRetryAfterMs(new Error('nope'))).toBeNull()
  })
})
