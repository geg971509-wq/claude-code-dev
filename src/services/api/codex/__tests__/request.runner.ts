import { afterAll, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../../tests/mocks/debug.js'
import type { Options } from '../../claude.js'
import type { SystemPrompt } from '../../../../utils/systemPromptType.js'

mock.module('src/utils/debug.ts', debugMock)
mock.module('src/utils/secureStorage/index.ts', () => ({
  getSecureStorage: () => ({
    read: () => ({}),
    update: () => ({ success: true }),
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

afterAll(() => {
  delete process.env.CODEX_API_KEY
  delete process.env.CODEX_LOGIN_METHOD
  mock.restore()
})

describe('queryModelCodex request', () => {
  test('enables parallel tool calls', async () => {
    process.env.CODEX_API_KEY = 'test-key'
    process.env.CODEX_LOGIN_METHOD = 'api_key'
    let requestBody: Record<string, unknown> | undefined
    const abortController = new AbortController()

    const fetchOverride = (async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      abortController.abort()
      throw Object.assign(new Error('request captured'), { status: 400 })
    }) as unknown as typeof fetch

    for await (const _ of queryModelCodex(
      [],
      [] as unknown as SystemPrompt,
      [],
      abortController.signal,
      { model: 'gpt-5.4', fetchOverride } as unknown as Options,
    )) {
      // Drain the handled API error so the request has been issued.
    }

    expect(requestBody?.parallel_tool_calls).toBe(true)
  })
})
