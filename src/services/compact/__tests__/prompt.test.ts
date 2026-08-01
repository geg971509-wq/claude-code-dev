import { mock, describe, expect, test } from 'bun:test'

mock.module('bun:bundle', () => ({ feature: () => false }))

const { formatCompactSummary, getCompactPrompt, getCompactUserSummaryMessage } =
  await import('../prompt')

describe('formatCompactSummary', () => {
  test('strips <analysis>...</analysis> block', () => {
    const input =
      '<analysis>my thought process</analysis>\n<summary>the summary</summary>'
    const result = formatCompactSummary(input)
    expect(result).not.toContain('<analysis>')
    expect(result).not.toContain('my thought process')
  })

  test("replaces <summary>...</summary> with 'Summary:\\n' prefix", () => {
    const input = '<summary>key points here</summary>'
    const result = formatCompactSummary(input)
    expect(result).toContain('Summary:')
    expect(result).toContain('key points here')
    expect(result).not.toContain('<summary>')
  })

  test('handles analysis + summary together', () => {
    const input = '<analysis>thinking</analysis><summary>result</summary>'
    const result = formatCompactSummary(input)
    expect(result).not.toContain('thinking')
    expect(result).toContain('result')
  })

  test('handles summary without analysis', () => {
    const input = '<summary>just the summary</summary>'
    const result = formatCompactSummary(input)
    expect(result).toContain('just the summary')
  })

  test('handles analysis without summary', () => {
    const input = '<analysis>just analysis</analysis>and some text'
    const result = formatCompactSummary(input)
    expect(result).not.toContain('just analysis')
    expect(result).toContain('and some text')
  })

  test('collapses multiple newlines to double', () => {
    const input = 'hello\n\n\n\nworld'
    const result = formatCompactSummary(input)
    expect(result).not.toMatch(/\n{3,}/)
  })

  test('trims leading/trailing whitespace', () => {
    const input = '  \n  hello  \n  '
    const result = formatCompactSummary(input)
    expect(result).toBe('hello')
  })

  test('handles empty string', () => {
    expect(formatCompactSummary('')).toBe('')
  })

  test('handles plain text without tags', () => {
    const input = 'just plain text'
    expect(formatCompactSummary(input)).toBe('just plain text')
  })

  test('handles multiline analysis content', () => {
    const input =
      '<analysis>\nline1\nline2\nline3\n</analysis><summary>ok</summary>'
    const result = formatCompactSummary(input)
    expect(result).not.toContain('line1')
    expect(result).toContain('ok')
  })

  test('preserves content between analysis and summary', () => {
    const input =
      '<analysis>thoughts</analysis>middle text<summary>final</summary>'
    const result = formatCompactSummary(input)
    expect(result).toContain('middle text')
    expect(result).toContain('final')
  })
})

// compactConversation derives one `recentTailPreserved` flag and feeds it to
// both of these plus the fork's forkContextMessages override. If the tail is
// preserved, the summarizer is told the tail is "not shown above" — so the
// fork must be given head-only. These lock the two prompt-side consumers so
// the claim can't drift away from the flag that gates the override.
const TAIL_NOTE = 'not shown above'

describe('getCompactPrompt', () => {
  test('claims the tail is withheld only when a tail is preserved', () => {
    expect(
      getCompactPrompt(undefined, { recentTailPreserved: true }),
    ).toContain(TAIL_NOTE)
    expect(
      getCompactPrompt(undefined, { recentTailPreserved: false }),
    ).not.toContain(TAIL_NOTE)
    expect(getCompactPrompt()).not.toContain(TAIL_NOTE)
  })
})

describe('getCompactUserSummaryMessage', () => {
  test('announces preserved messages only when a tail is preserved', () => {
    const note = 'Recent messages are preserved verbatim.'
    expect(getCompactUserSummaryMessage('s', false, undefined, true)).toContain(
      note,
    )
    expect(
      getCompactUserSummaryMessage('s', false, undefined, false),
    ).not.toContain(note)
  })
})
