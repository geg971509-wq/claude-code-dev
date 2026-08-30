import { describe, expect, test } from 'bun:test'
import {
  APIContextOverflowError,
  ProviderStreamError,
} from '@ant/model-provider'
import { getCodexErrorStatus, normalizeCodexError } from '../errors.js'

describe('Codex layered error normalization', () => {
  test('reads statusCode from provider-neutral errors', () => {
    const error = new APIContextOverflowError(
      400,
      'context_length_exceeded: prompt is too long',
      'req_context',
      null,
      { code: 'context_length_exceeded' },
    )

    expect(getCodexErrorStatus(error)).toBe(400)
    expect(normalizeCodexError(error)).toEqual({
      content:
        'Codex context window exceeded: context_length_exceeded: prompt is too long',
      error: 'invalid_request',
    })
  })

  test('does not misclassify usage entitlement failures as authentication', () => {
    const error = new ProviderStreamError(
      'usage_not_included: this plan does not include API usage',
      {
        kind: 'provider',
        retryable: false,
        terminal: true,
        status: 403,
        code: 'usage_not_included',
      },
    )

    expect(normalizeCodexError(error)).toEqual({
      content:
        'Codex usage is not included for this account: usage_not_included: this plan does not include API usage',
      error: 'invalid_request',
    })
  })

  test('preserves quota and overload classifications', () => {
    const quota = new ProviderStreamError(
      'insufficient_quota: quota exhausted',
      {
        kind: 'provider',
        retryable: false,
        terminal: true,
        status: 429,
        code: 'insufficient_quota',
      },
    )
    const overload = new ProviderStreamError(
      'server_is_overloaded: try again later',
      {
        kind: 'provider',
        retryable: true,
        terminal: true,
        status: 503,
        code: 'server_is_overloaded',
      },
    )

    expect(normalizeCodexError(quota).error).toBe('rate_limit')
    expect(normalizeCodexError(quota).content).toContain('quota exhausted')
    expect(normalizeCodexError(overload).error).toBe('server_error')
    expect(normalizeCodexError(overload).content).toContain(
      'temporarily overloaded',
    )
  })

  test('keeps an ordinary 403 as an authentication failure', () => {
    expect(
      normalizeCodexError({ statusCode: 403, message: 'Forbidden' }),
    ).toEqual({
      content: 'Codex authentication failed (403). Forbidden',
      error: 'authentication_failed',
    })
  })
})
