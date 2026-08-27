import type { SessionKind } from '../../utils/concurrentSessions.js'
import type { PeerTransport } from '../../utils/peerRegistry.js'

export type AgentFleetState =
  | 'working'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'stopped'

export type AgentFleetCapability =
  | 'message'
  | 'attach'
  | 'resume'
  | 'logs'
  | 'stop'
  | 'retry'
  | 'cleanup'

export type AgentFleetSource = 'background' | 'peer' | 'definition'

export type AgentFleetRecord = {
  id: string
  rawId?: string
  taskId?: string
  pid?: number
  cwd?: string
  kind?: SessionKind | string
  startedAt: number
  updatedAt: number
  revision: string
  sessionId?: string
  ownerSessionId?: string
  parentId?: string
  name?: string
  status?: string
  waitingFor?: string
  state: AgentFleetState
  source: AgentFleetSource
  capabilities: readonly AgentFleetCapability[]
  engine?: 'tmux' | 'detached' | 'pty'
  logPath?: string
  socketPath?: string
  address?: string
  ref?: string
  transport?: PeerTransport
  mirroredTransports?: PeerTransport[]
}

export type AgentFleetSnapshot = {
  generatedAt: number
  revision: string
  cwd: string
  records: AgentFleetRecord[]
  partial: boolean
  unavailableSources: AgentFleetSource[]
}

export type AgentFleetFilter = {
  cwd?: string
  all?: boolean
  state?: AgentFleetState
  source?: AgentFleetSource
}

export type AgentFleetAction =
  | {
      type: 'message'
      id: string
      revision: string
      updatedAt: number
      content: string
    }
  | {
      type: 'resume' | 'retry'
      id: string
      revision: string
      updatedAt: number
      prompt: string
    }
  | { type: 'stop'; id: string; revision: string; updatedAt: number }
  | { type: 'logs'; id: string; revision: string; updatedAt: number }
  | { type: 'attach'; id: string; revision: string; updatedAt: number }
  | { type: 'cleanup'; id: string; revision: string; updatedAt: number }

export type AgentFleetActionResult =
  | {
      ok: true
      action: AgentFleetAction['type']
      id: string
      output?: string
    }
  | {
      ok: false
      code:
        | 'not-found'
        | 'stale'
        | 'unsupported'
        | 'permission-denied'
        | 'owner-unavailable'
        | 'transport-error'
      message: string
    }
