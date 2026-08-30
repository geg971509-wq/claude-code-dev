import { APIUserAbortError } from '@anthropic-ai/sdk'
import { afterAll, describe, expect, mock, test } from 'bun:test'
import type { Options } from '../../claude.js'
import { debugMock } from '../../../../../tests/mocks/debug.js'
import type { SystemPrompt } from '../../../../utils/systemPromptType.js'
import {
  CODEX_CLIENT_REQUEST_ID_HEADER,
  CODEX_INSTALLATION_ID_METADATA_KEY,
  CODEX_SESSION_ID_HEADER,
  CODEX_THREAD_ID_HEADER,
  CODEX_WINDOW_ID_HEADER,
} from '../requestMetadata.js'

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

function requireMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = metadata?.[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected client_metadata.${key} to be a non-empty string`)
  }
  return value
}

afterAll(() => {
  delete process.env.CODEX_API_KEY
  delete process.env.CODEX_LOGIN_METHOD
  mock.restore()
})

describe('queryModelCodex request', () => {
  test('projects canonical request metadata, identity headers, and output schema', async () => {
    process.env.CODEX_API_KEY = 'test-key'
    process.env.CODEX_LOGIN_METHOD = 'api_key'
    let requestBody: Record<string, unknown> | undefined
    let requestHeaders: Headers | undefined
    const abortController = new AbortController()
    const outputSchema = {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    }

    const fetchOverride = (async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      requestHeaders = new Headers(init?.headers)
      abortController.abort()
      throw Object.assign(new Error('request captured'), { name: 'AbortError' })
    }) as unknown as typeof fetch

    const generator = queryModelCodex(
      [],
      [] as unknown as SystemPrompt,
      [],
      abortController.signal,
      {
        model: 'gpt-5.4',
        fetchOverride,
        outputFormat: {
          type: 'json_schema',
          schema: outputSchema,
        },
      } as unknown as Options,
    )

    let caught: unknown
    try {
      await generator.next()
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(APIUserAbortError)
    expect(requestBody?.parallel_tool_calls).toBe(true)
    expect(requestBody?.text).toEqual({
      format: {
        type: 'json_schema',
        name: 'side_query_output',
        schema: outputSchema,
        strict: true,
      },
    })
    const metadata = requestBody?.client_metadata as
      | Record<string, unknown>
      | undefined
    const installationId = requireMetadataString(
      metadata,
      CODEX_INSTALLATION_ID_METADATA_KEY,
    )
    const sessionId = requireMetadataString(metadata, 'session_id')
    const threadId = requireMetadataString(metadata, 'thread_id')
    const windowId = requireMetadataString(metadata, CODEX_WINDOW_ID_HEADER)

    expect(installationId.length).toBeGreaterThan(0)
    expect(sessionId).toBe(threadId)
    expect(windowId).toBe(`${threadId}:0`)
    expect(requestHeaders?.get(CODEX_SESSION_ID_HEADER)).toBe(sessionId)
    expect(requestHeaders?.get(CODEX_THREAD_ID_HEADER)).toBe(threadId)
    expect(requestHeaders?.get(CODEX_CLIENT_REQUEST_ID_HEADER)).toBe(threadId)
    expect(requestHeaders?.get(CODEX_WINDOW_ID_HEADER)).toBe(windowId)
  })

  test('rethrows a pre-existing user cancellation instead of yielding an API error message', async () => {
    process.env.CODEX_API_KEY = 'test-key'
    process.env.CODEX_LOGIN_METHOD = 'api_key'
    const abortController = new AbortController()
    abortController.abort()
    const fetchOverride = (async () => {
      throw Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
      })
    }) as unknown as typeof fetch
    const generator = queryModelCodex(
      [],
      [] as unknown as SystemPrompt,
      [],
      abortController.signal,
      { model: 'gpt-5.4', fetchOverride } as unknown as Options,
    )

    let caught: unknown
    try {
      await generator.next()
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(APIUserAbortError)
  })
})
