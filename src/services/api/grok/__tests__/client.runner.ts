import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

mock.module('src/utils/proxy.js', () => ({
  getProxyFetchOptions: () => ({}) as any,
}))

import OpenAI from 'openai'
import {
  buildGrokRequestHeaders,
  clearGrokClientCache,
  getGrokClient,
} from '../client.js'

describe('getGrokClient', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    clearGrokClientCache()
    process.env.GROK_API_KEY = 'test-key'
    delete process.env.GROK_BASE_URL
  })

  afterEach(() => {
    clearGrokClientCache()
    process.env = { ...originalEnv }
  })

  test('uses the default base URL and reuses the zero-retry bucket', () => {
    const defaultClient = getGrokClient()

    expect(defaultClient).toBeInstanceOf(OpenAI)
    expect(defaultClient.baseURL).toBe('https://api.x.ai/v1')
    expect(defaultClient.maxRetries).toBe(0)
    expect(getGrokClient({ maxRetries: 0 })).toBe(defaultClient)
  })

  test('uses GROK_BASE_URL when set', () => {
    process.env.GROK_BASE_URL = 'https://custom.grok.api/v1'

    expect(getGrokClient().baseURL).toBe('https://custom.grok.api/v1')
  })

  test('does not reuse a client after base URL changes', () => {
    const defaultClient = getGrokClient()
    process.env.GROK_BASE_URL = 'https://custom.grok.api/v1'
    const customClient = getGrokClient()

    expect(customClient).not.toBe(defaultClient)
    expect(customClient.baseURL).toBe('https://custom.grok.api/v1')
  })

  test('does not reuse a client after API key changes', () => {
    const firstClient = getGrokClient()
    process.env.GROK_API_KEY = 'second-test-key'
    const secondClient = getGrokClient()

    expect(secondClient).not.toBe(firstClient)
  })

  test('isolates retry buckets when zero is created first', () => {
    const zeroRetries = getGrokClient({ maxRetries: 0 })
    const twoRetries = getGrokClient({ maxRetries: 2 })

    expect(zeroRetries).not.toBe(twoRetries)
    expect(zeroRetries.maxRetries).toBe(0)
    expect(twoRetries.maxRetries).toBe(2)
    expect(getGrokClient({ maxRetries: 0 })).toBe(zeroRetries)
    expect(getGrokClient({ maxRetries: 2 })).toBe(twoRetries)
  })

  test('isolates retry buckets when nonzero is created first', () => {
    const twoRetries = getGrokClient({ maxRetries: 2 })
    const zeroRetries = getGrokClient({ maxRetries: 0 })

    expect(twoRetries).not.toBe(zeroRetries)
    expect(twoRetries.maxRetries).toBe(2)
    expect(zeroRetries.maxRetries).toBe(0)
    expect(getGrokClient({ maxRetries: 2 })).toBe(twoRetries)
    expect(getGrokClient()).toBe(zeroRetries)
  })

  test('isolates fetch overrides from cached clients', async () => {
    const defaultClient = getGrokClient()
    const requests: Array<Parameters<typeof fetch>> = []
    const fetchOverride = mock(async (...args: Parameters<typeof fetch>) => {
      requests.push(args)
      return new Response(JSON.stringify({ data: [], object: 'list' }), {
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const overrideClient = getGrokClient({ fetchOverride })
    await overrideClient.models.list()
    const secondOverrideClient = getGrokClient({ fetchOverride })

    expect(overrideClient).not.toBe(defaultClient)
    expect(secondOverrideClient).not.toBe(overrideClient)
    expect(requests).toHaveLength(1)
    expect(getGrokClient()).toBe(defaultClient)
  })

  test('builds grok-build request identity headers', () => {
    const headers = buildGrokRequestHeaders({
      model: 'grok-4.6',
      sessionId: 'session-1',
      requestId: 'request-1',
      agentId: 'agent-1',
      transientRetry: 2,
    })

    expect(headers).toEqual({
      'x-grok-conv-id': 'session-1',
      'x-grok-req-id': 'request-1',
      'x-grok-model-override': 'grok-4.6',
      'x-grok-session-id': 'session-1',
      'x-grok-agent-id': 'agent-1',
      'x-grok-transient-retry': '2',
    })
  })

  test('clears every retry bucket', () => {
    const zeroRetries = getGrokClient({ maxRetries: 0 })
    const twoRetries = getGrokClient({ maxRetries: 2 })

    clearGrokClientCache()

    expect(getGrokClient({ maxRetries: 0 })).not.toBe(zeroRetries)
    expect(getGrokClient({ maxRetries: 2 })).not.toBe(twoRetries)
  })
})
