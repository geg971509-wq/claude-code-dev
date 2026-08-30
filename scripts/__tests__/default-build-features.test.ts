import { describe, expect, test } from 'bun:test'
import { FEATURE_FLAGS } from '../../src/constants/featureFlags.ts'
import { DEFAULT_BUILD_FEATURES } from '../defines.ts'

describe('DEFAULT_BUILD_FEATURES', () => {
  test('includes REACTIVE_COMPACT for build/dev emergency compact path', () => {
    expect(DEFAULT_BUILD_FEATURES).toContain('REACTIVE_COMPACT')
  })

  test('does not expose removed Direct Connect commands', () => {
    expect(DEFAULT_BUILD_FEATURES).not.toContain('DIRECT_CONNECT')
    expect(FEATURE_FLAGS).not.toContain('DIRECT_CONNECT')
  })
})
