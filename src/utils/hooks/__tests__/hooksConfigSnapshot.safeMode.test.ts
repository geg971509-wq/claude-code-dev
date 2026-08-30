import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as settingsModule from '../../settings/settings.js'
import { settingsMockWith } from '../../../../tests/mocks/settings.js'

let policySettings: Record<string, unknown> = {}
let mergedSettings: Record<string, unknown> = {}

mock.module(
  'src/utils/settings/settings.js',
  await settingsMockWith({
    getSettingsForSource: (source: string) =>
      source === 'policySettings' ? policySettings : undefined,
    getSettings_DEPRECATED: () => mergedSettings,
  }),
)

const hooksConfigModulePath = '../hooksConfigSnapshot.js?safeModeTest'
const hooksConfig = (await import(
  hooksConfigModulePath
)) as typeof import('../hooksConfigSnapshot.js')
const originalSafeMode = process.env.CLAUDE_CODE_SAFE_MODE

beforeEach(() => {
  policySettings = {}
  mergedSettings = {}
  delete process.env.CLAUDE_CODE_SAFE_MODE
  hooksConfig.resetHooksConfigSnapshot()
})

afterAll(() => {
  if (originalSafeMode === undefined) delete process.env.CLAUDE_CODE_SAFE_MODE
  else process.env.CLAUDE_CODE_SAFE_MODE = originalSafeMode
  mock.restore()
  mock.module('src/utils/settings/settings.js', () => settingsModule)
})

describe('safe mode hook policy', () => {
  test('keeps managed hooks and excludes merged user hooks', () => {
    const managedHooks = { SessionStart: [] }
    policySettings = { hooks: managedHooks }
    mergedSettings = { hooks: { PreToolUse: [] } }
    process.env.CLAUDE_CODE_SAFE_MODE = '1'

    expect(hooksConfig.shouldAllowManagedHooksOnly()).toBe(true)
    expect(hooksConfig.getHooksConfigFromSnapshot()).toEqual(managedHooks)
  })
})
