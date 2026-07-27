import { describe, expect, test } from 'bun:test'
import {
  isModelAlias,
  isModelFamilyAlias,
  strip1mContextSuffix,
} from '../aliases'

describe('isModelAlias', () => {
  test('returns true for "sonnet"', () => {
    expect(isModelAlias('sonnet')).toBe(true)
  })

  test('returns true for "opus"', () => {
    expect(isModelAlias('opus')).toBe(true)
  })

  test('returns true for "haiku"', () => {
    expect(isModelAlias('haiku')).toBe(true)
  })

  test('returns true for "best"', () => {
    expect(isModelAlias('best')).toBe(true)
  })

  test('returns true for "sonnet[1m]"', () => {
    expect(isModelAlias('sonnet[1m]')).toBe(true)
  })

  test('returns true for "opus[1m]"', () => {
    expect(isModelAlias('opus[1m]')).toBe(true)
  })

  test('returns true for "opusplan"', () => {
    expect(isModelAlias('opusplan')).toBe(true)
  })

  test('returns false for full model ID', () => {
    expect(isModelAlias('claude-sonnet-4-6-20250514')).toBe(false)
  })

  test('returns false for unknown string', () => {
    expect(isModelAlias('gpt-4')).toBe(false)
  })

  test('is case-sensitive', () => {
    expect(isModelAlias('Sonnet')).toBe(false)
  })
})

describe('isModelFamilyAlias', () => {
  test('returns true for "sonnet"', () => {
    expect(isModelFamilyAlias('sonnet')).toBe(true)
  })

  test('returns true for "opus"', () => {
    expect(isModelFamilyAlias('opus')).toBe(true)
  })

  test('returns true for "haiku"', () => {
    expect(isModelFamilyAlias('haiku')).toBe(true)
  })

  test('returns false for "best"', () => {
    expect(isModelFamilyAlias('best')).toBe(false)
  })

  test('returns false for "opusplan"', () => {
    expect(isModelFamilyAlias('opusplan')).toBe(false)
  })

  test('returns false for "sonnet[1m]"', () => {
    expect(isModelFamilyAlias('sonnet[1m]')).toBe(false)
  })
})

describe('strip1mContextSuffix', () => {
  test('removes a trailing [1m] marker in either case', () => {
    expect(strip1mContextSuffix('opus[1m]')).toBe('opus')
    expect(strip1mContextSuffix('sonnet[1M]')).toBe('sonnet')
    expect(strip1mContextSuffix('kimi-k3[1m]')).toBe('kimi-k3')
  })

  test('leaves ids without the marker untouched', () => {
    expect(strip1mContextSuffix('opus')).toBe('opus')
    expect(strip1mContextSuffix('')).toBe('')
  })

  test('trims before stripping, so a trailing space cannot hide the marker', () => {
    // The inline `.replace(...).trim()` copies this replaced got this backwards:
    // the space blocked the `$` anchor, so the marker survived into the request.
    expect(strip1mContextSuffix('opus[1m] ')).toBe('opus')
    expect(strip1mContextSuffix('  opus[1m]  ')).toBe('opus')
    expect(strip1mContextSuffix(' opus ')).toBe('opus')
  })

  test('is anchored — a mid-string [1m] belongs to the id', () => {
    expect(strip1mContextSuffix('weird[1m]name')).toBe('weird[1m]name')
  })

  test('removes only the final marker', () => {
    expect(strip1mContextSuffix('opus[1m][1m]')).toBe('opus[1m]')
  })
})
