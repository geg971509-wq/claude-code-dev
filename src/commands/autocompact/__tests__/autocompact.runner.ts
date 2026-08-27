import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { LocalJSXCommandContext } from '../../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../../utils/config.js'
import { call } from '../autocompact.js'

const ENV_VAR = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'
const MAX_CONTEXT_ENV = 'CLAUDE_CODE_MAX_CONTEXT_TOKENS'
const MODEL = 'claude-sonnet-4-5'
let previousSetting: string | undefined
let previousMaxContext: string | undefined

function context(): LocalJSXCommandContext {
  return {
    options: { mainLoopModel: MODEL },
  } as unknown as LocalJSXCommandContext
}

beforeEach(() => {
  previousSetting = getGlobalConfig().autoCompactWindow
  previousMaxContext = process.env[MAX_CONTEXT_ENV]
  delete process.env[ENV_VAR]
  delete process.env[MAX_CONTEXT_ENV]
  saveGlobalConfig(current => ({
    ...current,
    autoCompactWindow: undefined,
  }))
})

afterEach(() => {
  delete process.env[ENV_VAR]
  if (previousMaxContext === undefined) delete process.env[MAX_CONTEXT_ENV]
  else process.env[MAX_CONTEXT_ENV] = previousMaxContext
  saveGlobalConfig(current => ({
    ...current,
    autoCompactWindow: previousSetting,
  }))
})

describe('/autocompact', () => {
  test('persists a valid user window', async () => {
    // Given: no existing saved window.
    expect(getGlobalConfig().autoCompactWindow).toBeUndefined()

    // When: the user sets a valid window.
    await call('500k', context())

    // Then: the user setting is persisted.
    expect(getGlobalConfig().autoCompactWindow).toBe('500k')
  })

  test('shows configured value, effective window, source, and cap status', async () => {
    // Given: a configured window larger than the model limit.
    saveGlobalConfig(current => ({
      ...current,
      autoCompactWindow: '500k',
    }))

    // When: the command is queried without arguments.
    const result = await call('', context())

    // Then: every resolution field is visible to the user.
    expect(result.type).toBe('text')
    if (result.type !== 'text') throw new Error('Expected text result')
    expect(result.value).toContain('500k')
    expect(result.value).toContain('200,000 tokens')
    expect(result.value).toContain('settings')
    expect(result.value).toContain('capped')
  })

  test('warns immediately when env prevents a saved setting from taking effect', async () => {
    // Given: an active environment override.
    process.env[ENV_VAR] = '200k'

    // When: the user persists a different setting.
    const result = await call('500k', context())

    // Then: persistence succeeds but the precedence conflict is explicit.
    expect(getGlobalConfig().autoCompactWindow).toBe('500k')
    expect(result.type).toBe('text')
    if (result.type !== 'text') throw new Error('Expected text result')
    expect(result.value.toLowerCase()).toContain('environment override')
  })

  test('rejects invalid input without changing the saved setting', async () => {
    // Given: an existing saved setting.
    saveGlobalConfig(current => ({
      ...current,
      autoCompactWindow: '300k',
    }))

    // When/Then: invalid input is rejected and persistence is unchanged.
    await expect(call('500kfoo', context())).rejects.toThrow('100k to 1M')
    expect(getGlobalConfig().autoCompactWindow).toBe('300k')
  })
})
