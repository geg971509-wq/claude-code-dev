import { describe, expect, test } from 'bun:test'
import { DEFAULT_BUILD_FEATURES } from '../defines.ts'

describe('DEFAULT_BUILD_FEATURES', () => {
  test('includes REACTIVE_COMPACT for build/dev emergency compact path', () => {
    expect(DEFAULT_BUILD_FEATURES).toContain('REACTIVE_COMPACT')
  })
})
