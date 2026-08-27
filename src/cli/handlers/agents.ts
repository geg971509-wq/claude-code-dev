/**
 * Agents subcommand handler — prints the list of configured agents.
 * Dynamically imported only when `claude agents` runs.
 */

import type { Command } from '@commander-js/extra-typings'
import { getCwd } from '../../utils/cwd.js'
import type { AgentFleetFilter } from '../../services/agentFleet/index.js'
import type { FleetLaunchSpec } from '../../services/agentFleet/launch.js'

export type { FleetLaunchSpec } from '../../services/agentFleet/launch.js'

type DefinitionSource =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'policySettings'
  | 'plugin'
  | 'flagSettings'
  | 'built-in'

type DefinitionSummary = {
  agentType: string
  memory?: string
  model?: string
  source: DefinitionSource
}

const DEFINITION_SOURCE_GROUPS: Array<{
  label: string
  source: DefinitionSource
}> = [
  { label: 'User agents', source: 'userSettings' },
  { label: 'Project agents', source: 'projectSettings' },
  { label: 'Local agents', source: 'localSettings' },
  { label: 'Managed agents', source: 'policySettings' },
  { label: 'Plugin agents', source: 'plugin' },
  { label: 'CLI arg agents', source: 'flagSettings' },
  { label: 'Built-in agents', source: 'built-in' },
]

async function readDefinitionFile(
  filePath: string,
  source: DefinitionSource,
  agentPrefix = '',
): Promise<DefinitionSummary | undefined> {
  try {
    const text = await Bun.file(filePath).text()
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
    if (!match) return undefined
    const frontmatter = Bun.YAML.parse(match[1] ?? '')
    if (
      !frontmatter ||
      typeof frontmatter !== 'object' ||
      !('name' in frontmatter) ||
      typeof frontmatter.name !== 'string'
    ) {
      return undefined
    }
    return {
      agentType: `${agentPrefix}${frontmatter.name}`,
      source,
      ...('model' in frontmatter && typeof frontmatter.model === 'string'
        ? { model: frontmatter.model }
        : {}),
      ...('memory' in frontmatter && typeof frontmatter.memory === 'string'
        ? { memory: frontmatter.memory }
        : {}),
    }
  } catch {
    return undefined
  }
}

async function scanDefinitionDirectory(
  directory: string,
  source: DefinitionSource,
  pattern = '*.md',
  agentPrefix = '',
): Promise<DefinitionSummary[]> {
  try {
    const files = await Array.fromAsync(
      new Bun.Glob(pattern).scan({ absolute: true, cwd: directory }),
    )
    return (
      await Promise.all(
        files.map(path => readDefinitionFile(path, source, agentPrefix)),
      )
    ).filter(definition => definition !== undefined)
  } catch {
    return []
  }
}

async function loadPluginDefinitionSummaries(
  home: string,
): Promise<DefinitionSummary[]> {
  try {
    const [installed, settings] = await Promise.all([
      Bun.file(`${home}/.claude/plugins/installed_plugins.json`).json(),
      Bun.file(`${home}/.claude/settings.json`).json(),
    ])
    const enabled = settings.enabledPlugins as
      | Record<string, boolean>
      | undefined
    const plugins = installed.plugins as Record<
      string,
      Array<{ installPath?: string }>
    >
    const directories = Object.entries(plugins).flatMap(([name, installs]) =>
      enabled?.[name] === true
        ? installs.flatMap(install =>
            install.installPath
              ? [{ directory: install.installPath, prefix: name.split('@')[0] }]
              : [],
          )
        : [],
    )
    return (
      await Promise.all(
        directories.map(({ directory, prefix }) =>
          scanDefinitionDirectory(
            directory,
            'plugin',
            '**/agents/*.md',
            `${prefix}:`,
          ),
        ),
      )
    ).flat()
  } catch {
    return []
  }
}

async function loadDefinitionSummaries(
  cwd: string,
): Promise<DefinitionSummary[]> {
  const home = process.env.HOME
  const directories: Array<{ path: string; source: DefinitionSource }> = []
  if (home)
    directories.push({ path: `${home}/.claude/agents`, source: 'userSettings' })

  let current = cwd
  while (true) {
    directories.push({
      path: `${current}/.claude/agents`,
      source: 'projectSettings',
    })
    const parent = current.slice(0, current.lastIndexOf('/')) || '/'
    if (parent === current) break
    current = parent
  }

  const [builtIns, custom, plugins, defaultModel] = await Promise.all([
    import('src/tools/AgentTool/builtInAgents.js').then(
      ({ getBuiltInAgents }) =>
        getBuiltInAgents().map(
          ({ agentType, memory, model }): DefinitionSummary => ({
            agentType,
            source: 'built-in',
            ...(model ? { model } : {}),
            ...(memory ? { memory } : {}),
          }),
        ),
    ),
    Promise.all(
      directories.map(({ path, source }) =>
        scanDefinitionDirectory(path, source),
      ),
    ).then(results => results.flat()),
    home ? loadPluginDefinitionSummaries(home) : Promise.resolve([]),
    import('src/utils/model/agent.js').then(module =>
      module.getDefaultSubagentModel(),
    ),
  ])
  const seen = new Set<string>()
  return [...builtIns, ...plugins, ...custom]
    .map(definition => ({
      ...definition,
      ...(definition.model || !defaultModel ? {} : { model: defaultModel }),
    }))
    .filter(definition => {
      const key = `${definition.source}:${definition.agentType}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

export async function agentsDefinitionsHandler(): Promise<void> {
  const definitions = await loadDefinitionSummaries(getCwd())
  const activeByName = new Map<string, DefinitionSummary>()
  for (const definition of definitions)
    activeByName.set(definition.agentType, definition)
  const formatAgent = (agent: DefinitionSummary): string => {
    const model = agent.model
    const parts = [agent.agentType]
    if (model) parts.push(model)
    if (agent.memory) parts.push(`${agent.memory} memory`)
    return parts.join(' · ')
  }

  const lines: string[] = []
  let totalActive = 0

  for (const { label, source } of DEFINITION_SOURCE_GROUPS) {
    const groupAgents = definitions
      .filter(a => a.source === source)
      .sort((a, b) => a.agentType.localeCompare(b.agentType))

    if (groupAgents.length === 0) continue

    lines.push(`${label}:`)
    for (const agent of groupAgents) {
      const winner = activeByName.get(agent.agentType)
      if (winner && winner.source !== agent.source) {
        lines.push(`  (shadowed by ${winner.source}) ${formatAgent(agent)}`)
      } else {
        lines.push(`  ${formatAgent(agent)}`)
        totalActive++
      }
    }
    lines.push('')
  }

  if (lines.length === 0) {
    console.log('No agents found.')
  } else {
    console.log(`${totalActive} active agents\n`)
    console.log(lines.join('\n').trimEnd())
  }
}

export type AgentsHandlerOptions = AgentFleetFilter & {
  json?: boolean
  launch?: FleetLaunchSpec
}

function hasLaunchOptions(launch: FleetLaunchSpec | undefined): boolean {
  return launch !== undefined && Object.keys(launch).length > 0
}

function writeStdout(value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(value, error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function renderAgentFleet(): Promise<'definitions' | 'exit'> {
  const [React, ink, appState, store, keybindings, fleetView] =
    await Promise.all([
      import('react'),
      import('@anthropic/ink'),
      import('../../state/AppState.js'),
      import('../../state/store.js'),
      import('../../keybindings/loadUserBindings.js'),
      import('../../components/agents/AgentFleetView.js'),
    ])
  return new Promise(resolve => {
    let unmount = () => {}
    const finish = (result: 'definitions' | 'exit') => {
      unmount()
      resolve(result)
    }
    const fleet = React.createElement(fleetView.AgentFleetView, {
      onDefinitions: () => finish('definitions'),
      onExit: () => finish('exit'),
    })
    const keybindingSetup = React.createElement(ink.KeybindingSetup, {
      loadBindings: keybindings.loadKeybindingsSyncWithWarnings,
      subscribeToChanges: keybindings.subscribeToKeybindingChanges,
      children: fleet,
    })
    const provider = React.createElement(appState.AppStoreContext.Provider, {
      value: store.createStore(appState.getDefaultAppState()),
      children: keybindingSetup,
    })
    const view = React.createElement(ink.AlternateScreen, {
      children: provider,
    })
    void ink.wrappedRender(view, { exitOnCtrlC: true }).then(root => {
      unmount = root.unmount
    })
  })
}

export async function runAgentFleetNavigation(
  render: () => Promise<'definitions' | 'exit'> = renderAgentFleet,
  definitions: () => Promise<void> = agentsDefinitionsHandler,
): Promise<void> {
  while ((await render()) === 'definitions') await definitions()
}

/** Print the unified running-agent Fleet. JSON and TTY use the same snapshot. */
export async function agentsHandler(
  options: AgentsHandlerOptions = {},
): Promise<number> {
  if (hasLaunchOptions(options.launch)) {
    try {
      const { launchFleetAgent } = await import(
        '../../services/agentFleet/launch.js'
      )
      const launched = await launchFleetAgent(
        options.launch!,
        options.cwd ?? getCwd(),
      )
      if (options.json) {
        await writeStdout(`${JSON.stringify({ ok: true, ...launched })}\n`)
      } else {
        console.log(`Agent launched: ${launched.sessionName}`)
        console.log(`  Engine: ${launched.engine}`)
        console.log(`  CWD: ${launched.cwd}`)
        console.log(`  Log: ${launched.logPath}`)
        console.log(
          `Use \`claude daemon attach ${launched.sessionName}\` to reconnect.`,
        )
      }
      return 0
    } catch (error) {
      const result = {
        ok: false,
        code: 'launch-failed',
        message: error instanceof Error ? error.message : String(error),
      } as const
      if (options.json) {
        await writeStdout(`${JSON.stringify(result)}\n`)
      } else {
        console.error(result.message)
      }
      return 1
    }
  }
  if (options.json) {
    const { buildAgentFleetSnapshot } = await import(
      '../../services/agentFleet/roster.js'
    )
    const snapshot = await buildAgentFleetSnapshot(
      options.cwd ?? getCwd(),
      options,
    )
    await writeStdout(`${JSON.stringify(snapshot)}\n`)
    return 0
  }
  if (!process.stdout.isTTY) {
    console.error('Use `claude agents --json` in a non-interactive shell.')
    return 1
  }
  await runAgentFleetNavigation()
  return 0
}

type AgentsCommandOptions = {
  addDir?: string[]
  agent?: string
  all?: boolean
  cwd?: string
  dangerouslySkipPermissions?: boolean
  effort?: FleetLaunchSpec['effort']
  json?: boolean
  mcpConfig?: string[]
  model?: string
  permissionMode?: FleetLaunchSpec['permissionMode']
  pluginDir?: string[]
  settingSources?: string
  settings?: string
  source?: AgentFleetFilter['source']
  state?: 'working' | 'blocked' | 'done' | 'failed' | 'stopped'
  strictMcpConfig?: boolean
}

async function exitAgentsCommand(
  exitCode: number,
  stopMessaging: boolean,
): Promise<never> {
  if (stopMessaging) {
    const { stopUdsMessaging } = await import('../../utils/udsMessaging.js')
    await stopUdsMessaging()
  }
  await Promise.all([
    new Promise<void>(resolve => process.stdout.end(resolve)),
    new Promise<void>(resolve => process.stderr.end(resolve)),
  ])
  process.exit(exitCode)
}

export async function registerAgentsCommand(
  program: Command,
  options: { stopMessaging?: boolean } = {},
): Promise<void> {
  const [commander, effort, permissions, settings] = await Promise.all([
    import('@commander-js/extra-typings'),
    import('../../utils/effort.js'),
    import('../../utils/permissions/PermissionMode.js'),
    import('../../utils/settings/constants.js'),
  ])
  const { Option } = commander
  const stopMessaging = options.stopMessaging ?? true
  const agentsCmd = program
    .command('agents')
    .description('Inspect and control running agents')
    .option('--json', 'Print the Fleet snapshot as JSON')
    .option('--cwd <path>', 'Filter agents by canonical working directory')
    .option('--all', 'Include agents outside the current working directory')
    .addOption(
      new Option('--state <state>', 'Filter by agent state').choices([
        'working',
        'blocked',
        'done',
        'failed',
        'stopped',
      ]),
    )
    .addOption(
      new Option('--source <source>', 'Filter by agent source').choices([
        'background',
        'peer',
        'definition',
      ]),
    )
    .option(
      '--add-dir <directories...>',
      'Additional directories for a launched agent',
    )
    .option('--agent <agent>', 'Agent definition for a launched agent')
    .option('--model <model>', 'Model for a launched agent')
    .addOption(
      new Option(
        '--effort <level>',
        'Effort level for a launched agent',
      ).choices([...effort.EFFORT_LEVELS]),
    )
    .addOption(
      new Option(
        '--permission-mode <mode>',
        'Permission mode for a launched agent',
      ).choices([...permissions.PERMISSION_MODES]),
    )
    .option(
      '--dangerously-skip-permissions',
      'Bypass permission checks for a launched agent',
    )
    .option(
      '--plugin-dir <path>',
      'Load a plugin directory for a launched agent (repeatable)',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      '--mcp-config <configs...>',
      'Load MCP configs for a launched agent',
    )
    .option(
      '--strict-mcp-config',
      'Use only explicitly supplied MCP configs for a launched agent',
    )
    .option('--settings <file-or-json>', 'Settings for a launched agent')
    .option(
      '--setting-sources <sources>',
      'Comma-separated setting sources: user, project, local',
    )

  agentsCmd.action(async (options: AgentsCommandOptions) => {
    const launch: FleetLaunchSpec = {
      ...(options.addDir?.length ? { addDirs: options.addDir } : {}),
      ...(options.agent ? { agent: options.agent } : {}),
      ...(options.dangerouslySkipPermissions
        ? { dangerouslySkipPermissions: true }
        : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.mcpConfig?.length ? { mcpConfigs: options.mcpConfig } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.permissionMode
        ? { permissionMode: options.permissionMode }
        : {}),
      ...(options.pluginDir?.length ? { pluginDirs: options.pluginDir } : {}),
      ...(options.settingSources
        ? {
            settingSources: settings.parseSettingSourcesFlag(
              options.settingSources,
            ),
          }
        : {}),
      ...(options.settings ? { settings: options.settings } : {}),
      ...(options.strictMcpConfig ? { strictMcpConfig: true } : {}),
    }
    const exitCode = await agentsHandler({
      json: options.json,
      cwd: options.cwd,
      all: options.all,
      state: options.state,
      source: options.source,
      launch,
    })
    await exitAgentsCommand(exitCode, stopMessaging)
  })
  agentsCmd
    .command('definitions')
    .description('List configured agent definitions')
    .action(async () => {
      await agentsDefinitionsHandler()
      await exitAgentsCommand(0, stopMessaging)
    })
}

export async function agentsCliMain(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === 'definitions') {
    await agentsDefinitionsHandler()
    await exitAgentsCommand(0, false)
  }
  const { enableConfigs } = await import('../../utils/config.js')
  enableConfigs()
  const { Command } = await import('@commander-js/extra-typings')
  const program = new Command().name('claude')
  await registerAgentsCommand(program, { stopMessaging: false })
  await program.parseAsync([process.execPath, 'claude', 'agents', ...args])
}
