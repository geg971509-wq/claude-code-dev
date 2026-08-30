import { describe, expect, test } from 'bun:test'
import { resolve } from 'path'

const PROJECT_ROOT = resolve(import.meta.dir, '..', '..', '..')

async function runLogoutProbe(options: {
  providerFails: boolean
  deleteSucceeds: boolean
  configSaveSucceeds?: boolean
  legacyKeyDeleteFails?: boolean
  expectFailure?: boolean
}): Promise<void> {
  const proc = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
        import { mock } from 'bun:test'

        const state = {
          deleteCalls: 0,
          config: { primaryApiKey: 'secret', oauthAccount: { id: 'account' } },
        }

        mock.module('src/bridge/trustedDevice.js', () => ({
          clearTrustedDeviceTokenCache: () => {},
        }))
        mock.module('src/services/analytics/growthbook.js', () => ({
          refreshGrowthBookAfterAuthChange: () => {},
        }))
        mock.module('src/services/api/grove.js', () => ({
          getGroveNoticeConfig: { cache: { clear: () => {} } },
          getGroveSettings: { cache: { clear: () => {} } },
        }))
        mock.module('src/services/policyLimits/index.js', () => ({
          clearPolicyLimitsCache: async () => {},
        }))
        mock.module('src/services/remoteManagedSettings/index.js', () => ({
          clearRemoteManagedSettingsCache: async () => {},
        }))
        mock.module('src/services/api/openai/chatgptAuth.js', () => ({
          removeChatGPTAuth: async () => {
            if (${options.providerFails}) throw new Error('provider cleanup failed')
          },
        }))
        mock.module('src/services/api/openai/kimiAuth.js', () => ({
          removeKimiAuth: async () => {},
        }))
        mock.module('src/services/api/codex/client.js', () => ({
          clearCodexClientCache: () => {},
        }))
        mock.module('src/utils/auth.js', () => ({
          getClaudeAIOAuthTokens: { cache: { clear: () => {} } },
          removeApiKey: async options => {
            if (options?.strict && ${options.legacyKeyDeleteFails === true}) {
              throw new Error('legacy keychain delete failed')
            }
          },
        }))
        mock.module('src/utils/betas.js', () => ({ clearBetasCaches: () => {} }))
        mock.module('src/utils/config.js', () => ({
          saveGlobalConfig: updater => {
            if (${options.configSaveSucceeds !== false}) {
              state.config = updater(state.config)
              return true
            }
            return false
          },
        }))
        mock.module('src/utils/gracefulShutdown.js', () => ({
          gracefulShutdownSync: () => {},
        }))
        mock.module('src/utils/secureStorage/authLock.js', () => ({
          withAuthMutationLock: action => action(),
        }))
        mock.module('src/utils/secureStorage/index.js', () => ({
          getSecureStorage: () => ({
            delete: () => {
              state.deleteCalls += 1
              return ${options.deleteSucceeds}
            },
          }),
        }))
        mock.module('src/utils/settings/settings.js', () => ({
          getSettingsForSource: () => ({}),
          updateSettingsForSource: () => ({}),
        }))
        mock.module('src/utils/toolSchemaCache.js', () => ({
          clearToolSchemaCache: () => {},
        }))
        mock.module('src/utils/user.js', () => ({ resetUserCache: () => {} }))
        mock.module('src/utils/telemetry/instrumentation.js', () => ({
          flushTelemetry: async () => {},
        }))

        const { performLogout } = await import('src/commands/logout/logout.js')
        let failed = false
        try {
          await performLogout({ clearOnboarding: false })
        } catch {
          failed = true
        }
        if (failed !== ${options.expectFailure !== false}) {
          throw new Error(failed ? 'logout unexpectedly failed' : 'logout reported success')
        }
        if (state.deleteCalls !== 1) throw new Error('authoritative delete did not run once')
        if (${options.configSaveSucceeds !== false} && state.config.primaryApiKey !== undefined) {
          throw new Error('config API key was not cleared')
        }
      `,
    ],
    { cwd: PROJECT_ROOT, stdout: 'pipe', stderr: 'pipe' },
  )
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect(code, `${stdout}\n${stderr}`).toBe(0)
}

describe('performLogout', () => {
  test('completes after every authoritative cleanup succeeds', () =>
    runLogoutProbe({
      providerFails: false,
      deleteSucceeds: true,
      expectFailure: false,
    }))

  test('runs the authoritative credential wipe after provider cleanup fails', () =>
    runLogoutProbe({ providerFails: true, deleteSucceeds: true }))

  test('fails instead of reporting success when legacy keychain deletion fails', () =>
    runLogoutProbe({
      providerFails: false,
      deleteSucceeds: true,
      legacyKeyDeleteFails: true,
    }))

  test('fails instead of reporting success when secure deletion fails', () =>
    runLogoutProbe({ providerFails: false, deleteSucceeds: false }))

  test('fails instead of reporting success when config persistence is refused', () =>
    runLogoutProbe({
      providerFails: false,
      deleteSucceeds: true,
      configSaveSucceeds: false,
    }))
})
