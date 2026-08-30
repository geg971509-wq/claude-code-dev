import { describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { getAPIErrorDetail, getAssistantMessageFromError } from '../errors.js'

describe('getAPIErrorDetail', () => {
  test('extracts the nested message from an SDK JSON error envelope', () => {
    const error = new APIError(
      400,
      {
        error: {
          type: 'invalid_request_error',
          message: 'FIXTURE_BAD_REQUEST',
        },
      },
      undefined,
      new Headers(),
    )

    expect(getAPIErrorDetail(error)).toBe('FIXTURE_BAD_REQUEST')
  })

  test('formats generic API errors with status and nested message', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const error = new APIError(
      400,
      {
        error: {
          type: 'invalid_request_error',
          message: 'FIXTURE_BAD_REQUEST',
        },
      },
      undefined,
      new Headers(),
    )

    const message = getAssistantMessageFromError(error, 'claude-sonnet-4-6')
    expect(message.message.content).toEqual([
      { type: 'text', text: 'API Error: 400 FIXTURE_BAD_REQUEST' },
    ])
    expect(message.status).toBe(400)
  })
})
