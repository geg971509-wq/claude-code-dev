import { describe, expect, test } from 'bun:test'
import {
  COMPACT_TOOL_RESULT_MAX_CHARS,
  truncateToolResultsForCompaction,
} from '../toolResultTruncation'

function toolResultMsg(content: unknown): any {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content }],
    },
  }
}

function textMsg(text: string): any {
  return {
    type: 'user',
    message: { role: 'user', content: text },
  }
}

// Head and tail are distinguishable on purpose: a uniform 'x'.repeat() fixture
// satisfies a head-only truncator and a head+tail one identically, so it cannot
// witness the property this module exists for (keeping the END of tool output,
// where exit codes and failing assertions live).
const HEAD_MARKER = 'HEAD-START'
const TAIL_MARKER = 'TAIL-END'
const LONG = `${HEAD_MARKER}${'x'.repeat(
  COMPACT_TOOL_RESULT_MAX_CHARS + 500 - HEAD_MARKER.length - TAIL_MARKER.length,
)}${TAIL_MARKER}`

describe('truncateToolResultsForCompaction', () => {
  test('keeps both the head and the tail of over-limit string content', () => {
    const [out] = truncateToolResultsForCompaction([toolResultMsg(LONG)])
    const content = (out as any).message.content[0].content as string
    expect(content.startsWith(HEAD_MARKER)).toBe(true)
    // The load-bearing half: head-only truncation drops this.
    expect(content.endsWith(TAIL_MARKER)).toBe(true)
    expect(content).toContain(
      '[Tool output truncated for compaction: omitted 500 chars]',
    )
    expect(content.length).toBeLessThan(LONG.length)
  })

  test('splits the char budget evenly between head and tail', () => {
    const [out] = truncateToolResultsForCompaction(
      [toolResultMsg(`${'H'.repeat(150)}${'T'.repeat(150)}`)],
      50,
    )
    const content = (out as any).message.content[0].content as string
    // maxChars 50 → ceil(50/2)=25 head + 25 tail; the kept text is exactly the
    // two ends, so this also pins that the middle is what gets dropped.
    expect(content).toBe(
      `${'H'.repeat(25)}\n[Tool output truncated for compaction: omitted 250 chars]\n${'T'.repeat(25)}`,
    )
  })

  // The marker costs ~58 chars, so "truncating" a barely-over-limit string used
  // to return MORE text than it was given (2,001 chars in → 2,057 out at the
  // default limit). A function named truncate must never grow its input.
  test('leaves text alone when the marker would cost more than it saves', () => {
    for (const over of [1, 20, 57]) {
      const text = 'z'.repeat(COMPACT_TOOL_RESULT_MAX_CHARS + over)
      const msg = toolResultMsg(text)
      const [out] = truncateToolResultsForCompaction([msg])
      expect(out).toBe(msg)
    }
  })

  test('never returns more chars than it received, at any limit', () => {
    // Includes maxChars 0 and 1, where tailChars is 0 — a naive slice(-0)
    // returns the WHOLE string, so the omission marker got prepended to
    // untruncated text.
    const text = 'ABCDEFGHIJ'.repeat(10)
    for (const maxChars of [0, 1, 2, 3, 50, 99, 100, 101]) {
      const [out] = truncateToolResultsForCompaction(
        [toolResultMsg(text)],
        maxChars,
      )
      const content = (out as any).message.content[0].content as string
      expect(content.length).toBeLessThanOrEqual(text.length)
    }
  })

  test('leaves short string content untouched (identity)', () => {
    const msg = toolResultMsg('short output')
    const [out] = truncateToolResultsForCompaction([msg])
    expect(out).toBe(msg)
  })

  test('truncates text items inside array content, leaves others alone', () => {
    const msg = toolResultMsg([
      { type: 'text', text: LONG },
      { type: 'text', text: 'short' },
      { type: 'image', data: '...' },
    ])
    const [out] = truncateToolResultsForCompaction([msg])
    const [long, short, image] = (out as any).message.content[0]
      .content as any[]
    expect(long.text).toContain('omitted 500 chars')
    expect(short.text).toBe('short')
    expect(image.type).toBe('image')
  })

  test('array content with nothing over the limit is returned by identity', () => {
    const msg = toolResultMsg([{ type: 'text', text: 'fine' }])
    const [out] = truncateToolResultsForCompaction([msg])
    expect(out).toBe(msg)
  })

  test('ignores assistant and plain-text user messages', () => {
    const assistant: any = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: LONG }] },
    }
    const plain = textMsg(LONG)
    const [a, b] = truncateToolResultsForCompaction([assistant, plain])
    expect(a).toBe(assistant)
    expect(b).toBe(plain)
  })
})
