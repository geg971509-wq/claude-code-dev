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

const LONG = 'x'.repeat(COMPACT_TOOL_RESULT_MAX_CHARS + 500)

describe('truncateToolResultsForCompaction', () => {
  test('truncates string tool_result content over the limit', () => {
    const [out] = truncateToolResultsForCompaction([toolResultMsg(LONG)])
    const content = (out as any).message.content[0].content as string
    expect(content.startsWith('x'.repeat(COMPACT_TOOL_RESULT_MAX_CHARS))).toBe(
      true,
    )
    expect(content).toContain(
      '[Tool output truncated for compaction: omitted 500 chars]',
    )
    expect(content.length).toBeLessThan(LONG.length)
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

  test('honors a custom maxChars', () => {
    const [out] = truncateToolResultsForCompaction(
      [toolResultMsg('a'.repeat(100))],
      50,
    )
    const content = (out as any).message.content[0].content as string
    expect(content).toContain('omitted 50 chars')
    expect(content.startsWith('a'.repeat(50))).toBe(true)
  })
})
