import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { authMockWith } from '../../../tests/mocks/auth'
import { settingsMockWith } from '../../../tests/mocks/settings'

// Mock heavy dependencies to avoid import chain issues
// Real module spread. Bare { isUltrathinkEnabled } blanked thinking.ts's other
// 7 exports process-wide, which surfaced in usage.test.ts and
// ultrareviewCommand.test.tsx as "Export named 'findThinkingTriggerPositions' /
// 'shouldEnableThinkingByDefault' not found".
const realThinking = (await import('src/utils/thinking.js')) as Record<
  string,
  unknown
>
mock.module('src/utils/thinking.js', () => ({
  ...realThinking,
  isUltrathinkEnabled: () => false,
}))
// Both spread the real module. A partial factory blanks the rest of the module
// process-wide — `mock.module` is global and last-write-wins — and a partial
// auth mock here made getAuthStatus.test.ts fail with "Export named
// 'getClaudeAIOAuthTokens' not found" whenever the two ran in the same process.
mock.module(
  'src/utils/settings/settings.js',
  await settingsMockWith({
    getInitialSettings: () => ({}),
  }),
)
mock.module(
  'src/utils/auth.js',
  await authMockWith({
    isProSubscriber: () => false,
    isMaxSubscriber: () => false,
    isTeamSubscriber: () => false,
  }),
)
mock.module('src/services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: (_key: string, defaultValue: unknown) =>
    defaultValue ?? {},
}))
mock.module('src/utils/model/modelSupportOverrides.js', () => ({
  get3PModelCapabilityOverride: () => undefined,
}))

const {
  isEffortLevel,
  parseEffortValue,
  isValidNumericEffort,
  convertEffortValueToLevel,
  getEffortLevelDescription,
  resolvePickerEffortPersistence,
  EFFORT_LEVELS,
} = await import('src/utils/effort.js')

// ─── EFFORT_LEVELS constant ────────────────────────────────────────────

describe('EFFORT_LEVELS', () => {
  test('contains the five canonical levels', () => {
    expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })
})

// ─── isEffortLevel ─────────────────────────────────────────────────────

describe('isEffortLevel', () => {
  test("returns true for 'low'", () => {
    expect(isEffortLevel('low')).toBe(true)
  })

  test("returns true for 'medium'", () => {
    expect(isEffortLevel('medium')).toBe(true)
  })

  test("returns true for 'high'", () => {
    expect(isEffortLevel('high')).toBe(true)
  })

  test("returns true for 'max'", () => {
    expect(isEffortLevel('max')).toBe(true)
  })

  test("returns false for 'invalid'", () => {
    expect(isEffortLevel('invalid')).toBe(false)
  })

  test('returns false for empty string', () => {
    expect(isEffortLevel('')).toBe(false)
  })
})

// ─── parseEffortValue ──────────────────────────────────────────────────

describe('parseEffortValue', () => {
  test('returns undefined for undefined', () => {
    expect(parseEffortValue(undefined)).toBeUndefined()
  })

  test('returns undefined for null', () => {
    expect(parseEffortValue(null)).toBeUndefined()
  })

  test('returns undefined for empty string', () => {
    expect(parseEffortValue('')).toBeUndefined()
  })

  test('returns number for integer input', () => {
    expect(parseEffortValue(42)).toBe(42)
  })

  test('returns string for valid effort level string', () => {
    expect(parseEffortValue('low')).toBe('low')
    expect(parseEffortValue('medium')).toBe('medium')
    expect(parseEffortValue('high')).toBe('high')
    expect(parseEffortValue('max')).toBe('max')
  })

  test('parses numeric string to number', () => {
    expect(parseEffortValue('42')).toBe(42)
  })

  test('returns undefined for invalid string', () => {
    expect(parseEffortValue('invalid')).toBeUndefined()
  })

  test('non-integer number falls through to string parsing (parseInt truncates)', () => {
    // 3.14 fails isValidNumericEffort, then String(3.14) -> "3.14" -> parseInt = 3
    expect(parseEffortValue(3.14)).toBe(3)
  })

  test('handles case-insensitive effort level strings', () => {
    expect(parseEffortValue('LOW')).toBe('low')
    expect(parseEffortValue('HIGH')).toBe('high')
  })
})

// ─── isValidNumericEffort ──────────────────────────────────────────────

describe('isValidNumericEffort', () => {
  test('returns true for integer', () => {
    expect(isValidNumericEffort(50)).toBe(true)
  })

  test('returns true for zero', () => {
    expect(isValidNumericEffort(0)).toBe(true)
  })

  test('returns true for negative integer', () => {
    expect(isValidNumericEffort(-1)).toBe(true)
  })

  test('returns false for float', () => {
    expect(isValidNumericEffort(3.14)).toBe(false)
  })

  test('returns false for NaN', () => {
    expect(isValidNumericEffort(NaN)).toBe(false)
  })

  test('returns false for Infinity', () => {
    expect(isValidNumericEffort(Infinity)).toBe(false)
  })
})

// ─── convertEffortValueToLevel ─────────────────────────────────────────

describe('convertEffortValueToLevel', () => {
  test('returns valid effort level string as-is', () => {
    expect(convertEffortValueToLevel('low')).toBe('low')
    expect(convertEffortValueToLevel('medium')).toBe('medium')
    expect(convertEffortValueToLevel('high')).toBe('high')
    expect(convertEffortValueToLevel('max')).toBe('max')
  })

  test("returns 'high' for unknown string", () => {
    expect(convertEffortValueToLevel('unknown' as any)).toBe('high')
  })

  test("non-ant numeric value returns 'high'", () => {
    const saved = process.env.USER_TYPE
    delete process.env.USER_TYPE

    expect(convertEffortValueToLevel(50)).toBe('high')
    expect(convertEffortValueToLevel(100)).toBe('high')

    process.env.USER_TYPE = saved
  })

  describe('ant numeric mapping', () => {
    let savedUserType: string | undefined

    beforeEach(() => {
      savedUserType = process.env.USER_TYPE
      process.env.USER_TYPE = 'ant'
    })

    afterEach(() => {
      if (savedUserType === undefined) {
        delete process.env.USER_TYPE
      } else {
        process.env.USER_TYPE = savedUserType
      }
    })

    test("value <= 50 maps to 'low'", () => {
      expect(convertEffortValueToLevel(50)).toBe('low')
      expect(convertEffortValueToLevel(0)).toBe('low')
      expect(convertEffortValueToLevel(-10)).toBe('low')
    })

    test("value 51-85 maps to 'medium'", () => {
      expect(convertEffortValueToLevel(51)).toBe('medium')
      expect(convertEffortValueToLevel(85)).toBe('medium')
    })

    test("value 86-100 maps to 'high'", () => {
      expect(convertEffortValueToLevel(86)).toBe('high')
      expect(convertEffortValueToLevel(100)).toBe('high')
    })

    test("value > 100 maps to 'max'", () => {
      expect(convertEffortValueToLevel(101)).toBe('max')
      expect(convertEffortValueToLevel(200)).toBe('max')
    })
  })
})

// ─── getEffortLevelDescription ─────────────────────────────────────────

describe('getEffortLevelDescription', () => {
  test("returns description for 'low'", () => {
    const desc = getEffortLevelDescription('low')
    expect(desc).toContain('Quick')
  })

  test("returns description for 'medium'", () => {
    const desc = getEffortLevelDescription('medium')
    expect(desc).toContain('Balanced')
  })

  test("returns description for 'high'", () => {
    const desc = getEffortLevelDescription('high')
    expect(desc).toContain('Comprehensive')
  })

  test("returns description for 'max'", () => {
    const desc = getEffortLevelDescription('max')
    expect(desc).toContain('Maximum')
  })

  test('max description does not contain model names', () => {
    const desc = getEffortLevelDescription('max')
    expect(desc).not.toContain('Opus')
    expect(desc).not.toContain('DeepSeek')
  })

  test("returns description for 'xhigh'", () => {
    const desc = getEffortLevelDescription('xhigh')
    expect(desc).toContain('Extended reasoning')
  })

  test('xhigh description does not contain model names', () => {
    const desc = getEffortLevelDescription('xhigh')
    expect(desc).not.toContain('Opus')
  })
})

// ─── resolvePickerEffortPersistence ────────────────────────────────────

describe('resolvePickerEffortPersistence', () => {
  test('returns undefined when picked matches model default and no prior persistence', () => {
    const result = resolvePickerEffortPersistence(
      'high',
      'high',
      undefined,
      false,
    )
    expect(result).toBeUndefined()
  })

  test('returns picked when it differs from model default', () => {
    const result = resolvePickerEffortPersistence(
      'low',
      'high',
      undefined,
      false,
    )
    expect(result).toBe('low')
  })

  test('returns picked when priorPersisted is set (even if same as default)', () => {
    const result = resolvePickerEffortPersistence('high', 'high', 'high', false)
    expect(result).toBe('high')
  })

  test('returns picked when toggledInPicker is true (even if same as default)', () => {
    const result = resolvePickerEffortPersistence(
      'high',
      'high',
      undefined,
      true,
    )
    expect(result).toBe('high')
  })

  test('returns undefined picked value when no explicit and matches default', () => {
    const result = resolvePickerEffortPersistence(
      undefined,
      'high' as any,
      undefined,
      false,
    )
    expect(result).toBeUndefined()
  })
})

// ─── modelSupportsMaxEffort ────────────────────────────────────────────

describe('modelSupportsMaxEffort', () => {
  test('returns true for opus-4-7', async () => {
    const { modelSupportsMaxEffort } = await import('src/utils/effort.js')
    expect(modelSupportsMaxEffort('claude-opus-4-7-20250918')).toBe(true)
  })

  test('returns true for opus-4-6', async () => {
    const { modelSupportsMaxEffort } = await import('src/utils/effort.js')
    expect(modelSupportsMaxEffort('claude-opus-4-6-20250514')).toBe(true)
  })

  test('returns true for sonnet models', async () => {
    const { modelSupportsMaxEffort } = await import('src/utils/effort.js')
    expect(modelSupportsMaxEffort('claude-sonnet-4-6-20250514')).toBe(true)
  })

  test('returns true for haiku models', async () => {
    const { modelSupportsMaxEffort } = await import('src/utils/effort.js')
    expect(modelSupportsMaxEffort('claude-haiku-4-5-20251001')).toBe(true)
  })

  test('returns true for deepseek models', async () => {
    const { modelSupportsMaxEffort } = await import('src/utils/effort.js')
    expect(modelSupportsMaxEffort('deepseek-v4-pro')).toBe(true)
  })

  test('returns true for unknown models', async () => {
    const { modelSupportsMaxEffort } = await import('src/utils/effort.js')
    expect(modelSupportsMaxEffort('some-random-model')).toBe(true)
  })
})

// ─── modelSupportsXhighEffort ──────────────────────────────────────────

describe('modelSupportsXhighEffort', () => {
  test('returns true for opus-4-7', async () => {
    const { modelSupportsXhighEffort } = await import('src/utils/effort.js')
    expect(modelSupportsXhighEffort('claude-opus-4-7-20250918')).toBe(true)
  })

  test('returns true for sonnet models', async () => {
    const { modelSupportsXhighEffort } = await import('src/utils/effort.js')
    expect(modelSupportsXhighEffort('claude-sonnet-4-6-20250514')).toBe(true)
  })

  test('returns true for haiku models', async () => {
    const { modelSupportsXhighEffort } = await import('src/utils/effort.js')
    expect(modelSupportsXhighEffort('claude-haiku-4-5-20251001')).toBe(true)
  })

  test('returns true for unknown models', async () => {
    const { modelSupportsXhighEffort } = await import('src/utils/effort.js')
    expect(modelSupportsXhighEffort('some-random-model')).toBe(true)
  })
})

// ─── modelSupportsEffort ───────────────────────────────────────────────

describe('modelSupportsEffort', () => {
  test('returns true for allowlisted opus-4-7', async () => {
    const { modelSupportsEffort } = await import('src/utils/effort.js')
    expect(modelSupportsEffort('claude-opus-4-7')).toBe(true)
  })

  test.each([
    'claude-3-7-sonnet-20250219',
    'claude-3-5-haiku-20241022',
    'claude-sonnet-4-20250514',
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-20250514',
    'claude-opus-4-1-20250805',
    'claude-opus-4-5-20251101',
    'claude-haiku-4-5-20251001',
    'us.anthropic.claude-opus-4-v1:0',
  ])('returns false for legacy model %s', async model => {
    const { modelSupportsEffort } = await import('src/utils/effort.js')
    expect(modelSupportsEffort(model)).toBe(false)
  })

  // Regression: the legacy exclusion used a bare `includes('opus')`, which also
  // swallowed families newer than the allowlist and returned false instead of
  // falling through to the 1P default below it. A pinned
  // ANTHROPIC_MODEL=claude-opus-5 then rendered "Effort not supported" in
  // /model and never sent output_config.effort.
  test.each([
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-haiku-5',
  ])('returns true for post-allowlist family %s on 1P', async model => {
    const providerEnvNames = [
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDE_CODE_USE_OPENAI',
      'CLAUDE_CODE_USE_GEMINI',
      'CLAUDE_CODE_USE_GROK',
    ] as const
    const saved = providerEnvNames.map(name => process.env[name])
    for (const name of providerEnvNames) delete process.env[name]
    try {
      const { modelSupportsEffort } = await import('src/utils/effort.js')
      expect(modelSupportsEffort(model)).toBe(true)
    } finally {
      for (const [index, name] of providerEnvNames.entries()) {
        const value = saved[index]
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
})
