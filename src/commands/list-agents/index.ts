import type { Command } from '../../commands.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { LocalCommandResult } from '../../types/command.js'
import type { PeerDiscoveryDeps } from '../../utils/peerDiscovery.js'
import { listAgents } from '../../tools/ListAgentsTool/ListAgentsTool.js'

export async function runListAgentsCommand(
  state: AppState,
  deps?: PeerDiscoveryDeps,
): Promise<LocalCommandResult> {
  const { listing } = await listAgents(state, deps)
  return { type: 'text', value: listing }
}

const listAgentsCommand = {
  type: 'local',
  name: 'list-agents',
  aliases: ['peers'],
  description: 'List reachable agents and sessions',
  supportsNonInteractive: true,
  load: () =>
    Promise.resolve({
      call: async (_args, context) =>
        runListAgentsCommand(context.getAppState()),
    }),
} satisfies Command

export default listAgentsCommand
