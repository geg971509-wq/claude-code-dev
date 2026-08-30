import { describe, expect, test } from 'bun:test'
import { getCodexClient } from '../client.js'
import { CODEX_ORIGINATOR } from '../credentials.js'
import {
  CODEX_CLIENT_REQUEST_ID_HEADER,
  CODEX_SESSION_ID_HEADER,
  CODEX_THREAD_ID_HEADER,
  CODEX_WINDOW_ID_HEADER,
  createCodexRequestIdentity,
} from '../requestMetadata.js'

describe('Codex client request identity', () => {
  test('sends Codex session, thread, request, and window headers', async () => {
    let seenHeaders: Headers | undefined
    const requestIdentity = createCodexRequestIdentity({
      sessionId: 'session-1',
      installationId: 'installation-1',
      threadId: 'thread-1',
      windowNumber: 3,
    })
    const client = getCodexClient({
      apiKey: 'test-key',
      baseURL: 'https://example.test/v1',
      maxRetries: 0,
      requestIdentity,
      fetchOverride: (async (
        _input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        seenHeaders = new Headers(init?.headers)
        return new Response('{}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as unknown as typeof fetch,
    })

    await client.responses.create({ model: 'gpt-5.6-sol', input: [] })

    expect(seenHeaders?.get(CODEX_SESSION_ID_HEADER)).toBe('session-1')
    expect(seenHeaders?.get(CODEX_THREAD_ID_HEADER)).toBe('thread-1')
    expect(seenHeaders?.get(CODEX_CLIENT_REQUEST_ID_HEADER)).toBe('thread-1')
    expect(seenHeaders?.get(CODEX_WINDOW_ID_HEADER)).toBe('thread-1:3')
    expect(seenHeaders?.get('originator')).toBe(CODEX_ORIGINATOR)
  })
})
