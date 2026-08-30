import { describe, expect, test } from 'bun:test'
import {
  APIContextOverflowError,
  APIProviderRateLimitError,
  getProviderErrorStatus,
  getProviderRetryAfterMs,
  ProviderStreamError,
} from '@ant/model-provider'
import {
  createCodexIncompleteStreamError,
  createCodexResponsesStreamError,
  parseCodexResponsesRetryAfterMs,
} from '../streamErrors.js'

describe('Codex Responses terminal error mapping', () => {
  test('parses fractional seconds and milliseconds from retry hints', () => {
    expect(
      parseCodexResponsesRetryAfterMs('Please try again in 0.5 seconds.'),
    ).toBe(500)
    expect(
      parseCodexResponsesRetryAfterMs('Please try again in 125 ms.'),
    ).toBe(125)
    expect(parseCodexResponsesRetryAfterMs('Try again later.')).toBeNull()
  })

  test('maps rate_limit_exceeded and preserves retry delay', () => {
    const error = createCodexResponsesStreamError({
      type: 'response.failed',
      response: {
        id: 'resp_rate',
        status: 'failed',
        error: {
          code: 'rate_limit_exceeded',
          message: 'Please try again in 0.75 seconds.',
          type: 'requests',
          param: null,
        },
      },
    })

    expect(error).toBeInstanceOf(APIProviderRateLimitError)
    expect(getProviderErrorStatus(error)).toBe(429)
    expect(getProviderRetryAfterMs(error)).toBe(750)
    expect((error as APIProviderRateLimitError).requestId).toBe('resp_rate')
    expect((error as APIProviderRateLimitError).code).toBe(
      'rate_limit_exceeded',
    )
  })

  test('maps context_length_exceeded to a context overflow error', () => {
    const error = createCodexResponsesStreamError({
      type: 'response.failed',
      response: {
        id: 'resp_context',
        status: 'failed',
        error: {
          code: 'context_length_exceeded',
          message: 'The prompt exceeds the context window.',
        },
      },
    })

    expect(error).toBeInstanceOf(APIContextOverflowError)
    expect(getProviderErrorStatus(error)).toBe(400)
    expect((error as APIContextOverflowError).requestId).toBe('resp_context')
  })

  test('keeps policy and invalid request failures non-retryable', () => {
    for (const code of [
      'invalid_prompt',
      'bio_policy',
      'cyber_policy',
      'misalignment_policy_violation',
    ]) {
      const error = createCodexResponsesStreamError({
        type: 'response.failed',
        response: {
          id: `resp_${code}`,
          status: 'failed',
          error: { code, message: 'Request rejected.' },
        },
      })

      expect(error).toBeInstanceOf(ProviderStreamError)
      expect((error as ProviderStreamError).retryable).toBe(false)
      expect(getProviderErrorStatus(error)).toBe(400)
      expect((error as ProviderStreamError).code).toBe(code)
    }
  })

  test('maps quota and entitlement failures without retrying', () => {
    const quota = createCodexResponsesStreamError({
      response: {
        id: 'resp_quota',
        status: 'failed',
        error: { code: 'insufficient_quota', message: 'Quota exhausted.' },
      },
    })
    const entitlement = createCodexResponsesStreamError({
      response: {
        id: 'resp_entitlement',
        status: 'failed',
        error: {
          code: 'usage_not_included',
          message: 'Usage is not included.',
        },
      },
    })

    expect(quota).toBeInstanceOf(ProviderStreamError)
    expect((quota as ProviderStreamError).retryable).toBe(false)
    expect(getProviderErrorStatus(quota)).toBe(429)
    expect(entitlement).toBeInstanceOf(ProviderStreamError)
    expect((entitlement as ProviderStreamError).retryable).toBe(false)
    expect(getProviderErrorStatus(entitlement)).toBe(403)
  })

  test('maps overload signals and unknown provider failures as retryable', () => {
    for (const code of ['server_is_overloaded', 'slow_down']) {
      const error = createCodexResponsesStreamError({
        response: {
          id: `resp_${code}`,
          status: 'failed',
          error: { code, message: 'Capacity is temporarily unavailable.' },
        },
      })

      expect(error).toBeInstanceOf(ProviderStreamError)
      expect((error as ProviderStreamError).retryable).toBe(true)
      expect(getProviderErrorStatus(error)).toBe(503)
    }

    const unknown = createCodexResponsesStreamError({
      code: 'gateway_busy',
      message: 'Please try again in 2s.',
      request_id: 'req_unknown',
    })
    expect(unknown).toBeInstanceOf(ProviderStreamError)
    expect((unknown as ProviderStreamError).retryable).toBe(true)
    expect((unknown as ProviderStreamError).requestId).toBe('req_unknown')
    expect((unknown as ProviderStreamError).code).toBe('gateway_busy')
    expect(getProviderRetryAfterMs(unknown)).toBe(2000)
  })

  test('treats response.incomplete as a retryable error terminal', () => {
    const error = createCodexIncompleteStreamError({
      type: 'response.incomplete',
      response: {
        id: 'resp_incomplete',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      },
    })

    expect(error).toBeInstanceOf(ProviderStreamError)
    expect(error.kind).toBe('incomplete')
    expect(error.retryable).toBe(true)
    expect(error.terminal).toBe(true)
    expect(error.requestId).toBe('resp_incomplete')
    expect(error.incompleteReason).toBe('max_output_tokens')
  })

  test('rejects an incomplete event with a contradictory status', () => {
    const error = createCodexIncompleteStreamError({
      type: 'response.incomplete',
      response: {
        id: 'resp_bad_status',
        status: 'completed',
      },
    })

    expect(error.kind).toBe('protocol')
    expect(error.retryable).toBe(false)
    expect(error.terminal).toBe(false)
    expect(error.completionState).toBe('completed')
  })
})
