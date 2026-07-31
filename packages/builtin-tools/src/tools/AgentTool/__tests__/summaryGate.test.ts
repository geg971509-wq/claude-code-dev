import { describe, expect, test } from 'bun:test'
import {
  lastAssistantText,
  SUMMARY_CONTINUATION_ATTEMPTS,
  SUMMARY_MIN_LENGTH,
} from '../summaryGate'

function assistant(text: string) {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  }
}

function assistantToolUseOnly() {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Read' }] },
  }
}

function user(text: string) {
  return { type: 'user', message: { content: text } }
}

describe('lastAssistantText', () => {
  test('returns the last assistant text', () => {
    expect(lastAssistantText([user('q'), assistant('hello')])).toBe('hello')
  })

  test('walks back past tool-use-only assistant messages', () => {
    expect(
      lastAssistantText([assistant('real answer'), assistantToolUseOnly()]),
    ).toBe('real answer')
  })

  test('walks back past trailing whitespace-only text', () => {
    expect(lastAssistantText([assistant('content'), assistant('   ')])).toBe(
      'content',
    )
  })

  test('joins multiple text blocks and trims', () => {
    const msg = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'part1 ' },
          { type: 'tool_use', id: 't', name: 'X' },
          { type: 'text', text: 'part2' },
        ],
      },
    }
    expect(lastAssistantText([msg])).toBe('part1 part2')
  })

  test('returns empty string when no assistant text exists', () => {
    expect(lastAssistantText([user('q'), assistantToolUseOnly()])).toBe('')
    expect(lastAssistantText([])).toBe('')
  })

  test('skips assistant messages with non-array content', () => {
    const weird = { type: 'assistant', message: { content: 'plain' } }
    expect(lastAssistantText([assistant('found'), weird])).toBe('found')
  })
})

describe('gate constants', () => {
  test('gate fires at most one continuation attempt', () => {
    expect(SUMMARY_CONTINUATION_ATTEMPTS).toBe(1)
    expect(SUMMARY_MIN_LENGTH).toBeGreaterThan(0)
  })
})
