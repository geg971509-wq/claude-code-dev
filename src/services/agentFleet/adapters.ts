import type { PeerCandidate, PeerRoster } from '../../utils/peerRegistry.js'
import type { PeerSession } from '../../utils/udsClient.js'
import type {
  AgentFleetCapability,
  AgentFleetRecord,
  AgentFleetState,
} from './types.js'

export type AgentFleetTaskRecords = Readonly<Record<string, unknown>>

function stateForStatus(status: string | undefined): AgentFleetState {
  switch (status?.toLowerCase()) {
    case 'completed':
    case 'done':
      return 'done'
    case 'failed':
    case 'error':
      return 'failed'
    case 'stopped':
    case 'killed':
      return 'stopped'
    case 'blocked':
    case 'waiting':
      return 'blocked'
    default:
      return 'working'
  }
}

export function recordFromSession(session: PeerSession): AgentFleetRecord {
  const startedAt = session.startedAt ?? 0
  const updatedAt = session.updatedAt ?? startedAt
  const engine = session.entrypoint === 'pty' ? 'pty' : session.engine
  const capabilities: AgentFleetCapability[] = []
  if (session.messagingSocketPath) capabilities.push('message')
  if (engine === 'pty' || session.kind === 'bg' || session.kind === 'daemon') {
    capabilities.push('attach')
  }
  if (session.logPath) capabilities.push('logs')
  if (session.pid) capabilities.push('stop')
  return {
    id: `session:${session.sessionId ?? session.pid}`,
    rawId: session.sessionId ?? String(session.pid),
    pid: session.pid,
    cwd: session.cwd,
    kind: session.kind,
    startedAt,
    updatedAt,
    revision: `${session.sessionId ?? session.pid}:${updatedAt}`,
    sessionId: session.sessionId,
    name: session.name,
    status: session.status,
    waitingFor: session.waitingFor,
    state: !session.alive
      ? 'stopped'
      : session.waitingFor
        ? 'blocked'
        : stateForStatus(session.status),
    source:
      session.pid === process.pid ||
      session.kind === 'bg' ||
      session.kind === 'daemon' ||
      session.kind === 'daemon-worker'
        ? 'background'
        : 'peer',
    capabilities,
    engine,
    logPath: session.logPath,
    socketPath: session.messagingSocketPath,
    address: session.messagingSocketPath
      ? `uds:${session.messagingSocketPath}`
      : undefined,
    transport: session.messagingSocketPath ? 'uds' : undefined,
  }
}

function stringField(record: object, key: string): string | undefined {
  const value = Reflect.get(record, key)
  return typeof value === 'string' ? value : undefined
}

function numberField(record: object, key: string): number | undefined {
  const value = Reflect.get(record, key)
  return typeof value === 'number' ? value : undefined
}

function nestedString(
  record: object,
  key: string,
  nestedKey: string,
): string | undefined {
  const nested = Reflect.get(record, key)
  return typeof nested === 'object' && nested !== null
    ? stringField(nested, nestedKey)
    : undefined
}

function taskName(task: object): string | undefined {
  return (
    nestedString(task, 'identity', 'agentName') ??
    nestedString(task, 'selectedAgent', 'name') ??
    stringField(task, 'title') ??
    stringField(task, 'description')
  )
}

function taskCapabilities(task: object): AgentFleetCapability[] {
  const capabilities: AgentFleetCapability[] = []
  const type = stringField(task, 'type')
  const status = stringField(task, 'status')
  if (
    (type === 'local_agent' || type === 'in_process_teammate') &&
    status !== 'completed' &&
    status !== 'failed' &&
    status !== 'stopped' &&
    status !== 'killed'
  ) {
    capabilities.push('message')
  }
  if (stringField(task, 'outputFile')) capabilities.push('logs')
  if (status === 'pending' || status === 'running') capabilities.push('stop')
  if (
    type === 'local_agent' &&
    (status === 'completed' ||
      status === 'failed' ||
      status === 'stopped' ||
      status === 'killed')
  ) {
    capabilities.push('resume', 'retry', 'cleanup')
  }
  return capabilities
}

function isFleetTask(task: unknown): task is object {
  if (typeof task !== 'object' || task === null) return false
  const type = stringField(task, 'type')
  return (
    type === 'local_agent' ||
    type === 'in_process_teammate' ||
    type === 'remote_agent'
  )
}

export function recordsFromAppStateTasks(
  tasks: AgentFleetTaskRecords,
  ownerSessionId = 'current',
  cwd?: string,
): AgentFleetRecord[] {
  const records: AgentFleetRecord[] = []
  for (const [taskKey, task] of Object.entries(tasks)) {
    if (!isFleetTask(task)) continue
    const taskId = stringField(task, 'id') ?? taskKey
    const startedAt = numberField(task, 'startTime') ?? 0
    const updatedAt = numberField(task, 'endTime') ?? startedAt
    const status = stringField(task, 'status')
    const waiting =
      Reflect.get(task, 'awaitingPlanApproval') === true ||
      Reflect.get(task, 'isIdle') === true
    records.push({
      id: `task:${ownerSessionId}:${taskId}`,
      taskId,
      rawId:
        stringField(task, 'agentId') ??
        nestedString(task, 'identity', 'agentId') ??
        taskId,
      cwd: stringField(task, 'cwd') ?? stringField(task, 'worktreePath') ?? cwd,
      kind: stringField(task, 'type'),
      startedAt,
      updatedAt,
      revision: `${ownerSessionId}:${taskId}:${status ?? 'unknown'}:${updatedAt}`,
      sessionId:
        stringField(task, 'type') === 'remote_agent'
          ? stringField(task, 'sessionId')
          : undefined,
      ownerSessionId,
      parentId:
        stringField(task, 'parentId') ??
        nestedString(task, 'identity', 'parentSessionId'),
      name: taskName(task),
      status,
      state: waiting ? 'blocked' : stateForStatus(status),
      source: 'background',
      capabilities: taskCapabilities(task),
      logPath: stringField(task, 'outputFile'),
    })
  }
  return records
}

function peerIdentity(candidate: PeerCandidate): string {
  const sessionId = candidate.bridgeSessionId ?? candidate.sessionId
  return sessionId
    ? `session:${sessionId}`
    : `peer:${candidate.kind}:${candidate.id}`
}

export function recordsFromPeerRoster(roster: PeerRoster): AgentFleetRecord[] {
  return roster.candidates.map(candidate => {
    const updatedAt = candidate.lastActive ?? 0
    const sessionId = candidate.bridgeSessionId ?? candidate.sessionId
    const capabilities: AgentFleetCapability[] =
      candidate.canReply &&
      candidate.address !== undefined &&
      (candidate.transport === 'uds' ||
        candidate.transport === 'cloud' ||
        candidate.transport === 'bridge')
        ? ['message']
        : []
    return {
      id: peerIdentity(candidate),
      rawId: candidate.id,
      cwd: candidate.cwd,
      kind: candidate.kind,
      startedAt: updatedAt,
      updatedAt,
      revision: `${candidate.kind}:${candidate.id}:${updatedAt}`,
      sessionId,
      name: candidate.name,
      status: candidate.status,
      state: stateForStatus(candidate.status),
      source: 'peer',
      capabilities,
      address: candidate.address,
      ref: candidate.ref,
      transport: candidate.transport,
      mirroredTransports: candidate.mirroredTransports,
    }
  })
}
