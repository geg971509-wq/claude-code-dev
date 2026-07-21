import { describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../tests/mocks/debug'
import { logMock } from '../../../tests/mocks/log'
import * as realSettings from '../settings/settings.js'

mock.module('src/utils/debug.ts', debugMock)
mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/settings/settings.js', () => ({
  ...realSettings,
  getInitialSettings: () => ({ modelType: 'grok' }),
}))
mock.module('src/services/analytics/index.ts', () => ({
  logEvent: () => {},
  logEventAsync: async () => {},
  stripProtoFields: <V>(value: V) => value,
  attachAnalyticsSink: () => {},
  _resetForTesting: () => {},
}))

mock.module('src/services/api/grok/client.ts', () => ({
  getGrokClient: () => ({
    chat: {
      completions: {
        create: async () => ({
          id: 'chatcmpl_grok_malformed',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: null,
                tool_calls: [
                  {
                    type: 'function',
                    id: 'call_malformed',
                    function: {
                      name: 'classify_result',
                      arguments: '{"shouldBlock":',
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 3,
            prompt_tokens_details: { cached_tokens: 2 },
          },
        }),
      },
    },
  }),
  clearGrokClientCache: () => {},
}))

const providerEnvKeys = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GROK',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const

for (const key of providerEnvKeys) delete process.env[key]
process.env.CLAUDE_CODE_USE_GROK = '1'
process.env.GROK_API_KEY = 'test-key-not-real'

const classifierTool = {
  name: 'classify_result',
  description: 'Classify the action',
  input_schema: {
    type: 'object',
    properties: { shouldBlock: { type: 'boolean' } },
  },
}

describe('sideQuery Grok malformed tool arguments', () => {
  test('falls back to an empty input without losing response metadata', async () => {
    const { sideQuery } = await import('../sideQuery.js')
    const result = await sideQuery({
      querySource: 'auto_mode',
      model: 'grok-test',
      messages: [{ role: 'user', content: 'classify' }],
      tools: [classifierTool as never],
      tool_choice: { type: 'tool', name: 'classify_result' },
    })

    const toolUse = result.content.find(block => block.type === 'tool_use')
    expect(toolUse).toEqual({
      type: 'tool_use',
      id: 'call_malformed',
      name: 'classify_result',
      input: {},
    })
    expect(result.stop_reason).toBe('tool_use')
    expect({
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      cache_creation_input_tokens: result.usage.cache_creation_input_tokens,
      cache_read_input_tokens: result.usage.cache_read_input_tokens,
    }).toEqual({
      input_tokens: 9,
      output_tokens: 3,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 2,
    })
  })
})
