import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { Options } from '../../claude.js'
import type { Message } from '../../../../types/message.js'
import type { SystemPrompt } from '../../../../utils/systemPromptType.js'

const store: { blob: Record<string, unknown> } = { blob: {} }

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
  recordLLMObservation: () => {},
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
const { clearCodexClientCache } = await import('../client.js')
const { _resetCodexAuthForTests } = await import('../credentials.js')

const userMessage = {
  type: 'user',
  uuid: 'user_structured_output',
  timestamp: new Date(0).toISOString(),
  message: { role: 'user', content: 'return json' },
} as unknown as Message

function completedResponse(): Response {
  const frames = [
    { type: 'response.output_text.delta', delta: '{"ok":true}' },
    {
      type: 'response.completed',
      response: {
        id: 'resp_structured_output',
        status: 'completed',
        usage: { input_tokens: 3, output_tokens: 4 },
      },
    },
  ]
  return new Response(
    frames.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    },
  )
}

afterEach(() => {
  store.blob = {}
  delete process.env.CODEX_API_KEY
  delete process.env.CODEX_LOGIN_METHOD
  delete process.env.CODEX_BASE_URL
  _resetCodexAuthForTests()
  clearCodexClientCache()
})

describe('queryModelCodex structured output', () => {
  test('forwards outputFormat as a strict Responses json_schema', async () => {
    process.env.CODEX_API_KEY = 'test-key'
    process.env.CODEX_LOGIN_METHOD = 'api_key'
    process.env.CODEX_BASE_URL = 'https://codex.example.test/v1'

    const outputSchema = {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    }
    let body: Record<string, unknown> = {}
    const fetchOverride = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return completedResponse()
      },
    ) as unknown as typeof fetch

    for await (const _event of queryModelCodex(
      [userMessage],
      [] as unknown as SystemPrompt,
      [],
      new AbortController().signal,
      {
        model: 'gpt-5.4',
        getToolPermissionContext: async () => ({}) as never,
        agents: [],
        fetchOverride,
        outputFormat: {
          type: 'json_schema',
          schema: outputSchema,
        },
      } as unknown as Options,
    )) {
      // Drain the stream so request execution completes.
    }

    expect(body.text).toEqual({
      format: {
        type: 'json_schema',
        name: 'side_query_output',
        schema: outputSchema,
        strict: true,
      },
    })
  })
})
