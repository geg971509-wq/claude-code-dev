import { describe, expect, test } from 'bun:test'
import { EMPTY_USAGE } from '@ant/model-provider'
import {
  fastModeDisabledReason,
  resultTiming,
  resultUsage,
} from '../QueryEngine.js'

describe('query result protocol', () => {
  test('adds thinking-token usage details without mutating usage', () => {
    const usage = resultUsage(EMPTY_USAGE)

    expect(usage.output_tokens_details).toEqual({ thinking_tokens: 0 })
    expect(EMPTY_USAGE.output_tokens_details).toBeUndefined()
  })

  test('reports independent first-response timings for successful results', () => {
    expect(resultTiming(100, 160.4, 130.2, 110.2, false)).toEqual({
      ttft_ms: 60,
      ttft_stream_ms: 30,
      time_to_request_ms: 10,
    })
  })

  test('omits first-response timings for API errors and missing observations', () => {
    expect(resultTiming(100, 160, 130, 110, true)).toEqual({})
    expect(resultTiming(100, 0, 0, 0, false)).toEqual({})
  })

  test('does not expose Claude-only result metadata on other model providers', () => {
    const providerFlags = [
      'CLAUDE_CODE_USE_OPENAI',
      'CLAUDE_CODE_USE_CODEX',
      'CLAUDE_CODE_USE_GEMINI',
      'CLAUDE_CODE_USE_GROK',
    ] as const
    const previous = Object.fromEntries(
      providerFlags.map(flag => [flag, process.env[flag]]),
    )

    try {
      for (const providerFlag of providerFlags) {
        for (const flag of providerFlags) delete process.env[flag]
        process.env[providerFlag] = '1'
        expect(fastModeDisabledReason()).toBeUndefined()
        expect(resultUsage(EMPTY_USAGE)).toBe(EMPTY_USAGE)
      }
    } finally {
      for (const flag of providerFlags) {
        const value = previous[flag]
        if (value === undefined) delete process.env[flag]
        else process.env[flag] = value
      }
    }
  })
})
