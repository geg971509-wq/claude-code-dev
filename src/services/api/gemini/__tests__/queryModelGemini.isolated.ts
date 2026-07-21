import { describe, expect, mock, test } from 'bun:test'
import type { AssistantMessage } from '../../../../types/message.js'
import type { GeminiStreamChunk } from '../../../../../packages/@ant/model-provider/src/index.js'
import * as realModelProvider from '../../../../../packages/@ant/model-provider/src/index.js'
import { debugMock } from '../../../../../tests/mocks/debug'

mock.module('src/utils/debug.ts', debugMock)

const chunks: GeminiStreamChunk[] = [
  {
    candidates: [
      {
        content: {
          parts: [
            {
              text: 'plan',
              thought: true,
              thoughtSignature: 'sig-plan',
            },
          ],
        },
      },
    ],
  },
  {
    candidates: [
      {
        content: { parts: [{ text: 'answer' }] },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      thoughtsTokenCount: 2,
      cachedContentTokenCount: 3,
    },
  },
]

mock.module('@ant/model-provider', () => ({
  ...realModelProvider,
  resolveGeminiModel: (model: string) => model,
  anthropicMessagesToGemini: () => ({
    contents: [],
    systemInstruction: undefined,
  }),
  anthropicToolsToGemini: () => [],
  anthropicToolChoiceToGemini: () => undefined,
}))

mock.module('src/services/api/gemini/client.ts', () => ({
  streamGeminiGenerateContent: () => ({
    async *[Symbol.asyncIterator]() {
      yield* chunks
    },
  }),
}))

mock.module('src/utils/messages.ts', () => ({
  normalizeMessagesForAPI: (messages: unknown[]) => messages,
  normalizeContentFromAPI: (blocks: Array<Record<string, unknown>>) => blocks,
  createAssistantAPIErrorMessage: ({ content }: { content: string }) => ({
    type: 'assistant',
    isApiErrorMessage: true,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: content }],
    },
    uuid: 'error-message',
  }),
}))

mock.module('src/utils/api.ts', () => ({
  toolToAPISchema: async (tool: unknown) => tool,
}))

mock.module('src/services/api/errors.ts', () => ({
  getAssistantMessageFromError: () => {
    throw new Error('unreachable')
  },
}))

let recordedUsage: Record<string, number> | undefined
mock.module('src/services/langfuse/tracing.ts', () => ({
  recordLLMObservation: (
    _span: unknown,
    params: { usage: Record<string, number> },
  ) => {
    recordedUsage = params.usage
  },
}))

mock.module('src/services/langfuse/convert.ts', () => ({
  convertMessagesToLangfuse: (messages: unknown) => messages,
  convertOutputToLangfuse: (messages: unknown) => messages,
  convertToolsToLangfuse: (tools: unknown) => tools,
}))

describe('queryModelGemini final message state', () => {
  test('writes final usage and stop reason to the last content message', async () => {
    recordedUsage = undefined
    const { queryModelGemini } = await import('../index.js')
    const assistantMessages: AssistantMessage[] = []

    for await (const item of queryModelGemini(
      [],
      [] as never,
      [],
      new AbortController().signal,
      {
        model: 'gemini-test',
        tools: [],
        agents: [],
        querySource: 'main_loop',
      } as never,
      { type: 'enabled', budgetTokens: 128 },
    )) {
      if (item.type === 'assistant') {
        assistantMessages.push(item as AssistantMessage)
      }
    }

    expect(assistantMessages).toHaveLength(2)
    expect(assistantMessages[0]!.message.content).toEqual([
      {
        type: 'thinking',
        thinking: 'plan',
        signature: 'sig-plan',
      },
    ])
    expect(assistantMessages[1]!.message.content).toEqual([
      { type: 'text', text: 'answer' },
    ])
    expect(assistantMessages[1]!.message.stop_reason).toBe('end_turn')
    expect(assistantMessages[1]!.message.usage).toEqual({
      input_tokens: 10,
      output_tokens: 7,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 3,
    })
    expect(recordedUsage as Record<string, number> | undefined).toEqual({
      input_tokens: 10,
      output_tokens: 7,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 3,
    })
  })
})
