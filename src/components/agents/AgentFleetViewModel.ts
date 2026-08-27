import type {
  AgentFleetAction,
  AgentFleetCapability,
  AgentFleetRecord,
  AgentFleetSnapshot,
} from '../../services/agentFleet/types.js'

export type FleetViewStatus =
  | 'loading'
  | 'empty'
  | 'ready'
  | 'partial'
  | 'error'
  | 'stale'

export type FleetActionShortcut = {
  key: string
  label: string
  needsInput: boolean
  type: AgentFleetCapability
}

const ACTION_SHORTCUTS: readonly FleetActionShortcut[] = [
  { type: 'message', key: 'm', label: 'message', needsInput: true },
  { type: 'logs', key: 'l', label: 'logs', needsInput: false },
  { type: 'attach', key: 'a', label: 'attach', needsInput: false },
  { type: 'resume', key: 'u', label: 'resume', needsInput: true },
  { type: 'retry', key: 'y', label: 'retry', needsInput: true },
  { type: 'stop', key: 's', label: 'stop', needsInput: false },
  { type: 'cleanup', key: 'c', label: 'cleanup', needsInput: false },
]

export function fleetViewStatus(
  snapshot: AgentFleetSnapshot | undefined,
  loading: boolean,
  error: string | undefined,
): FleetViewStatus {
  if (!snapshot) return loading ? 'loading' : 'error'
  if (error) return 'stale'
  if (snapshot.partial) return 'partial'
  return snapshot.records.length === 0 ? 'empty' : 'ready'
}

export function filterFleetRecords(
  records: readonly AgentFleetRecord[],
  query: string,
): AgentFleetRecord[] {
  const needle = query.trim().toLowerCase()
  const unique = [
    ...new Map(records.map(record => [record.id, record])).values(),
  ]
  if (!needle) return unique
  return unique.filter(record =>
    [
      record.name,
      record.id,
      record.rawId,
      record.sessionId,
      record.cwd,
      record.source,
      record.state,
      record.status,
    ].some(value => value?.toLowerCase().includes(needle)),
  )
}

export function availableFleetActions(
  record: AgentFleetRecord,
): FleetActionShortcut[] {
  return ACTION_SHORTCUTS.filter(action =>
    record.capabilities.includes(action.type),
  )
}

export function fleetAction(
  record: AgentFleetRecord,
  type: AgentFleetCapability,
  content = '',
): AgentFleetAction {
  const base = {
    id: record.id,
    revision: record.revision,
    updatedAt: record.updatedAt,
  }
  switch (type) {
    case 'message':
      return { ...base, type, content }
    case 'resume':
    case 'retry':
      return { ...base, type, prompt: content }
    case 'attach':
    case 'cleanup':
    case 'logs':
    case 'stop':
      return { ...base, type }
  }
}
