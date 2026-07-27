/**
 * Model-id string handling shared by the provider mappers.
 */

/**
 * Removes the `[1m]` context-window opt-in, yielding the bare wire model id.
 *
 * `[1m]` is a client-side marker — it makes auto-compact budget 1M — and is
 * never part of a model id any provider accepts, so every mapper has to strip
 * it before handing the id over. Each of the three did so inline with a
 * slightly different regex (anchored vs not, case-sensitive vs not, trimming
 * vs not), which meant the same configured value could normalize differently
 * depending on which provider was active.
 *
 * Anchored and case-insensitive, with surrounding whitespace trimmed: env
 * overrides and preset files are hand-edited, so a trailing space is ordinary
 * and must not reach the wire.
 *
 * Trim runs *first*. Trimming afterwards — as every inline copy did — leaves a
 * trailing space blocking the `$` anchor, so the marker never matches and
 * `kimi-k3[1m] ` reaches the provider with the marker still attached.
 *
 * Deliberately duplicated from `src/utils/model/aliases.ts` rather than
 * imported — `packages/` must not import the main app (see the dependency
 * ratchet in CLAUDE.md), and a one-line string helper is not worth a new shared
 * package. The two copies are kept identical; the tests beside this file pin the
 * behavior on this side.
 */
export function strip1mContextSuffix(model: string): string {
  return model.trim().replace(/\[1m\]$/i, '')
}
