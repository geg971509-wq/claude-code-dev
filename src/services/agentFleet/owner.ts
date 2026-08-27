import {
  setOnAgentFleetAction,
  setOnAgentFleetSnapshot,
} from '../../utils/udsMessaging.js'
import { findFleetRecord } from './roster.js'
import type {
  AgentFleetAction,
  AgentFleetActionResult,
  AgentFleetRecord,
  AgentFleetSnapshot,
} from './types.js'

type AgentFleetOwnerOptions = {
  buildSnapshot: () => Promise<AgentFleetSnapshot>
  dispatch: (
    record: AgentFleetRecord | undefined,
    action: AgentFleetAction,
  ) => Promise<AgentFleetActionResult>
}

export function createAgentFleetOwnerHandlers(
  options: AgentFleetOwnerOptions,
): {
  snapshot: () => Promise<AgentFleetSnapshot>
  action: (action: AgentFleetAction) => Promise<AgentFleetActionResult>
} {
  return {
    snapshot: options.buildSnapshot,
    async action(action) {
      const current = await options.buildSnapshot()
      return options.dispatch(findFleetRecord(current, action.id), action)
    },
  }
}

export function configureAgentFleetOwner(
  options: AgentFleetOwnerOptions,
): () => void {
  const handlers = createAgentFleetOwnerHandlers(options)
  setOnAgentFleetSnapshot(handlers.snapshot)
  setOnAgentFleetAction(handlers.action)
  return () => {
    setOnAgentFleetSnapshot(null)
    setOnAgentFleetAction(null)
  }
}
