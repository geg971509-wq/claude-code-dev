import { describe, expect, test } from 'bun:test'
import {
  CODEX_TURN_STATE_HEADER,
  createCodexTurnState,
  getCodexClient,
} from '../client.js'

function createResponsesFixture(id: string, headers?: HeadersInit): Response {
  return new Response(
    JSON.stringify({
      id,
      object: 'response',
      created_at: 0,
      status: 'completed',
      model: 'gpt-5.6-sol',
      output: [],
      output_text: '',
      usage: null,
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...Object.fromEntries(new Headers(headers).entries()),
      },
    },
  )
}

describe('Codex turn-state routing', () => {
  test('captures the first response token and replays it within the turn', async () => {
    const seen: Array<string | null> = []
    let requestCount = 0
    const turnState = createCodexTurnState()
    const client = getCodexClient({
      apiKey: 'test-key',
      baseURL: 'https://example.test/v1',
      maxRetries: 0,
      turnState,
      fetchOverride: (async (
        _input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const headers = new Headers(init?.headers as HeadersInit | undefined)
        seen.push(headers.get(CODEX_TURN_STATE_HEADER))
        requestCount += 1
        return createResponsesFixture(
          `resp_${requestCount}`,
          requestCount === 1
            ? { [CODEX_TURN_STATE_HEADER]: 'turn-state-1' }
            : undefined,
        )
      }) as unknown as typeof fetch,
    })

    await client.responses.create({ model: 'gpt-5.6-sol', input: [] })
    await client.responses.create({ model: 'gpt-5.6-sol', input: [] })

    expect(turnState.value).toBe('turn-state-1')
    expect(seen).toEqual([null, 'turn-state-1'])
  })

  test('does not replace an established turn token', async () => {
    const turnState = createCodexTurnState()
    let requestCount = 0
    const client = getCodexClient({
      apiKey: 'test-key',
      baseURL: 'https://example.test/v1',
      maxRetries: 0,
      turnState,
      fetchOverride: (async () => {
        requestCount += 1
        return createResponsesFixture(`resp_${requestCount}`, {
          [CODEX_TURN_STATE_HEADER]: `turn-state-${requestCount}`,
        })
      }) as unknown as typeof fetch,
    })

    await client.responses.create({ model: 'gpt-5.6-sol', input: [] })
    await client.responses.create({ model: 'gpt-5.6-sol', input: [] })

    expect(turnState.value).toBe('turn-state-1')
  })
})
