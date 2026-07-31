/**
 * Shared mock for `src/utils/settings/settings.js`.
 *
 * Same hazard as tests/mocks/auth.ts: `mock.module` replaces the whole module
 * process-wide, so a factory returning `{ getSettings: () => ({}) }` blanks the
 * other ~30 exports for every file loaded after it. settings.js is imported
 * transitively by ~57 modules, so the blast radius is larger than auth's — a
 * partial factory here is how a suite that never mentions settings ends up
 * failing with "Export named 'getInitialSettings' not found".
 *
 *   mock.module('src/utils/settings/settings.js', await settingsMockWith({
 *     getSettings: () => ({}),
 *   }))
 *
 * Real settings.ts is safe to import: its module scope is functions plus one
 * `let isLoadingSettings = false`, no disk read at load time. Overriding the
 * getters is still what suites want, since the real ones read the user's actual
 * settings files.
 */
export async function settingsMockWith(
  overrides: Record<string, unknown>,
): Promise<() => Record<string, unknown>> {
  const real = (await import('src/utils/settings/settings.js')) as Record<
    string,
    unknown
  >
  const merged = { ...real, ...overrides }
  return () => merged
}
