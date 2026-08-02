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
import { afterEach, describe, expect, test } from 'bun:test'
import { getSdkBetas, setSdkBetas } from '../../../bootstrap/state'
import { CONTEXT_1M_BETA_HEADER } from '../../../constants/betas'
import { getMaxOutputTokensForModel } from '../../api/claude'
import {
  getEffectiveContextWindowSize,
  MAX_OUTPUT_TOKENS_FOR_SUMMARY,
} from '../effectiveWindow'

// Not sonnet-4-6: that name reaches getSonnet1mExpTreatmentEnabled, which
// reads the user's global config, so its window differs per machine. opus-4-7
// skips that branch and its raw max output is 64000 — comfortably above
// MAX_OUTPUT_TOKENS_FOR_SUMMARY, which the reserve test below depends on.
const MODEL = 'claude-opus-4-7'
const ENV_VAR = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'

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
