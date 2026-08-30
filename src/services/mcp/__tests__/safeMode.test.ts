import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getManagedFilePath } from '../../../utils/settings/managedPath.js'
import {
  clearClaudeAIMcpConfigsCache,
  fetchClaudeAIMcpConfigsIfEligible,
} from '../claudeai.js'
import {
  doesEnterpriseMcpConfigExist,
  filterMcpServersForSafeMode,
  getClaudeCodeMcpConfigs,
  getMcpConfigByName,
} from '../config.js'
import type { ScopedMcpServerConfig } from '../types.js'

const originalSafeMode = process.env.CLAUDE_CODE_SAFE_MODE
const originalUserType = process.env.USER_TYPE
const originalManagedSettingsPath =
  process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH
let managedSettingsPath: string | undefined

afterEach(async () => {
  clearClaudeAIMcpConfigsCache()
  doesEnterpriseMcpConfigExist.cache.clear?.()
  getManagedFilePath.cache.clear?.()
  if (managedSettingsPath) {
    await rm(managedSettingsPath, { recursive: true, force: true })
    managedSettingsPath = undefined
  }
  if (originalSafeMode === undefined) {
    delete process.env.CLAUDE_CODE_SAFE_MODE
  } else {
    process.env.CLAUDE_CODE_SAFE_MODE = originalSafeMode
  }
  if (originalUserType === undefined) {
    delete process.env.USER_TYPE
  } else {
    process.env.USER_TYPE = originalUserType
  }
  if (originalManagedSettingsPath === undefined) {
    delete process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH
  } else {
    process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH = originalManagedSettingsPath
  }
})

const configs: Record<string, ScopedMcpServerConfig> = {
  injected: { type: 'sdk', name: 'injected', scope: 'dynamic' },
  local: { type: 'stdio', command: 'example', args: [], scope: 'dynamic' },
  remote: { type: 'http', url: 'https://example.com/mcp', scope: 'dynamic' },
}

describe('filterMcpServersForSafeMode', () => {
  test('keeps only SDK-injected servers in safe mode', () => {
    process.env.CLAUDE_CODE_SAFE_MODE = '1'

    expect(filterMcpServersForSafeMode(configs)).toEqual({
      injected: configs.injected,
    })
  })

  test('keeps every server outside safe mode', () => {
    delete process.env.CLAUDE_CODE_SAFE_MODE

    expect(filterMcpServersForSafeMode(configs)).toBe(configs)
  })

  test('does not fetch claude.ai servers in safe mode', async () => {
    process.env.CLAUDE_CODE_SAFE_MODE = '1'
    clearClaudeAIMcpConfigsCache()

    expect(await fetchClaudeAIMcpConfigsIfEligible()).toEqual({})
  })
})

async function configureEnterpriseServers(): Promise<void> {
  managedSettingsPath = await mkdtemp(join(tmpdir(), 'mcp-safe-mode-'))
  process.env.USER_TYPE = 'ant'
  process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH = managedSettingsPath
  process.env.CLAUDE_CODE_SAFE_MODE = '1'
  getManagedFilePath.cache.clear?.()
  doesEnterpriseMcpConfigExist.cache.clear?.()
  await writeFile(
    join(managedSettingsPath, 'managed-mcp.json'),
    JSON.stringify({
      mcpServers: {
        enterpriseSdk: { type: 'sdk', name: 'enterprise-sdk' },
        enterpriseLocal: { type: 'stdio', command: 'example', args: [] },
        enterpriseRemote: { type: 'http', url: 'https://example.com/mcp' },
      },
    }),
  )
}

describe('enterprise MCP in safe mode', () => {
  test('keeps only SDK servers in enterprise-exclusive config', async () => {
    await configureEnterpriseServers()

    const result = await getClaudeCodeMcpConfigs()

    expect(result).toEqual({
      servers: {
        enterpriseSdk: {
          type: 'sdk',
          name: 'enterprise-sdk',
          scope: 'enterprise',
        },
      },
      errors: [],
    })
  })

  test('does not find enterprise stdio or HTTP servers by name', async () => {
    await configureEnterpriseServers()

    expect(getMcpConfigByName('enterpriseSdk')).toEqual({
      type: 'sdk',
      name: 'enterprise-sdk',
      scope: 'enterprise',
    })
    expect(getMcpConfigByName('enterpriseLocal')).toBeNull()
    expect(getMcpConfigByName('enterpriseRemote')).toBeNull()
  })

  test('keeps every enterprise server outside safe mode', async () => {
    await configureEnterpriseServers()
    delete process.env.CLAUDE_CODE_SAFE_MODE

    const result = await getClaudeCodeMcpConfigs()

    expect(Object.keys(result.servers).sort()).toEqual([
      'enterpriseLocal',
      'enterpriseRemote',
      'enterpriseSdk',
    ])
    expect(getMcpConfigByName('enterpriseLocal')?.type).toBe('stdio')
    expect(getMcpConfigByName('enterpriseRemote')?.type).toBe('http')
  })
})
