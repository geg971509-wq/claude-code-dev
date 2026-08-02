/**
 * CLAUDE_AUTOCOMPACT_PCT_OVERRIDE parse + threshold interaction.
 * Assertions use a runtime baseline for window size — never a pinned 144000.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  getAutocompactPctOverride,
  getAutoCompactThreshold,
} from '../autoCompact'
import { getEffectiveContextWindowSize } from '../effectiveWindow'

const ENV = 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'
// Same model choice as effectiveWindow.test.ts — avoids machine-local sonnet-1m config.
const MODEL = 'claude-opus-4-7'

afterEach(() => {
  delete process.env[ENV]
})

describe('getAutocompactPctOverride', () => {
  test('unset → null', () => {
    delete process.env[ENV]
    expect(getAutocompactPctOverride()).toBeNull()
  })

  test('valid percent → parsed number', () => {
    process.env[ENV] = '80'
    expect(getAutocompactPctOverride()).toBe(80)
  })

  test('0 / negative / >100 / non-numeric → null', () => {
    for (const v of ['0', '-1', '101', 'abc', '']) {
      process.env[ENV] = v
      expect(getAutocompactPctOverride()).toBeNull()
    }
  })
})

describe('getAutoCompactThreshold + override', () => {
  test('active override can only lower threshold', () => {
    delete process.env[ENV]
    const baseline = getAutoCompactThreshold(MODEL)
    process.env[ENV] = '80'
    const lowered = getAutoCompactThreshold(MODEL)
    expect(lowered).toBeLessThanOrEqual(baseline)
    const effective = getEffectiveContextWindowSize(MODEL)
    expect(lowered).toBe(Math.min(Math.floor(effective * 0.8), baseline))
  })

  test('invalid override leaves threshold unchanged', () => {
    delete process.env[ENV]
    const baseline = getAutoCompactThreshold(MODEL)
    process.env[ENV] = '999'
    expect(getAutoCompactThreshold(MODEL)).toBe(baseline)
  })
})
