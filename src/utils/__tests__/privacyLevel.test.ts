import { afterEach, describe, expect, test } from 'bun:test'
import {
  getPrivacyLevel,
  isEssentialTrafficOnly,
  isTelemetryDisabled,
  isTelemetryOptedIn,
  getEssentialTrafficOnlyReason,
} from '../privacyLevel'

describe('getPrivacyLevel', () => {
  const originalDisableNonessential =
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  const originalDisableTelemetry = process.env.DISABLE_TELEMETRY
  const originalEnableTelemetry = process.env.CLAUDE_CODE_ENABLE_TELEMETRY

  afterEach(() => {
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
    delete process.env.DISABLE_TELEMETRY
    delete process.env.CLAUDE_CODE_ENABLE_TELEMETRY
    if (originalDisableNonessential !== undefined) {
      process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC =
        originalDisableNonessential
    }
    if (originalDisableTelemetry !== undefined) {
      process.env.DISABLE_TELEMETRY = originalDisableTelemetry
    }
    if (originalEnableTelemetry !== undefined) {
      process.env.CLAUDE_CODE_ENABLE_TELEMETRY = originalEnableTelemetry
    }
  })

  test("returns 'no-telemetry' when no env vars set", () => {
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
    delete process.env.DISABLE_TELEMETRY
    delete process.env.CLAUDE_CODE_ENABLE_TELEMETRY
    expect(getPrivacyLevel()).toBe('no-telemetry')
  })

  test("returns 'default' only with explicit telemetry opt-in", () => {
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
    delete process.env.DISABLE_TELEMETRY
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1'
    expect(getPrivacyLevel()).toBe('default')
  })

  test("returns 'essential-traffic' when CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set", () => {
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    delete process.env.DISABLE_TELEMETRY
    expect(getPrivacyLevel()).toBe('essential-traffic')
  })

  test("returns 'no-telemetry' when DISABLE_TELEMETRY is set", () => {
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
    process.env.DISABLE_TELEMETRY = '1'
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1'
    expect(getPrivacyLevel()).toBe('no-telemetry')
  })

  test('treats falsey disable values as unset', () => {
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1'
    process.env.DISABLE_TELEMETRY = '0'
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = 'false'
    expect(getPrivacyLevel()).toBe('default')
  })

  test("'essential-traffic' takes priority over 'no-telemetry'", () => {
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    process.env.DISABLE_TELEMETRY = '1'
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1'
    expect(getPrivacyLevel()).toBe('essential-traffic')
  })
})

describe('isEssentialTrafficOnly', () => {
  const originalDisableNonessential =
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  const originalDisableTelemetry = process.env.DISABLE_TELEMETRY
  const originalEnableTelemetry = process.env.CLAUDE_CODE_ENABLE_TELEMETRY

  afterEach(() => {
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
    delete process.env.DISABLE_TELEMETRY
    delete process.env.CLAUDE_CODE_ENABLE_TELEMETRY
    if (originalDisableNonessential !== undefined)
      process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC =
        originalDisableNonessential
    if (originalDisableTelemetry !== undefined)
      process.env.DISABLE_TELEMETRY = originalDisableTelemetry
    if (originalEnableTelemetry !== undefined)
      process.env.CLAUDE_CODE_ENABLE_TELEMETRY = originalEnableTelemetry
  })

  test("returns true for 'essential-traffic' level", () => {
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    expect(isEssentialTrafficOnly()).toBe(true)
  })

  test("returns false for explicitly enabled 'default' level", () => {
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
    delete process.env.DISABLE_TELEMETRY
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1'
    expect(isEssentialTrafficOnly()).toBe(false)
  })

  test("returns false for 'no-telemetry' level", () => {
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
    process.env.DISABLE_TELEMETRY = '1'
    expect(isEssentialTrafficOnly()).toBe(false)
  })
})

describe('isTelemetryDisabled', () => {
  const originalDisableNonessential =
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  const originalDisableTelemetry = process.env.DISABLE_TELEMETRY
  const originalEnableTelemetry = process.env.CLAUDE_CODE_ENABLE_TELEMETRY

  afterEach(() => {
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
    delete process.env.DISABLE_TELEMETRY
    delete process.env.CLAUDE_CODE_ENABLE_TELEMETRY
    if (originalDisableNonessential !== undefined)
      process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC =
        originalDisableNonessential
    if (originalDisableTelemetry !== undefined)
      process.env.DISABLE_TELEMETRY = originalDisableTelemetry
    if (originalEnableTelemetry !== undefined)
      process.env.CLAUDE_CODE_ENABLE_TELEMETRY = originalEnableTelemetry
  })

  test("returns true for 'no-telemetry' level", () => {
    process.env.DISABLE_TELEMETRY = '1'
    expect(isTelemetryDisabled()).toBe(true)
  })

  test("returns true for 'essential-traffic' level", () => {
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    expect(isTelemetryDisabled()).toBe(true)
  })

  test('returns true without explicit opt-in', () => {
    expect(isTelemetryDisabled()).toBe(true)
  })

  test("returns false for explicitly enabled 'default' level", () => {
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1'
    expect(isTelemetryDisabled()).toBe(false)
  })
})

describe('isTelemetryOptedIn', () => {
  afterEach(() => {
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
    delete process.env.DISABLE_TELEMETRY
    delete process.env.CLAUDE_CODE_ENABLE_TELEMETRY
  })

  test('requires an explicit truthy enable flag', () => {
    expect(isTelemetryOptedIn()).toBe(false)
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = 'true'
    expect(isTelemetryOptedIn()).toBe(true)
  })

  test('explicit disable flags override opt-in', () => {
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1'
    process.env.DISABLE_TELEMETRY = '1'
    expect(isTelemetryOptedIn()).toBe(false)
  })
})

describe('getEssentialTrafficOnlyReason', () => {
  afterEach(() => {
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  })

  test('returns env var name when restricted', () => {
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    expect(getEssentialTrafficOnlyReason()).toBe(
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    )
  })

  test('returns null when unrestricted', () => {
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
    expect(getEssentialTrafficOnlyReason()).toBeNull()
  })
})
