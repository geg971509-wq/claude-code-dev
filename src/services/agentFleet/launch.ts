import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { selectEngine } from '../../cli/bg/engines/index.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import type { EffortLevel } from '../../utils/effort.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import type { SettingSource } from '../../utils/settings/constants.js'

export type FleetLaunchSpec = {
  addDirs?: string[]
  agent?: string
  dangerouslySkipPermissions?: boolean
  effort?: EffortLevel
  mcpConfigs?: string[]
  model?: string
  permissionMode?: PermissionMode
  pluginDirs?: string[]
  settingSources?: SettingSource[]
  settings?: string
  strictMcpConfig?: boolean
}

export type FleetLaunchResult = {
  cwd: string
  engine: 'tmux' | 'detached' | 'pty'
  logPath: string
  pid: number
  sessionName: string
}

function settingSourceArg(source: SettingSource): string {
  switch (source) {
    case 'userSettings':
      return 'user'
    case 'projectSettings':
      return 'project'
    case 'localSettings':
      return 'local'
    case 'flagSettings':
    case 'policySettings':
      throw new Error(`${source} cannot be selected with --setting-sources`)
  }
}

export function buildFleetLaunchArgs(spec: FleetLaunchSpec): string[] {
  const args: string[] = []
  if (spec.addDirs?.length) args.push('--add-dir', ...spec.addDirs)
  if (spec.agent) args.push('--agent', spec.agent)
  if (spec.model) args.push('--model', spec.model)
  if (spec.effort) args.push('--effort', spec.effort)
  if (spec.permissionMode) args.push('--permission-mode', spec.permissionMode)
  if (spec.dangerouslySkipPermissions)
    args.push('--dangerously-skip-permissions')
  for (const directory of spec.pluginDirs ?? [])
    args.push('--plugin-dir', directory)
  if (spec.mcpConfigs?.length) args.push('--mcp-config', ...spec.mcpConfigs)
  if (spec.strictMcpConfig) args.push('--strict-mcp-config')
  if (spec.settings) args.push('--settings', spec.settings)
  if (spec.settingSources?.length)
    args.push(
      '--setting-sources',
      spec.settingSources.map(settingSourceArg).join(','),
    )
  return args
}

export async function launchFleetAgent(
  spec: FleetLaunchSpec,
  cwd: string,
): Promise<FleetLaunchResult> {
  const canonicalCwd = await realpath(cwd)
  if (!(await stat(canonicalCwd)).isDirectory())
    throw new Error(`Agent working directory is not a directory: ${cwd}`)

  const engine = await selectEngine()
  if (!engine.supportsInteractiveInput) {
    throw new Error(
      'Launching an interactive Fleet agent requires tmux or the macOS PTY engine.',
    )
  }

  const sessionName = `claude-agent-${randomUUID().slice(0, 8)}`
  const logPath = join(
    getClaudeConfigHomeDir(),
    'sessions',
    'logs',
    `${sessionName}.log`,
  )
  const result = await engine.start({
    sessionName,
    args: buildFleetLaunchArgs(spec),
    env: { ...process.env },
    logPath,
    cwd: canonicalCwd,
  })
  return {
    cwd: canonicalCwd,
    engine: result.engineUsed,
    logPath: result.logPath,
    pid: result.pid,
    sessionName: result.sessionName,
  }
}
