import { describe, expect, test } from 'bun:test'
import {
  finishReasonToAnthropicStopReason,
  normalizeAnthropicStopReason,
  normalizeGeminiFinishReason,
  normalizeOpenAIFinishReason,
  normalizeResponsesFinishReason,
} from '../finishReason.js'

describe('normalizeOpenAIFinishReason', () => {
  test('maps known chat-completions reasons', () => {
    expect(normalizeOpenAIFinishReason('stop')).toEqual({
      finishReason: 'completed',
      rawFinishReason: 'stop',
    })
    expect(normalizeOpenAIFinishReason('tool_calls')).toEqual({
      finishReason: 'tool_calls',
      rawFinishReason: 'tool_calls',
    })
    expect(normalizeOpenAIFinishReason('function_call')).toEqual({
      finishReason: 'tool_calls',
      rawFinishReason: 'function_call',
    })
    expect(normalizeOpenAIFinishReason('length')).toEqual({
      finishReason: 'truncated',
      rawFinishReason: 'length',
    })
    expect(normalizeOpenAIFinishReason('content_filter')).toEqual({
      finishReason: 'filtered',
      rawFinishReason: 'content_filter',
    })
  })

  test('null/unknown', () => {
    expect(normalizeOpenAIFinishReason(null)).toEqual({
      finishReason: null,
      rawFinishReason: null,
    })
    expect(normalizeOpenAIFinishReason('weird')).toEqual({
      finishReason: 'other',
      rawFinishReason: 'weird',
    })
  })
})

describe('normalizeAnthropicStopReason', () => {
  test('maps stop_reason values', () => {
    expect(normalizeAnthropicStopReason('end_turn').finishReason).toBe(
      'completed',
    )
    expect(normalizeAnthropicStopReason('max_tokens').finishReason).toBe(
      'truncated',
    )
    expect(normalizeAnthropicStopReason('tool_use').finishReason).toBe(
      'tool_calls',
    )
    expect(normalizeAnthropicStopReason('pause_turn').finishReason).toBe(
      'paused',
    )
    expect(normalizeAnthropicStopReason('refusal').finishReason).toBe(
      'filtered',
    )
  })
})

describe('normalizeGeminiFinishReason', () => {
  test('maps and uppercases', () => {
    expect(normalizeGeminiFinishReason('STOP').finishReason).toBe('completed')
    expect(normalizeGeminiFinishReason('max_tokens').finishReason).toBe(
      'truncated',
    )
    expect(normalizeGeminiFinishReason('SAFETY').finishReason).toBe('filtered')
    expect(
      normalizeGeminiFinishReason('FINISH_REASON_UNSPECIFIED').finishReason,
    ).toBeNull()
  })
})

describe('normalizeResponsesFinishReason', () => {
  test('status + incomplete details', () => {
    expect(normalizeResponsesFinishReason('completed').finishReason).toBe(
      'completed',
    )
    expect(
      normalizeResponsesFinishReason('incomplete', 'max_output_tokens')
        .finishReason,
    ).toBe('truncated')
    expect(
      normalizeResponsesFinishReason('incomplete', 'content_filter')
        .finishReason,
    ).toBe('filtered')
    expect(normalizeResponsesFinishReason('incomplete').finishReason).toBe(
      'truncated',
    )
  })
})

describe('finishReasonToAnthropicStopReason', () => {
  test('tool presence and truncation', () => {
    expect(finishReasonToAnthropicStopReason('truncated')).toBe('max_tokens')
    expect(finishReasonToAnthropicStopReason('tool_calls')).toBe('tool_use')
    expect(finishReasonToAnthropicStopReason('completed', true)).toBe(
      'tool_use',
    )
    expect(finishReasonToAnthropicStopReason('filtered')).toBe('end_turn')
    expect(finishReasonToAnthropicStopReason(null)).toBe('end_turn')
  })
})
