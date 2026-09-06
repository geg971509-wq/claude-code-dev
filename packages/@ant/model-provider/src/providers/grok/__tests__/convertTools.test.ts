import { describe, expect, test } from 'bun:test'
import { anthropicToolChoiceToGrokResponses } from '../convertTools.js'

describe('Grok Responses tool choice', () => {
  test('preserves explicit tool disabling instead of falling back to auto', () => {
    expect(anthropicToolChoiceToGrokResponses({ type: 'none' })).toBe('none')
  })

  test('maps automatic and required tool choices', () => {
    expect(anthropicToolChoiceToGrokResponses({ type: 'auto' })).toBe('auto')
    expect(anthropicToolChoiceToGrokResponses({ type: 'any' })).toBe('required')
  })

  test('preserves the forced function name without mutating the choice', () => {
    const choice = Object.freeze({ type: 'tool', name: 'read_file' })
    expect(anthropicToolChoiceToGrokResponses(choice)).toEqual({
      type: 'function',
      name: 'read_file',
    })
    expect(choice).toEqual({ type: 'tool', name: 'read_file' })
  })

  test('does not invent a choice for absent or malformed input', () => {
    for (const choice of [
      undefined,
      null,
      false,
      'auto',
      {},
      { type: 'unknown' },
      { type: 'tool' },
      { type: 'tool', name: 7 },
    ]) {
      expect(anthropicToolChoiceToGrokResponses(choice)).toBeUndefined()
    }
  })
})
