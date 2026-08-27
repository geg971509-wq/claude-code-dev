import { lazySchema } from '@claude-code-best/core-utils/lazySchema'
import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  type DiscoveryAppState,
  discoverPeerRoster,
  formatPeerListing,
  type PeerDiscoveryDeps,
} from '../../utils/peerDiscovery.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { LIST_AGENTS_TOOL_NAME, LIST_PEERS_TOOL_ALIAS } from './constants.js'
import { DESCRIPTION, PROMPT } from './prompt.js'

const inputSchema = lazySchema(() => z.object({}))
const outputSchema = lazySchema(() => z.object({ listing: z.string() }))
type InputSchema = ReturnType<typeof inputSchema>
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export async function listAgents(
  state: DiscoveryAppState,
  deps?: PeerDiscoveryDeps,
  options?: { includeMain?: boolean },
): Promise<Output> {
  const roster = await discoverPeerRoster(state, deps, options)
  return { listing: formatPeerListing(roster) }
}

export const ListAgentsTool = buildTool({
  name: LIST_AGENTS_TOOL_NAME,
  aliases: [LIST_PEERS_TOOL_ALIAS],
  searchHint: 'find reachable agents and sessions',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return LIST_AGENTS_TOOL_NAME
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  isEnabled() {
    if (feature('CROSS_SESSION_MESSAGING')) return true
    return false
  },
  renderToolUseMessage() {
    return null
  },
  async call(_input, context) {
    return {
      data: await listAgents(context.getAppState(), undefined, {
        includeMain: context.agentId !== undefined,
      }),
    }
  },
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: [
        {
          type: 'text',
          text: jsonStringify(data),
        },
      ],
    }
  },
} satisfies ToolDef<InputSchema, Output>)
