import { describe, expect, test } from 'bun:test'
import { strip1mContextSuffix } from '../modelId.js'

describe('strip1mContextSuffix', () => {
  test('removes a trailing [1m] marker in either case', () => {
    expect(strip1mContextSuffix('kimi-k3[1m]')).toBe('kimi-k3')
    expect(strip1mContextSuffix('opus[1M]')).toBe('opus')
    expect(strip1mContextSuffix('sonnet-4-6[1m]')).toBe('sonnet-4-6')
  })

  test('leaves ids without the marker untouched', () => {
    expect(strip1mContextSuffix('gpt-4o')).toBe('gpt-4o')
    expect(strip1mContextSuffix('')).toBe('')
  })

  test('trims surrounding whitespace so it cannot reach the wire', () => {
    // Env overrides and preset files are hand-edited; a trailing space is
    // ordinary and used to survive into the model id on some paths.
    expect(strip1mContextSuffix('  kimi-k3[1m]  ')).toBe('kimi-k3')
    expect(strip1mContextSuffix(' gpt-4o ')).toBe('gpt-4o')
  })

  test('is anchored — a mid-string [1m] is part of the id, not a marker', () => {
    // The unanchored variants this replaced would corrupt such an id by
    // deleting from the middle.
    expect(strip1mContextSuffix('weird[1m]name')).toBe('weird[1m]name')
  })

  test('removes only the final marker', () => {
    expect(strip1mContextSuffix('opus[1m][1m]')).toBe('opus[1m]')
  })
})
