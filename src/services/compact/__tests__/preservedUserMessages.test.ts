import { describe, expect, test } from 'bun:test'
import {
  estimateTokens,
  formatPreservedSection,
  isRealUserMessage,
  selectPreservedUserMessages,
  truncateToTokenHead,
  truncateToTokenTail,
  userMessageText,
} from '../preservedUserMessages'

function makeMsg(
  text: string,
  extra: Record<string, unknown> = {},
): {
  type: string
  isMeta?: boolean
  isCompactSummary?: boolean
  isVisibleInTranscriptOnly?: boolean
  message: { content: unknown }
} {
  return { type: 'user', message: { content: text }, ...extra }
}

describe('estimateTokens', () => {
  test('estimates ASCII at ~4 chars per token', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  test('estimates non-ASCII at ~1 char per token', () => {
    expect(estimateTokens('你好')).toBe(2)
  })
})

describe('truncateToTokenHead / truncateToTokenTail', () => {
  test('head keeps the beginning of a long text', () => {
    const text = 'a'.repeat(400)
    const out = truncateToTokenHead(text, 10)
    expect(out.startsWith('a'.repeat(39))).toBe(true)
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThan(50)
  })

  test('tail keeps the end of a long text', () => {
    const text = `${'a'.repeat(380)}TAIL_MARKER_TEXT`
    const out = truncateToTokenTail(text, 10)
    expect(out.startsWith('…')).toBe(true)
    expect(out.endsWith('TAIL_MARKER_TEXT')).toBe(true)
  })

  test('short text passes through untouched', () => {
    expect(truncateToTokenHead('hi', 100)).toBe('hi')
    expect(truncateToTokenTail('hi', 100)).toBe('hi')
  })
})

describe('isRealUserMessage', () => {
  test('accepts plain text user messages', () => {
    expect(isRealUserMessage(makeMsg('fix the bug'))).toBe(true)
  })

  test('accepts array content with only text blocks', () => {
    const msg = makeMsg(null as unknown as string)
    msg.message.content = [{ type: 'text', text: 'hello' }]
    expect(isRealUserMessage(msg)).toBe(true)
  })

  test('rejects tool_result user messages', () => {
    const msg = makeMsg(null as unknown as string)
    msg.message.content = [
      { type: 'tool_result', tool_use_id: 't1', content: 'big output' },
    ]
    expect(isRealUserMessage(msg)).toBe(false)
  })

  test('rejects mixed content with any non-text block', () => {
    const msg = makeMsg(null as unknown as string)
    msg.message.content = [
      { type: 'text', text: 'look at this' },
      { type: 'image', source: {} },
    ]
    expect(isRealUserMessage(msg)).toBe(false)
  })

  test('rejects meta, compact summary, transcript-only, assistant', () => {
    expect(isRealUserMessage(makeMsg('x', { isMeta: true }))).toBe(false)
    expect(isRealUserMessage(makeMsg('x', { isCompactSummary: true }))).toBe(
      false,
    )
    expect(
      isRealUserMessage(makeMsg('x', { isVisibleInTranscriptOnly: true })),
    ).toBe(false)
    expect(isRealUserMessage({ ...makeMsg('x'), type: 'assistant' })).toBe(
      false,
    )
  })

  test('rejects empty/whitespace text', () => {
    expect(isRealUserMessage(makeMsg('   '))).toBe(false)
  })
})

describe('userMessageText', () => {
  test('extracts string content', () => {
    expect(userMessageText(makeMsg('hello'))).toBe('hello')
  })

  test('joins text blocks', () => {
    const msg = makeMsg(null as unknown as string)
    msg.message.content = [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]
    expect(userMessageText(msg)).toBe('a\nb')
  })
})

describe('selectPreservedUserMessages', () => {
  test('keeps everything when under budget (no head/tail split)', () => {
    const selection = selectPreservedUserMessages([
      makeMsg('first task'),
      makeMsg('second instruction'),
    ])
    expect(selection.omitted).toBe(false)
    expect(selection.head).toEqual([])
    expect(selection.tail).toEqual(['first task', 'second instruction'])
  })

  test('splits HEAD and TAIL when over budget', () => {
    // ~40 tokens each (160 chars), 5 messages = ~200 tokens total
    const texts = Array.from(
      { length: 5 },
      (_, i) => `msg${i}:${'x'.repeat(156)}`,
    )
    const selection = selectPreservedUserMessages(
      texts.map(t => makeMsg(t)),
      100, // maxTokens
      40, // headTokens
    )
    expect(selection.omitted).toBe(true)
    // HEAD keeps the oldest message(s) from the beginning
    expect(selection.head[0]!.startsWith('msg0:')).toBe(true)
    // TAIL keeps the newest message(s) from the end
    expect(selection.tail.at(-1)!.startsWith('msg4:')).toBe(true)
    expect(selection.omittedTokenEstimate).toBeGreaterThanOrEqual(0)
  })

  test('truncates boundary messages from the correct side', () => {
    const texts = Array.from(
      { length: 3 },
      (_, i) => `msg${i}:${'y'.repeat(396)}`,
    ) // ~100 tokens each
    const selection = selectPreservedUserMessages(
      texts.map(t => makeMsg(t)),
      60,
      30,
    )
    expect(selection.omitted).toBe(true)
    // Head boundary truncated keeps the beginning (… at end)
    expect(selection.head[0]!.endsWith('…')).toBe(true)
    expect(selection.head[0]!.startsWith('msg0:')).toBe(true)
    // Tail boundary truncated keeps the end (… at start)
    expect(selection.tail.at(-1)!.startsWith('…')).toBe(true)
  })

  test('excludes tool_result and meta messages from candidates', () => {
    const toolResult = makeMsg(null as unknown as string)
    toolResult.message.content = [
      { type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(10000) },
    ]
    const selection = selectPreservedUserMessages([
      makeMsg('real task'),
      toolResult,
      makeMsg('meta', { isMeta: true }),
    ])
    expect(selection.omitted).toBe(false)
    expect(selection.tail).toEqual(['real task'])
  })

  test('returns empty selection with no real user messages', () => {
    const selection = selectPreservedUserMessages([
      { ...makeMsg('x'), type: 'assistant' },
    ])
    expect(selection.tail).toEqual([])
    expect(selection.head).toEqual([])
  })
})

describe('formatPreservedSection', () => {
  test('returns empty string for empty selection', () => {
    expect(
      formatPreservedSection({
        head: [],
        tail: [],
        omitted: false,
        omittedTokenEstimate: 0,
      }),
    ).toBe('')
  })

  test('labels oldest vs recent sections when omitted', () => {
    const out = formatPreservedSection({
      head: ['original ask'],
      tail: ['latest instruction'],
      omitted: true,
      omittedTokenEstimate: 123,
    })
    expect(out).toContain('<preserved-user-messages>')
    expect(out).toContain('Oldest user input')
    expect(out).toContain('original ask')
    expect(out).toContain('123 tokens')
    expect(out).toContain('Most recent user messages')
    expect(out).toContain('latest instruction')
    expect(out).toContain('</preserved-user-messages>')
  })

  test('omits labels when nothing was elided', () => {
    const out = formatPreservedSection({
      head: [],
      tail: ['only message'],
      omitted: false,
      omittedTokenEstimate: 0,
    })
    expect(out).toContain('only message')
    expect(out).not.toContain('Oldest user input')
  })
})
