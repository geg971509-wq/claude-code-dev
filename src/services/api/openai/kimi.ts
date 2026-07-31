/**
 * Kimi (Moonshot AI) quirks for the OpenAI-compatible provider path.
 */

/**
 * Moonshot Kimi models on the OpenAI-compatible endpoint.
 *
 * Matched on the resolved model id only — this path never sees a base URL or
 * provider id, so the id is the one honest signal available.
 *
 * Anchored to the start of the id or a `vendor/` prefix (`kimi-k3`,
 * `moonshotai/kimi-k2`) rather than matching `kimi` anywhere, because the two
 * quirks gated on this are subtractive: a false positive silently strips
 * `temperature` from a model that wanted it, with nothing in the response to
 * indicate why. Router and gateway deployments rename models freely, and
 * `my-kimi-route` or `kimi-proxy-fallback` naming a non-Moonshot upstream is
 * ordinary. A hyphen is required after `kimi` so the match is a family prefix
 * and not a word that merely starts with it.
 *
 * The reverse miss — a Moonshot model not named `kimi-*` — degrades to sending
 * `temperature`, which surfaces as a loud 400 rather than a silent wrong answer.
 * That asymmetry is why this errs toward matching less.
 */
const KIMI_FAMILY_RE = /(?:^|\/)kimi-/i

export function isKimiModel(model: string): boolean {
  return KIMI_FAMILY_RE.test(model)
}

/** Effort levels Moonshot accepts. Anything else is a hard 400. */
export type KimiReasoningEffort = 'low' | 'high' | 'max'

/**
 * Clamp Claude Code's six effort levels onto the three Moonshot accepts,
 * mirroring the aliasing the Kimi gateway documents.
 *
 * `max` is included for completeness — streamAttempt.ts converts `max` to
 * `xhigh` before this module sees it, so `xhigh` is what restores that intent.
 */
export function toKimiReasoningEffort(
  effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
): KimiReasoningEffort {
  switch (effort) {
    case 'none':
    case 'minimal':
    case 'low':
      return 'low'
    case 'medium':
    case 'high':
      return 'high'
    case 'xhigh':
      return 'max'
  }
}
