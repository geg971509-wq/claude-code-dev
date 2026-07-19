import { describe, expect, test } from 'bun:test'
import {
  isWireErrorCode,
  normalizeLegacyErrorType,
  WireErrorCode,
  wireCodeFromProviderErrorName,
  wireError,
  isWireErrorResponse,
  toJsonRpcErrorData,
} from '../index.js'

describe('WireErrorCode table', () => {
  test('stable provider codes exist', () => {
    expect(WireErrorCode.PROVIDER_CONTEXT_OVERFLOW).toBe(
      'provider.context_overflow',
    )
    expect(WireErrorCode.PROVIDER_REQUEST_TOO_LARGE).toBe(
      'provider.request_too_large',
    )
    expect(WireErrorCode.PROVIDER_RATE_LIMIT).toBe('provider.rate_limit')
  })

  test('isWireErrorCode', () => {
    expect(isWireErrorCode('unauthorized')).toBe(true)
    expect(isWireErrorCode('not_a_real_code')).toBe(false)
  })

  test('normalizeLegacyErrorType', () => {
    expect(normalizeLegacyErrorType('not_found')).toBe(WireErrorCode.NOT_FOUND)
    expect(normalizeLegacyErrorType('provider.rate_limit')).toBe(
      WireErrorCode.PROVIDER_RATE_LIMIT,
    )
    expect(normalizeLegacyErrorType('custom.foo')).toBe('custom.foo')
  })
})

describe('wireError payload', () => {
  test('builds response body', () => {
    const res = wireError(
      WireErrorCode.SESSION_NOT_FOUND,
      'Session not found',
      {
        details: 'id=abc',
      },
    )
    expect(res).toEqual({
      error: {
        type: 'session.not_found',
        message: 'Session not found',
        details: 'id=abc',
      },
    })
    expect(isWireErrorResponse(res)).toBe(true)
  })

  test('provider name map', () => {
    expect(wireCodeFromProviderErrorName('APIContextOverflowError')).toBe(
      WireErrorCode.PROVIDER_CONTEXT_OVERFLOW,
    )
    expect(wireCodeFromProviderErrorName('APIProviderRateLimitError')).toBe(
      WireErrorCode.PROVIDER_RATE_LIMIT,
    )
  })

  test('json-rpc data', () => {
    const data = toJsonRpcErrorData({
      type: WireErrorCode.PROVIDER_RATE_LIMIT,
      message: 'slow down',
      retryAfterMs: 1000,
    })
    expect(data.code).toBe('provider.rate_limit')
    expect(data.retryAfterMs).toBe(1000)
  })
})
