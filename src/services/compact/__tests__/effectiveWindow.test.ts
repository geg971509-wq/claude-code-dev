/**
 * getEffectiveContextWindowSize was two verbatim copies (compact.ts +
 * autoCompact.ts) before being hoisted here. The equivalence evidence for that
 * move was a throwaway differential script; this file is the durable version.
 *
 * Assertions are relative to a baseline captured at runtime, never hardcoded.
 * The absolute value is not stable: measured 180000 bare, 100000 under
 * USER_TYPE=ant + CLAUDE_CODE_MAX_CONTEXT_TOKENS, 195000 under
 * CLAUDE_CODE_MAX_OUTPUT_TOKENS=5000, and getContextWindowForModel also
 * consults a disk cache (utils/model/modelCapabilities.ts, memoized
 * process-wide) plus getGlobalConfig for the sonnet-4-6 1M treatment. Pinning a
 * number here would make this file fail for reasons that have nothing to do
 * with the code it covers.
 *
 * If this file ever dies with `SyntaxError: Export named 'waitForScrollIdle'
 * not found`, that is not a compaction bug: getMaxOutputTokensForModel pulls in
 * a large module graph that reaches bootstrap/state, and every file that
 * mock.modules bootstrap/state omits that export — process-globally. Not
 * introduced here; the tracked buildPostCompactMessages.test.ts dies
 * identically under the same load order.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSdkBetas, setSdkBetas } from '../../../bootstrap/state'
import { CONTEXT_1M_BETA_HEADER } from '../../../constants/betas'
import { getMaxOutputTokensForModel } from '../../api/claude'
import { getGlobalConfig, saveGlobalConfig } from '../../../utils/config'
import {
  getEffectiveContextWindowSize,
  MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  parseAutoCompactWindow,
  resolveAutoCompactWindow,
} from '../effectiveWindow'

// Both tests below need a model whose base window is 200k and whose 1M is
// beta-gated — the official model table records those as two separate facts
// (`context.window` vs `context.supports_1m_beta`). sonnet-4-5 is that shape;
// opus-4-7 is not (it is `native_1m`, so the beta has nothing left to raise
// and the reserve gap disappears behind a 5x window difference).
//
// Not sonnet-4-6: that name reaches getSonnet1mExpTreatmentEnabled, which
// reads the user's global config, so its window differs per machine.
// sonnet-4-5's raw max output is 32000 — above MAX_OUTPUT_TOKENS_FOR_SUMMARY,
// which the reserve test below depends on.
const MODEL = 'claude-sonnet-4-5'
const ENV_VAR = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'

const CONFIG_DIR_VAR = 'CLAUDE_CONFIG_DIR'
let previousConfigDir: string | undefined
let tempConfigDir: string

/**
 * getContextWindowForModel consults the model-capability cache — a real file
 * under the developer's config dir, refreshed from `/v1/models` and therefore
 * account-specific. That branch returns before the 1M-beta branch, so once the
 * account's cache started reporting `max_input_tokens: 1000000` for current
 * models, both tests below went quietly vacuous: MODEL was pinned at 1M, which
 * swamped the reserve comparison and left the beta with nothing to raise.
 *
 * Point the config dir at an empty temp dir so the lookup misses and models
 * fall back to MODEL_CONTEXT_WINDOW_DEFAULT — the 200k baseline these two
 * tests are written against. `getClaudeConfigHomeDir` and `loadCache` are both
 * memoized on this variable precisely so tests can do this.
 */
beforeAll(() => {
  previousConfigDir = process.env[CONFIG_DIR_VAR]
  tempConfigDir = mkdtempSync(join(tmpdir(), 'effective-window-'))
  process.env[CONFIG_DIR_VAR] = tempConfigDir
})

afterAll(() => {
  if (previousConfigDir === undefined) {
    delete process.env[CONFIG_DIR_VAR]
  } else {
    process.env[CONFIG_DIR_VAR] = previousConfigDir
  }
  rmSync(tempConfigDir, { recursive: true, force: true })
})

function windowWith(pin: string | undefined): number {
  if (pin === undefined) {
    delete process.env[ENV_VAR]
  } else {
    process.env[ENV_VAR] = pin
  }
  return getEffectiveContextWindowSize(MODEL)
}

// process.env is process-global and bun test shares one process across files.
afterEach(() => {
  delete process.env[ENV_VAR]
})

describe('getEffectiveContextWindowSize', () => {
  test(`${ENV_VAR} can only lower the window, never raise it`, () => {
    const baseline = windowWith(undefined)

    expect(windowWith('50000')).toBeLessThan(baseline)
    // The half that matters: Math.min means an absurd pin is inert. Under
    // Math.min -> Math.max this returns pin - reserve instead.
    expect(windowWith('99999999')).toBe(baseline)
  })

  test(`unparseable or non-positive ${ENV_VAR} is ignored`, () => {
    const baseline = windowWith(undefined)

    for (const pin of ['', 'abc', '0', '-5']) {
      expect(windowWith(pin)).toBe(baseline)
    }
  })

  test('reserves exactly the summary allowance out of the pinned window', () => {
    // Precondition, not decoration. The reserve is min(rawMaxOutput,
    // MAX_OUTPUT_TOKENS_FOR_SUMMARY), so the exact assertion below only
    // describes the clamp while the raw side is the larger one (64000 vs
    // 20000 for this model). Two things invert that: a leaked
    // CLAUDE_CODE_MAX_OUTPUT_TOKENS (api/openai/__tests__/thinking.test.ts
    // sets 333, restored in a finally) or growthbook tengu_otk_slot_v1
    // resolving true, which pins raw output to CAPPED_DEFAULT_MAX_TOKENS =
    // 8000. Asserting it makes either a named failure rather than a
    // confusing arithmetic mismatch.
    expect(getMaxOutputTokensForModel(MODEL)).toBeGreaterThan(
      MAX_OUTPUT_TOKENS_FOR_SUMMARY,
    )

    // Exact, not <=: a loose bound stays green when the clamp is deleted and
    // the reserve silently becomes the model's full 64000 output allowance.
    expect(50_000 - windowWith('50000')).toBe(MAX_OUTPUT_TOKENS_FOR_SUMMARY)
  })

  // Nothing else asserts the function's only argument is used at all —
  // hardcoding the reserve to the constant passes every test above. Both
  // models carry a 200000 window, so the whole gap here is the reserve
  // (4096 vs 20000).
  test('the model argument reaches the reserve calculation', () => {
    expect(
      getEffectiveContextWindowSize('claude-3-opus-20240229'),
    ).toBeGreaterThan(getEffectiveContextWindowSize(MODEL))
  })

  // Dropping the getSdkBetas() argument reads like a safe "compaction doesn't
  // care about betas" cleanup and silently collapses every 1M-context user to
  // a 200k window: no error, just autocompact firing ~5x too early. Measured
  // 180000 -> 980000.
  test('threads the session betas into the window lookup', () => {
    const before = getSdkBetas()
    try {
      const withoutBetas = getEffectiveContextWindowSize(MODEL)
      setSdkBetas([CONTEXT_1M_BETA_HEADER])
      expect(getEffectiveContextWindowSize(MODEL)).toBeGreaterThan(withoutBetas)
    } finally {
      setSdkBetas(before)
    }
  })
})

describe('parseAutoCompactWindow', () => {
  test('parses auto, exact tokens, and thousand-token shorthand', () => {
    // Given: every supported input spelling.
    const inputs = ['auto', '500k', '200000', '200', '100', '1000']

    // When: the values cross the parser boundary.
    const parsed = inputs.map(parseAutoCompactWindow)

    // Then: shorthand and exact values resolve to token counts.
    expect(parsed).toEqual([
      'auto',
      500_000,
      200_000,
      200_000,
      100_000,
      1_000_000,
    ])
  })

  test('rejects partial, out-of-range, and unsupported spellings', () => {
    // Given: values outside the strict 100k..1M contract.
    const inputs = ['500kfoo', '99k', '1000001', '1m', '-200', '200.5k']

    // When: the values cross the parser boundary.
    const parsed = inputs.map(parseAutoCompactWindow)

    // Then: none are partially accepted.
    expect(parsed).toEqual(inputs.map(() => undefined))
  })
})

describe('resolveAutoCompactWindow', () => {
  const MAX_CONTEXT_ENV = 'CLAUDE_CODE_MAX_CONTEXT_TOKENS'
  let previousUserType: string | undefined
  let previousMaxContext: string | undefined
  let previousSetting: string | undefined
  let previousBetas: string[] | undefined

  beforeEach(() => {
    previousUserType = process.env.USER_TYPE
    previousMaxContext = process.env[MAX_CONTEXT_ENV]
    previousSetting = getGlobalConfig().autoCompactWindow
    previousBetas = getSdkBetas()
    delete process.env[ENV_VAR]
    delete process.env[MAX_CONTEXT_ENV]
    saveGlobalConfig(current => ({
      ...current,
      autoCompactWindow: undefined,
    }))
    setSdkBetas([CONTEXT_1M_BETA_HEADER])
  })

  afterEach(() => {
    if (previousUserType === undefined) delete process.env.USER_TYPE
    else process.env.USER_TYPE = previousUserType
    if (previousMaxContext === undefined) delete process.env[MAX_CONTEXT_ENV]
    else process.env[MAX_CONTEXT_ENV] = previousMaxContext
    saveGlobalConfig(current => ({
      ...current,
      autoCompactWindow: previousSetting,
    }))
    setSdkBetas(previousBetas)
  })

  test('uses env before session, settings, and model defaults', () => {
    // Given: distinct valid values at every configurable layer.
    saveGlobalConfig(current => ({
      ...current,
      autoCompactWindow: '500k',
    }))
    process.env[ENV_VAR] = '300k'

    // When: the effective window is resolved with a session override.
    const resolution = resolveAutoCompactWindow(MODEL, '400k')

    // Then: env wins and its source remains observable.
    expect(resolution).toEqual({
      configured: '300k',
      window: 300_000,
      source: 'env',
      capped: false,
    })
  })

  test('falls through invalid higher-priority values', () => {
    // Given: an invalid env value and a valid session override.
    process.env[ENV_VAR] = '500kfoo'

    // When: the effective window is resolved.
    const resolution = resolveAutoCompactWindow(MODEL, '400k')

    // Then: the valid session value is used.
    expect(resolution.source).toBe('session')
    expect(resolution.window).toBe(400_000)
  })

  test('uses the session override before the saved setting', () => {
    // Given: distinct session and saved settings with no env override.
    saveGlobalConfig(current => ({
      ...current,
      autoCompactWindow: '500k',
    }))

    // When: the effective window is resolved with a session override.
    const resolution = resolveAutoCompactWindow(MODEL, '400k')

    // Then: the session layer wins.
    expect(resolution.source).toBe('session')
    expect(resolution.window).toBe(400_000)
  })

  test('uses the saved setting before the model default', () => {
    // Given: a saved setting with no env or session override.
    saveGlobalConfig(current => ({
      ...current,
      autoCompactWindow: '500k',
    }))

    // When: the effective window is resolved.
    const resolution = resolveAutoCompactWindow(MODEL)

    // Then: the saved setting wins.
    expect(resolution.source).toBe('settings')
    expect(resolution.window).toBe(500_000)
  })

  test('caps configured windows at the model safety limit', () => {
    // Given: a lower hard context cap than the configured auto-compact window.
    process.env.USER_TYPE = 'ant'
    process.env[MAX_CONTEXT_ENV] = '350000'
    process.env[ENV_VAR] = '500k'

    // When: the effective window is resolved.
    const resolution = resolveAutoCompactWindow(MODEL)

    // Then: the hard cap wins and the cap is reported.
    expect(resolution).toEqual({
      configured: '500k',
      window: 350_000,
      source: 'env',
      capped: true,
    })
  })

  test('uses the model default when no configured value is valid', () => {
    // Given: no valid env, session, or saved setting.
    process.env[ENV_VAR] = 'invalid'

    // When: the effective window is resolved.
    const resolution = resolveAutoCompactWindow(MODEL)

    // Then: the model default is explicit.
    expect(resolution).toEqual({
      configured: 'auto',
      window: 1_000_000,
      source: 'model',
      capped: false,
    })
  })

  test('uses the safe model fallback for an unknown model', () => {
    // Given: an unknown model and no configured value.

    // When: the effective window is resolved.
    const resolution = resolveAutoCompactWindow('unknown-model')

    // Then: the model resolver's safe fallback is retained.
    expect(resolution).toEqual({
      configured: 'auto',
      window: 200_000,
      source: 'model',
      capped: false,
    })
  })
})
