import { afterEach, describe, expect, mock, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { APIUserAbortError } from '@anthropic-ai/sdk'
import { anthropicToolsToCodex } from '@ant/model-provider'
import type { Options } from '../../claude.js'
import type { Message } from '../../../../types/message.js'
import type { SystemPrompt } from '../../../../utils/systemPromptType.js'

const store: { blob: Record<string, unknown> } = { blob: {} }
let observationProvider: string | undefined

mock.module('src/utils/secureStorage/index.ts', () => ({
  getSecureStorage: () => ({
    read: () => store.blob,
    update: (next: Record<string, unknown>) => {
      store.blob = { ...next }
      return { success: true }
    },
    delete: () => true,
  }),
}))
mock.module('src/services/langfuse/tracing.ts', () => ({
  initLangfuse: () => {},
  shutdownLangfuse: async () => {},
  flushLangfuse: async () => {},
  isLangfuseEnabled: () => false,
  getLangfuseProcessor: () => undefined,
  createTrace: () => undefined,
  createSubagentTrace: () => undefined,
  createChildSpan: () => undefined,
  recordLLMObservation: (_trace: unknown, observation: unknown) => {
    observationProvider = (observation as { provider?: string }).provider
  },
  recordToolObservation: () => {},
  endTrace: () => {},
  createToolBatchSpan: () => undefined,
  endToolBatchSpan: () => {},
  sanitizeToolInput: (value: unknown) => value,
  sanitizeToolOutput: (value: unknown) => value,
  sanitizeGlobal: (value: unknown) => value,
}))
mock.module('src/services/langfuse/convert.ts', () => ({
  convertMessagesToLangfuse: () => [],
  convertOutputToLangfuse: () => [],
  convertToolsToLangfuse: () => [],
}))

const { queryModelCodex } = await import('../index.js')
const { clearCodexClientCache, prepareCodexStreamRequest } = await import(
  '../client.js'
)
const { _resetCodexAuthForTests, writeCodexAuth } = await import(
  '../credentials.js'
)

const originalFetch = globalThis.fetch
const systemPrompt = ['Follow instructions.'] as unknown as SystemPrompt
const userMessage = {
  type: 'user',
  uuid: 'user_1',
  timestamp: new Date(0).toISOString(),
  message: { role: 'user', content: 'hello' },
} as unknown as Message

function completedResponse(events?: Record<string, unknown>[]): Response {
  const frames = events ?? [
    { type: 'response.output_text.delta', delta: 'hello' },
    {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        status: 'completed',
        usage: { input_tokens: 3, output_tokens: 1 },
      },
    },
  ]
  return new Response(
    frames.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
    {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'x-request-id': 'req_1',
      },
    },
  )
}

function assistantText(event: unknown): string {
  if (typeof event !== 'object' || event === null) return ''
  const message = (event as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  return content
    .map(part =>
      typeof part === 'object' &&
      part !== null &&
      typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : '',
    )
    .join('')
}

function isDurableAssistant(event: unknown): boolean {
  return (
    typeof event === 'object' &&
    event !== null &&
    (event as { type?: unknown }).type === 'assistant' &&
    (event as { isApiErrorMessage?: unknown }).isApiErrorMessage !== true
  )
}

function assistantContent(
  event: unknown,
): Array<Record<string, unknown>> | null {
  if (typeof event !== 'object' || event === null) return null
  const message = (event as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return null
  const content = (message as { content?: unknown }).content
  return Array.isArray(content)
    ? (content as Array<Record<string, unknown>>)
    : null
}

async function drainQuery(options: Partial<Options> = {}) {
  const output = []
  for await (const event of queryModelCodex(
    [userMessage],
    systemPrompt,
    [],
    new AbortController().signal,
    {
      model: 'gpt-5.4',
      getToolPermissionContext: async () => ({}) as never,
      agents: [],
      ...options,
    } as unknown as Options,
  )) {
    output.push(event)
  }
  return output
}

function setCustomAuth(): void {
  process.env.CODEX_API_KEY = 'custom-key'
  process.env.CODEX_LOGIN_METHOD = 'api_key'
}

function setSubscriptionAuth(): void {
  process.env.CODEX_LOGIN_METHOD = 'chatgpt_subscription'
  writeCodexAuth({
    accessToken: 'old-access',
    refreshToken: 'refresh-token',
    accountId: 'acc_1',
    expiresAt: Date.now() + 60 * 60 * 1000,
  })
}

afterEach(() => {
  globalThis.fetch = originalFetch
  store.blob = {}
  observationProvider = undefined
  delete process.env.CODEX_API_KEY
  delete process.env.CODEX_LOGIN_METHOD
  delete process.env.CODEX_BASE_URL
  delete process.env.OPENAI_STREAM_MAX_RETRIES
  delete process.env.OPENAI_REQUEST_MAX_RETRIES
  delete process.env.CODEX_DEBUG_PAYLOADS
  _resetCodexAuthForTests()
  clearCodexClientCache()
})

describe('queryModelCodex shared Responses request', () => {
  test('subscription preserves private contract and identity headers', async () => {
    setSubscriptionAuth()
    let body: Record<string, unknown> = {}
    let headers = new Headers()
    const fetchOverride = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        headers = new Headers(init?.headers)
        return completedResponse()
      },
    ) as unknown as typeof fetch

    await drainQuery({
      fetchOverride,
      temperatureOverride: 0.25,
      maxOutputTokensOverride: 1234,
      effortValue: 'medium',
    })

    expect(body).toMatchObject({
      model: 'gpt-5.4',
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      instructions: 'Follow instructions.',
      prompt_cache_key: expect.any(String),
      client_metadata: {
        'x-codex-installation-id': expect.any(String),
        session_id: expect.any(String),
        thread_id: expect.any(String),
        'x-codex-window-id': expect.any(String),
      },
    })
    expect(body).not.toHaveProperty('max_output_tokens')
    expect(body).not.toHaveProperty('temperature')
    expect(body.reasoning).toMatchObject({ summary: 'auto' })
    expect(headers.get('originator')).toBe('codex_cli_rs')
    expect(headers.get('chatgpt-account-id')).toBe('acc_1')
    expect(headers.get('session-id')).toBeTruthy()
    expect(headers.get('thread-id')).toBe(headers.get('session-id'))
    expect(headers.get('x-client-request-id')).toBe(headers.get('session-id'))
    expect(headers.get('x-codex-window-id')).toBe(
      `${headers.get('session-id')}:0`,
    )
    expect(observationProvider).toBe('codex-chatgpt')
  })

  test('custom endpoint keeps output tuning and Codex request identity', async () => {
    setCustomAuth()
    process.env.CODEX_BASE_URL = 'https://codex.example.test/v1'
    let url = ''
    let body: Record<string, unknown> = {}
    let headers = new Headers()
    const fetchOverride = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        url = String(input)
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        headers = new Headers(init?.headers)
        return completedResponse()
      },
    ) as unknown as typeof fetch

    await drainQuery({
      fetchOverride,
      temperatureOverride: 0.4,
      maxOutputTokensOverride: 4321,
    })

    expect(url).toBe('https://codex.example.test/v1/responses')
    expect(body).toMatchObject({
      store: false,
      include: ['reasoning.encrypted_content'],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      max_output_tokens: 4321,
      temperature: 0.4,
    })
    expect(headers.get('originator')).toBe('codex_cli_rs')
    expect(headers.get('session-id')).toBeTruthy()
    expect(headers.get('thread-id')).toBe(headers.get('session-id'))
    expect(headers.get('x-client-request-id')).toBe(headers.get('session-id'))
    expect(headers.get('x-codex-window-id')).toBe(
      `${headers.get('session-id')}:0`,
    )
    expect(body.prompt_cache_key).toBe(headers.get('session-id'))
    expect(body.client_metadata).toMatchObject({
      'x-codex-installation-id': expect.any(String),
      session_id: headers.get('session-id'),
      thread_id: headers.get('thread-id'),
      'x-codex-window-id': headers.get('x-codex-window-id'),
    })
    expect(observationProvider).toBe('codex')
  })

  test('debug payload dump is forced to owner-only permissions', async () => {
    setCustomAuth()
    const dir = mkdtempSync(join(tmpdir(), 'codex-payload-'))
    const path = join(dir, 'payload.jsonl')
    writeFileSync(path, '', { mode: 0o644 })
    chmodSync(path, 0o644)
    process.env.CODEX_DEBUG_PAYLOADS = path

    try {
      await drainQuery({
        fetchOverride: mock(async () =>
          completedResponse(),
        ) as unknown as typeof fetch,
      })
      expect(statSync(path).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('shared adapter surfaces response.failed details', async () => {
    setCustomAuth()
    const fetchOverride = mock(async () =>
      completedResponse([
        {
          type: 'response.failed',
          response: {
            id: 'resp_failed',
            status: 'failed',
            error: {
              code: 'invalid_request_error',
              message: 'bad codex payload',
            },
          },
        },
      ]),
    ) as unknown as typeof fetch

    const output = await drainQuery({ fetchOverride })
    expect(assistantText(output.at(-1))).toContain('bad codex payload')
  })

  test('max_output_tokens preserves partial output without retrying', async () => {
    setCustomAuth()
    let calls = 0
    const fetchOverride = mock(async () => {
      calls++
      return completedResponse([
        { type: 'response.output_text.delta', delta: 'partial' },
        {
          type: 'response.incomplete',
          response: {
            id: 'resp_incomplete',
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            usage: { input_tokens: 3, output_tokens: 7 },
          },
        },
      ])
    }) as unknown as typeof fetch

    const output = await drainQuery({ fetchOverride })
    const durable = output.find(isDurableAssistant)
    const truncation = output.find(
      event =>
        event.type === 'assistant' &&
        event.isApiErrorMessage === true &&
        event.apiError === 'max_output_tokens',
    )

    expect(calls).toBe(1)
    expect(assistantText(durable)).toBe('partial')
    expect(durable?.message).toMatchObject({
      stop_reason: 'max_tokens',
      usage: { input_tokens: 3, output_tokens: 7 },
    })
    expect(truncation).toBeDefined()
    expect(assistantText(truncation)).toContain('CODEX_MAX_TOKENS')
    expect(assistantText(truncation)).not.toContain('OPENAI_MAX_TOKENS')
  })

  test('server_error incomplete remains retryable', async () => {
    setCustomAuth()
    let calls = 0
    const fetchOverride = mock(async () => {
      calls++
      return calls === 1
        ? completedResponse([
            { type: 'response.output_text.delta', delta: 'discarded' },
            {
              type: 'response.incomplete',
              response: {
                id: 'resp_incomplete',
                status: 'incomplete',
                incomplete_details: { reason: 'server_error' },
              },
            },
          ])
        : completedResponse()
    }) as unknown as typeof fetch

    const output = await drainQuery({ fetchOverride })
    expect(calls).toBe(2)
    expect(output.some(event => event.type === 'system')).toBe(true)
    expect(assistantText(output.find(isDurableAssistant))).toBe('hello')
  })

  test('shared adapter retains encrypted reasoning signature', async () => {
    setCustomAuth()
    const fetchOverride = mock(async () =>
      completedResponse([
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            type: 'reasoning',
            id: 'rs_1',
            encrypted_content: 'enc_codex',
          },
        },
        {
          type: 'response.reasoning_summary_text.delta',
          item_id: 'rs_1',
          delta: 'thinking',
        },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'reasoning',
            id: 'rs_1',
            encrypted_content: 'enc_codex',
          },
        },
        { type: 'response.output_text.delta', delta: 'done' },
        {
          type: 'response.completed',
          response: { id: 'resp_1', status: 'completed' },
        },
      ]),
    ) as unknown as typeof fetch

    const output = await drainQuery({ fetchOverride })
    const assistant = output.find(isDurableAssistant)
    expect(assistantContent(assistant)).toContainEqual(
      expect.objectContaining({
        type: 'thinking',
        signature: 'enc_codex',
      }),
    )
  })

  test('custom mode uses the shared request retry budget', async () => {
    setCustomAuth()
    let calls = 0
    const fetchOverride = mock(async () => {
      calls++
      return calls === 1
        ? new Response('temporary', {
            status: 500,
            headers: { 'retry-after': '0' },
          })
        : completedResponse()
    }) as unknown as typeof fetch

    const output = await drainQuery({ fetchOverride })
    expect(calls).toBe(2)
    expect(output.some(event => event.type === 'system')).toBe(true)
    expect(output.some(isDurableAssistant)).toBe(true)
  })

  test('subscription retry adopts a same-account token rotated elsewhere', async () => {
    setSubscriptionAuth()
    const authorizations: string[] = []
    let calls = 0
    const fetchOverride = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls++
        authorizations.push(
          new Headers(init?.headers).get('authorization') ?? '',
        )
        if (calls === 1) {
          writeCodexAuth({
            accessToken: 'rotated-elsewhere',
            refreshToken: 'refresh-token',
            accountId: 'acc_1',
            expiresAt: Date.now() + 60 * 60 * 1000,
          })
          return new Response('temporary', {
            status: 500,
            headers: { 'retry-after': '0.001' },
          })
        }
        return completedResponse()
      },
    ) as unknown as typeof fetch

    const output = await drainQuery({ fetchOverride })
    expect(output.some(isDurableAssistant)).toBe(true)
    expect(authorizations).toEqual([
      'Bearer old-access',
      'Bearer rotated-elsewhere',
    ])
  })

  test('subscription refreshes once and replays the same body on first 401', async () => {
    setSubscriptionAuth()
    process.env.OPENAI_REQUEST_MAX_RETRIES = '0'
    const bodies: string[] = []
    const authorizations: string[] = []
    let refreshes = 0
    globalThis.fetch = mock(async () => {
      refreshes++
      return new Response(
        JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    const fetchOverride = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(String(init?.body))
        authorizations.push(
          new Headers(init?.headers).get('authorization') ?? '',
        )
        return bodies.length === 1
          ? new Response('unauthorized', { status: 401 })
          : completedResponse()
      },
    ) as unknown as typeof fetch

    const output = await drainQuery({ fetchOverride })
    expect(output.some(event => event.type === 'assistant')).toBe(true)
    expect(refreshes).toBe(1)
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toBe(bodies[0])
    expect(authorizations).toEqual(['Bearer old-access', 'Bearer new-access'])
  })

  test('account switch after refresh cannot change replay credentials', async () => {
    setSubscriptionAuth()
    process.env.OPENAI_REQUEST_MAX_RETRIES = '0'
    const seen: Array<{
      authorization: string | null
      account: string | null
    }> = []
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({ access_token: 'new-access', expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch
    const fetchOverride = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        seen.push({
          authorization: headers.get('authorization'),
          account: headers.get('chatgpt-account-id'),
        })
        if (seen.length === 1)
          return new Response('unauthorized', { status: 401 })
        return completedResponse()
      },
    ) as unknown as typeof fetch

    const output = await drainQuery({ fetchOverride })
    expect(output.some(isDurableAssistant)).toBe(true)
    expect(seen).toEqual([
      { authorization: 'Bearer old-access', account: 'acc_1' },
      { authorization: 'Bearer new-access', account: 'acc_1' },
    ])
  })

  test('subscription preserves the provider 401 when refresh fails', async () => {
    setSubscriptionAuth()
    globalThis.fetch = mock(async () => {
      throw new Error('local refresh failed')
    }) as unknown as typeof fetch
    const fetchOverride = mock(
      async () => new Response('provider unauthorized', { status: 401 }),
    ) as unknown as typeof fetch

    const output = await drainQuery({ fetchOverride })
    expect(assistantText(output.at(-1))).toContain('401')
    expect(assistantText(output.at(-1))).toContain('provider unauthorized')
    expect(assistantText(output.at(-1))).not.toContain('local refresh failed')
  })

  test('second subscription 401 is terminal and custom 401 never refreshes', async () => {
    setSubscriptionAuth()
    let refreshes = 0
    globalThis.fetch = mock(async () => {
      refreshes++
      return new Response(
        JSON.stringify({ access_token: 'new-access', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    const subscriptionFetch = mock(
      async () => new Response('unauthorized', { status: 401 }),
    ) as unknown as typeof fetch

    const subscriptionOutput = await drainQuery({
      fetchOverride: subscriptionFetch,
    })
    expect(subscriptionFetch).toHaveBeenCalledTimes(2)
    expect(refreshes).toBe(1)
    expect(assistantText(subscriptionOutput.at(-1))).toContain('401')

    store.blob = {}
    clearCodexClientCache()
    setCustomAuth()
    const customFetch = mock(
      async () => new Response('unauthorized', { status: 401 }),
    ) as unknown as typeof fetch
    await drainQuery({ fetchOverride: customFetch })
    expect(customFetch).toHaveBeenCalledTimes(1)
    expect(refreshes).toBe(1)
  })

  test('user abort rejects with APIUserAbortError without assistant API error', async () => {
    setCustomAuth()
    const controller = new AbortController()
    const fetchOverride = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        controller.abort()
        throw init?.signal?.reason ?? new DOMException('Aborted', 'AbortError')
      },
    ) as unknown as typeof fetch

    const consume = async () => {
      for await (const _ of queryModelCodex(
        [userMessage],
        systemPrompt,
        [],
        controller.signal,
        {
          model: 'gpt-5.4',
          fetchOverride,
          getToolPermissionContext: async () => ({}) as never,
          agents: [],
        } as unknown as Options,
      )) {
        throw new Error('abort must not yield an assistant API error')
      }
    }

    await expect(consume()).rejects.toBeInstanceOf(APIUserAbortError)
  })

  test('user abort stops waiting for a shared subscription refresh', async () => {
    setSubscriptionAuth()
    let releaseRefresh: () => void = () => undefined
    globalThis.fetch = (() =>
      new Promise<Response>(resolve => {
        releaseRefresh = () =>
          resolve(
            new Response(
              JSON.stringify({
                access_token: 'new-access',
                refresh_token: 'new-refresh',
                expires_in: 3600,
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              },
            ),
          )
      })) as unknown as typeof fetch
    const controller = new AbortController()
    const prepared = prepareCodexStreamRequest({
      request: {
        model: 'gpt-5.4',
        input: [],
        stream: true,
      },
      requestContext: {
        apiKey: 'old-access',
        baseURL: 'https://chatgpt.com/backend-api/codex',
        accountId: 'acc_1',
      },
      subscription: true,
      fetchOverride: mock(
        async () => new Response('unauthorized', { status: 401 }),
      ) as unknown as typeof fetch,
    })

    setTimeout(() => controller.abort(), 20)
    const result = await Promise.race([
      prepared.createAttempt(controller.signal).then(
        () => 'resolved',
        () => 'aborted',
      ),
      Bun.sleep(300).then(() => 'timeout'),
    ])
    expect(result).toBe('aborted')
    releaseRefresh()
    await Bun.sleep(20)
  })

  test('Codex tool conversion preserves strict and defer_loading', () => {
    expect(
      anthropicToolsToCodex([
        {
          name: 'DeferredStrict',
          description: 'test',
          input_schema: { type: 'object' },
          strict: true,
          defer_loading: true,
        } as never,
      ]),
    ).toEqual([
      {
        type: 'function',
        name: 'DeferredStrict',
        description: 'test',
        parameters: { type: 'object' },
        strict: true,
        defer_loading: true,
      },
    ])
  })
})
