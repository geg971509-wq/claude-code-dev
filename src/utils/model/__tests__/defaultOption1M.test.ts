import { describe, expect, test } from 'bun:test'
import { resolveDefaultOptionModel } from 'src/utils/model/defaultOption1M.js'

describe('resolveDefaultOptionModel', () => {
  // Storing `null` is what lets the session keep following whatever the
  // default model becomes later. An untouched toggle must not cost that.
  test('returns null when 1M is off and the default has no 1M', () => {
    expect(resolveDefaultOptionModel('claude-opus-5', false, false)).toBeNull()
  })

  test('returns null when 1M is on and the default already has 1M', () => {
    expect(
      resolveDefaultOptionModel('claude-opus-5[1m]', true, true),
    ).toBeNull()
  })

  // Regression: Space on the Default row used to be a no-op, because `null`
  // carries no model string to hang the `[1m]` suffix on. Turning 1M on now
  // pins a concrete setting instead of silently doing nothing.
  test('pins with a [1m] suffix when turning 1M on for a non-1M default', () => {
    expect(resolveDefaultOptionModel('claude-opus-5', true, false)).toBe(
      'claude-opus-5[1m]',
    )
  })

  test('pins the stripped form when turning 1M off for a 1M default', () => {
    expect(resolveDefaultOptionModel('claude-opus-5[1m]', false, true)).toBe(
      'claude-opus-5',
    )
  })

  // Pinning the raw setting rather than its resolved model name means an alias
  // tier still tracks version bumps inside that tier.
  test('pins the alias itself, not a resolved model name', () => {
    expect(resolveDefaultOptionModel('sonnet', true, false)).toBe('sonnet[1m]')
  })

  test('strips the suffix case-insensitively', () => {
    expect(resolveDefaultOptionModel('claude-opus-5[1M]', false, true)).toBe(
      'claude-opus-5',
    )
  })

  // CLAUDE_CODE_DISABLE_1M_CONTEXT (the C4E/HIPAA kill switch) makes the
  // caller's has1mContext report false even for a suffixed default, so a
  // suffixed setting reads as "no 1M" and leaving the toggle off is the
  // no-op case rather than an off-toggle that pins.
  test('treats a suffixed default as non-1M when the caller reports no 1M', () => {
    expect(
      resolveDefaultOptionModel('claude-opus-5[1m]', false, false),
    ).toBeNull()
  })
})
