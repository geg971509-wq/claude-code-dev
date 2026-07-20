import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

mock.module('src/utils/proxy.js', () => ({
  getProxyFetchOptions: () => ({}) as any,
}))

import OpenAI from 'openai'
import { clearOpenAIClientCache, getOpenAIClient } from '../client.js'

describe('getOpenAIClient', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    clearOpenAIClientCache()
    process.env.OPENAI_API_KEY = 'test-key'
    delete process.env.OPENAI_BASE_URL
  })

  afterEach(() => {
    clearOpenAIClientCache()
    process.env = { ...originalEnv }
  })

  test('reuses the default client for omitted and explicit zero retries', () => {
    const defaultClient = getOpenAIClient()

    expect(defaultClient).toBeInstanceOf(OpenAI)
    expect(defaultClient.maxRetries).toBe(0)
    expect(getOpenAIClient({ maxRetries: 0 })).toBe(defaultClient)
  })

  test('caches retry policies independently when zero is created first', () => {
    const zeroRetries = getOpenAIClient({ maxRetries: 0 })
    const twoRetries = getOpenAIClient({ maxRetries: 2 })

    expect(zeroRetries).not.toBe(twoRetries)
    expect(zeroRetries.maxRetries).toBe(0)
    expect(twoRetries.maxRetries).toBe(2)
    expect(getOpenAIClient({ maxRetries: 0 })).toBe(zeroRetries)
    expect(getOpenAIClient({ maxRetries: 2 })).toBe(twoRetries)
  })

  test('caches retry policies independently when nonzero is created first', () => {
    const twoRetries = getOpenAIClient({ maxRetries: 2 })
    const zeroRetries = getOpenAIClient({ maxRetries: 0 })

    expect(twoRetries).not.toBe(zeroRetries)
    expect(twoRetries.maxRetries).toBe(2)
    expect(zeroRetries.maxRetries).toBe(0)
    expect(getOpenAIClient({ maxRetries: 2 })).toBe(twoRetries)
    expect(getOpenAIClient()).toBe(zeroRetries)
  })

  test('isolates fetch overrides from cached clients', async () => {
    const defaultClient = getOpenAIClient()
    const requests: Array<Parameters<typeof fetch>> = []
    const fetchOverride = mock(async (...args: Parameters<typeof fetch>) => {
      requests.push(args)
      return new Response(JSON.stringify({ data: [], object: 'list' }), {
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const overrideClient = getOpenAIClient({ fetchOverride })
    await overrideClient.models.list()
    const secondOverrideClient = getOpenAIClient({ fetchOverride })

    expect(overrideClient).not.toBe(defaultClient)
    expect(secondOverrideClient).not.toBe(overrideClient)
    expect(requests).toHaveLength(1)
    expect(getOpenAIClient()).toBe(defaultClient)
  })

  test('clears every retry-policy cache entry', () => {
    const zeroRetries = getOpenAIClient({ maxRetries: 0 })
    const twoRetries = getOpenAIClient({ maxRetries: 2 })

    clearOpenAIClientCache()

    expect(getOpenAIClient({ maxRetries: 0 })).not.toBe(zeroRetries)
    expect(getOpenAIClient({ maxRetries: 2 })).not.toBe(twoRetries)
  })
})
