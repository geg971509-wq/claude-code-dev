/**
 * Shared mock for `src/utils/auth.js`.
 *
 * `mock.module` is process-global and last-write-wins, and a factory REPLACES
 * the whole module — every export the factory omits becomes undefined for every
 * other test file loaded afterwards in the same process. A partial mock of a
 * 57-export module is therefore a pollution source, not a local decision.
 *
 * So there are two entry points, and the choice between them is not stylistic:
 *
 *   // Whole module, default shape:
 *   mock.module('src/utils/auth.js', authMock)
 *
 *   // Only some exports differ, the rest stay real:
 *   mock.module('src/utils/auth.js', await authMockWith({
 *     getClaudeAIOAuthTokens: () => ({ accessToken: 'test-token' }),
 *   }))
 *
 * Prefer authMockWith. It spreads the real module first, so an export this file
 * has never heard of still resolves, and adding an export to auth.ts does not
 * silently blank it out for unrelated suites.
 *
 * Use bare authMock only where importing the real auth.ts is itself the problem
 * (import cycles, or module-level side effects the suite has already stubbed).
 */

/** Default shape. Only the exports listed here exist under this mock. */
export const authMock = () => ({
  // Mirrors the production contract: src/utils/auth.ts returns
  // Promise<boolean> ("did the access token change") and a token object that
  // carries scopes, subscriptionType, expiresAt, etc. Tests that branch on
  // these values must see the full shape so they can not silently drift away
  // from production.
  checkAndRefreshOAuthTokenIfNeeded: async () => false,
  getClaudeAIOAuthTokens: () => ({
    accessToken: 'token',
    refreshToken: null,
    expiresAt: null,
    scopes: ['user:inference'],
    subscriptionType: null,
    rateLimitTier: null,
  }),
  isClaudeAISubscriber: () => true,
  isProSubscriber: () => false,
  isMaxSubscriber: () => false,
  isTeamSubscriber: () => false,
})

/**
 * Real module with `overrides` applied on top.
 *
 * Async because it imports the real auth.ts. Await it at module scope, before
 * the `mock.module` call, the same way the suites that already spread
 * `realAuth` by hand do:
 *
 *   mock.module('src/utils/auth.js', await authMockWith({ ... }))
 */
export async function authMockWith(
  overrides: Record<string, unknown>,
): Promise<() => Record<string, unknown>> {
  const real = (await import('src/utils/auth.js')) as Record<string, unknown>
  const merged = { ...real, ...overrides }
  return () => merged
}
