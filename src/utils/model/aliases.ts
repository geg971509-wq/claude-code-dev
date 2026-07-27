export const MODEL_ALIASES = [
  'sonnet',
  'opus',
  'haiku',
  'best',
  'sonnet[1m]',
  'opus[1m]',
  'opusplan',
] as const
export type ModelAlias = (typeof MODEL_ALIASES)[number]

export function isModelAlias(modelInput: string): modelInput is ModelAlias {
  return MODEL_ALIASES.includes(modelInput as ModelAlias)
}

/**
 * Bare model family aliases that act as wildcards in the availableModels allowlist.
 * When "opus" is in the allowlist, ANY opus model is allowed (opus 4.5, 4.6, etc.).
 * When a specific model ID is in the allowlist, only that exact version is allowed.
 */
export const MODEL_FAMILY_ALIASES = ['sonnet', 'opus', 'haiku'] as const

export function isModelFamilyAlias(model: string): boolean {
  return (MODEL_FAMILY_ALIASES as readonly string[]).includes(model)
}

/**
 * Removes the `[1m]` context-window opt-in, yielding the bare model id.
 *
 * `[1m]` is a client-side marker (it makes auto-compact budget 1M) and never
 * part of a wire model id, so every path that talks to a provider — or compares
 * two model ids — has to strip it first. That was open-coded in a dozen places
 * with four different regexes: some anchored, some not, some case-insensitive,
 * one trimming. Unanchored variants also matched a mid-string `[1m]`, so the
 * same id could normalize differently depending on which path reached it.
 *
 * Anchored and case-insensitive, with surrounding whitespace trimmed — env
 * overrides and settings files are hand-edited, so a trailing space is ordinary
 * and must not survive into a request. `has1mContext` in utils/context.ts is the
 * inverse predicate; it stays there because it also honors the HIPAA kill switch,
 * which is policy rather than string handling.
 *
 * Trim runs *first*. Trimming afterwards — as every inline copy did — leaves a
 * trailing space blocking the `$` anchor, so the marker never matches and
 * `opus[1m] ` keeps its marker while looking like it was stripped.
 *
 * Lives in this import-free module so both provider mappers and UI can use it
 * without pulling in config, auth, or bootstrap state.
 */
export function strip1mContextSuffix(model: string): string {
  return model.trim().replace(/\[1m\]$/i, '')
}
