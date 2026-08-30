import { afterEach, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug'
import { logMock } from '../../../../tests/mocks/log'

mock.module('bun:bundle', () => ({ feature: () => false }))
mock.module('src/utils/debug.ts', debugMock)
mock.module('src/utils/log.ts', logMock)

const { getThinkingDisplayForRequest } = await import('../claude.js')

const originalBaseUrl = process.env.ANTHROPIC_BASE_URL
const originalBedrock = process.env.CLAUDE_CODE_USE_BEDROCK

afterEach(() => {
  process.env.ANTHROPIC_BASE_URL = originalBaseUrl
  process.env.CLAUDE_CODE_USE_BEDROCK = originalBedrock
})

describe('getThinkingDisplayForRequest', () => {
  test('does not invent a display mode for non-interactive first-party requests', () => {
    delete process.env.ANTHROPIC_BASE_URL
    delete process.env.CLAUDE_CODE_USE_BEDROCK

    expect(
      getThinkingDisplayForRequest(
        { type: 'adaptive' },
        true,
        'claude-opus-4-6',
      ),
    ).toBeUndefined()
  })

  test('forwards an explicit display mode only for eligible first-party requests', () => {
    delete process.env.ANTHROPIC_BASE_URL
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    const config = { type: 'adaptive', display: 'summarized' } as const

    expect(getThinkingDisplayForRequest(config, true, 'claude-opus-4-6')).toBe(
      'summarized',
    )

    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(
      getThinkingDisplayForRequest(config, true, 'claude-opus-4-6'),
    ).toBeUndefined()
  })
})
