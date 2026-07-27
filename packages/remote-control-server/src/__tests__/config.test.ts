import { afterEach, describe, expect, test } from 'bun:test'
import { readPositiveInt } from '../config'

const KEY = 'RCS_TEST_NUMERIC'

afterEach(() => {
  delete process.env[KEY]
})

describe('readPositiveInt', () => {
  test('returns the fallback when unset or blank', () => {
    expect(readPositiveInt(KEY, 300)).toBe(300)
    process.env[KEY] = ''
    expect(readPositiveInt(KEY, 300)).toBe(300)
    process.env[KEY] = '   '
    expect(readPositiveInt(KEY, 300)).toBe(300)
  })

  test('returns a valid positive integer', () => {
    process.env[KEY] = '42'
    expect(readPositiveInt(KEY, 300)).toBe(42)
    // Surrounding whitespace is not a misconfiguration worth rejecting.
    process.env[KEY] = ' 42 '
    expect(readPositiveInt(KEY, 300)).toBe(42)
  })

  test('rejects a unit suffix instead of silently taking its leading digits', () => {
    // The regression this guards: parseInt('1h', 10) === 1, so the previous
    // `parseInt(...) || fallback` turned `RCS_JWT_EXPIRES_IN=1h` into a
    // one-second JWT lifetime rather than falling back to 3600.
    process.env[KEY] = '1h'
    expect(readPositiveInt(KEY, 3600)).toBe(3600)
    process.env[KEY] = '30s'
    expect(readPositiveInt(KEY, 20)).toBe(20)
  })

  test('rejects zero, negatives, and non-integers', () => {
    for (const raw of ['0', '-1', '-300', '1.5', 'abc', 'NaN', 'Infinity']) {
      process.env[KEY] = raw
      expect(readPositiveInt(KEY, 300)).toBe(300)
    }
  })
})
