/**
 * Decide what the /model picker stores when the user confirms the
 * "Default (recommended)" row with a given 1M-context intent.
 *
 * Default normally stores `null` ("no preference") so the session keeps
 * following whatever the default model becomes later. But 1M context is only
 * expressible as a `[1m]` suffix on a model string, so an intent that differs
 * from the default's own state has to pin a concrete setting instead.
 *
 * Returns `null` while the intent still matches the baseline, which keeps the
 * untouched case following future default changes. Otherwise pins
 * `defaultSetting` itself rather than its fully-resolved model name, so an
 * alias tier (e.g. 'sonnet') still tracks version bumps inside that tier.
 *
 * A non-null return therefore also answers "will confirming pin the model?".
 *
 * `defaultHas1M` is passed in rather than derived to keep the settings chain out
 * of this module: `has1mContext` pulls it in, and several test files replace that
 * chain wholesale via process-global `mock.module` (see CLAUDE.md on cross-file
 * mock pollution). `aliases.js` below is safe by the same rule — it is a leaf
 * with no imports of its own.
 */
import { strip1mContextSuffix } from './aliases.js'

export function resolveDefaultOptionModel(
  defaultSetting: string,
  wants1M: boolean,
  defaultHas1M: boolean,
): string | null {
  if (wants1M === defaultHas1M) {
    return null
  }
  const base = strip1mContextSuffix(defaultSetting)
  return wants1M ? `${base}[1m]` : base
}
