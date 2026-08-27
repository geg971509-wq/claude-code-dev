import {
  buildPeerRoster,
  formatPeerAddress,
  type PeerCandidate,
  type PeerRoster,
  type PeerSourceRecord,
  type PeerUnavailableSources,
  resolvePeerTarget,
} from './peerRegistry.js'

export type DiscoveryAppState = {
  agentNameRegistry: ReadonlyMap<string, string>
  tasks: Record<string, unknown>
  teamContext?: {
    selfAgentId?: string
    selfAgentName?: string
    teammates: Record<string, { name: string; cwd?: string }>
  }
}

export type PeerDiscoveryDeps = {
  listLocal: () => Promise<PeerSourceRecord[]>
  listCloud: () => Promise<PeerSourceRecord[]>
  listBridge: () => Promise<PeerSourceRecord[]>
  getSelfIds: () => string[] | Promise<string[]>
  getUnavailable?: () =>
    | PeerUnavailableSources
    | Promise<PeerUnavailableSources>
}

export type PeerDiscoveryOptions = {
  includeMain?: boolean
  includeRemote?: boolean
  remoteTimeoutMs?: number
}

const DEFAULT_REMOTE_DISCOVERY_TIMEOUT_MS = 2_000

function taskStatus(task: unknown): string | undefined {
  if (typeof task !== 'object' || task === null || !('status' in task)) {
    return undefined
  }
  return typeof task.status === 'string' ? task.status : undefined
}

function inProcessPeers(state: DiscoveryAppState): PeerSourceRecord[] {
  const peers: PeerSourceRecord[] = [...state.agentNameRegistry].map(
    ([name, agentId]) => ({
      kind: 'subagent',
      transport: 'in-process',
      id: agentId,
      name,
      status: taskStatus(state.tasks[agentId]) ?? 'stopped',
      canReply: true,
    }),
  )
  const registeredIds = new Set(peers.map(peer => peer.id))
  for (const [taskId, task] of Object.entries(state.tasks)) {
    if (
      typeof task !== 'object' ||
      task === null ||
      !('type' in task) ||
      task.type !== 'local_agent' ||
      ('agentType' in task && task.agentType === 'main-session')
    ) {
      continue
    }
    const agentId =
      'agentId' in task && typeof task.agentId === 'string'
        ? task.agentId
        : taskId
    if (registeredIds.has(agentId)) continue
    const selectedName =
      'selectedAgent' in task &&
      typeof task.selectedAgent === 'object' &&
      task.selectedAgent !== null &&
      'name' in task.selectedAgent &&
      typeof task.selectedAgent.name === 'string'
        ? task.selectedAgent.name
        : undefined
    const description =
      'description' in task && typeof task.description === 'string'
        ? task.description
        : undefined
    peers.push({
      kind: 'subagent',
      transport: 'in-process',
      id: agentId,
      name: selectedName || description,
      status: taskStatus(task) ?? 'stopped',
      canReply: true,
    })
    registeredIds.add(agentId)
  }
  return peers
}

function teamPeers(state: DiscoveryAppState): PeerSourceRecord[] {
  const registeredIds = new Set(state.agentNameRegistry.values())
  return Object.entries(state.teamContext?.teammates ?? {})
    .filter(([id]) => !registeredIds.has(id))
    .map(([id, teammate]) => ({
      kind: 'teammate',
      transport: 'mailbox',
      id,
      name: teammate.name,
      address: `mailbox:${teammate.name}`,
      status: 'reachable',
      cwd: teammate.cwd,
      canReply: true,
    }))
}

async function captureProvider(
  source: 'local' | 'cloud' | 'bridge',
  load: () => Promise<PeerSourceRecord[]>,
  timeoutMs?: number,
): Promise<
  | { source: typeof source; records: PeerSourceRecord[] }
  | { source: typeof source; unavailable: 'fetch_failed' | 'timeout' }
> {
  const loaded = load().then(
    records => ({ source, records }) as const,
    () => ({ source, unavailable: 'fetch_failed' }) as const,
  )
  if (timeoutMs === undefined) return loaded
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      loaded,
      new Promise<{ source: typeof source; unavailable: 'timeout' }>(
        resolve => {
          timer = setTimeout(
            () => resolve({ source, unavailable: 'timeout' }),
            timeoutMs,
          )
          timer.unref?.()
        },
      ),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function buildRoster(
  state: DiscoveryAppState,
  records: {
    local?: PeerSourceRecord[]
    cloud?: PeerSourceRecord[]
    bridge?: PeerSourceRecord[]
  },
  unavailable: PeerUnavailableSources,
  selfIds: string[],
  options: PeerDiscoveryOptions,
): PeerRoster {
  return buildPeerRoster({
    main: options.includeMain
      ? [
          {
            kind: 'main',
            transport: 'in-process',
            id: 'main',
            name: 'main',
            status: 'reachable',
            canReply: true,
          },
        ]
      : undefined,
    inProcess: inProcessPeers(state),
    team: teamPeers(state),
    local: records.local,
    cloud: records.cloud,
    bridge: records.bridge,
    selfIds: [
      ...selfIds,
      state.teamContext?.selfAgentId,
      state.teamContext?.selfAgentName,
    ].filter((value): value is string => value !== undefined),
    unavailable,
  })
}

export async function discoverPeerRoster(
  state: DiscoveryAppState,
  deps: PeerDiscoveryDeps = defaultPeerDiscoveryDeps,
  options: PeerDiscoveryOptions = {},
): Promise<PeerRoster> {
  const remoteTimeoutMs =
    options.remoteTimeoutMs ?? DEFAULT_REMOTE_DISCOVERY_TIMEOUT_MS
  const [local, cloud, bridge, discoveredSelfIds, reportedUnavailable] =
    await Promise.all([
      captureProvider('local', deps.listLocal),
      captureProvider('cloud', deps.listCloud, remoteTimeoutMs),
      captureProvider('bridge', deps.listBridge, remoteTimeoutMs),
      deps.getSelfIds(),
      deps.getUnavailable?.() ?? {},
    ])
  const unavailable: PeerUnavailableSources = { ...reportedUnavailable }
  const records = {
    local: [] as PeerSourceRecord[],
    cloud: [] as PeerSourceRecord[],
    bridge: [] as PeerSourceRecord[],
  }

  for (const result of [local, cloud, bridge]) {
    if ('unavailable' in result) unavailable[result.source] = result.unavailable
    else records[result.source] = result.records
  }

  return buildRoster(state, records, unavailable, discoveredSelfIds, options)
}

export async function discoverPeerRosterForTarget(
  state: DiscoveryAppState,
  target: string,
  deps: PeerDiscoveryDeps = defaultPeerDiscoveryDeps,
  options: PeerDiscoveryOptions = {},
): Promise<PeerRoster> {
  const immediate = buildRoster(state, {}, {}, [], options)
  if (resolvePeerTarget(immediate, target).kind !== 'not-found') {
    return immediate
  }

  const [local, discoveredSelfIds, reportedUnavailable] = await Promise.all([
    captureProvider('local', deps.listLocal),
    deps.getSelfIds(),
    deps.getUnavailable?.() ?? {},
  ])
  const unavailable: PeerUnavailableSources = { ...reportedUnavailable }
  const records = { local: [] as PeerSourceRecord[] }
  if ('unavailable' in local) unavailable.local = local.unavailable
  else records.local = local.records
  const localRoster = buildRoster(
    state,
    records,
    unavailable,
    discoveredSelfIds,
    options,
  )
  if (resolvePeerTarget(localRoster, target).kind !== 'not-found') {
    return localRoster
  }
  if (options.includeRemote === false) return localRoster

  const remoteTimeoutMs =
    options.remoteTimeoutMs ?? DEFAULT_REMOTE_DISCOVERY_TIMEOUT_MS
  const [cloud, bridge] = await Promise.all([
    captureProvider('cloud', deps.listCloud, remoteTimeoutMs),
    captureProvider('bridge', deps.listBridge, remoteTimeoutMs),
  ])
  const remoteRecords = {
    ...records,
    cloud: [] as PeerSourceRecord[],
    bridge: [] as PeerSourceRecord[],
  }
  for (const result of [cloud, bridge]) {
    if ('unavailable' in result) unavailable[result.source] = result.unavailable
    else remoteRecords[result.source] = result.records
  }
  return buildRoster(
    state,
    remoteRecords,
    unavailable,
    discoveredSelfIds,
    options,
  )
}

function formatCandidate(candidate: PeerCandidate): string {
  const details = [candidate.transport, candidate.status]
  if (candidate.cwd) details.push(candidate.cwd)
  if (candidate.mirroredTransports.length > 0) {
    details.push(`also ${candidate.mirroredTransports.join(', ')}`)
  }
  return `- ${formatPeerAddress(candidate.name, candidate.ref)} — ${details.filter(Boolean).join(' · ')}`
}

export function formatPeerListing(roster: PeerRoster): string {
  if (
    roster.candidates.length === 0 &&
    Object.keys(roster.unavailable).length === 0
  ) {
    return 'No reachable agents.'
  }

  const subagents = roster.candidates.filter(
    candidate =>
      candidate.transport === 'in-process' || candidate.transport === 'mailbox',
  )
  const sessions = roster.candidates.filter(
    candidate => !subagents.includes(candidate),
  )
  const sections: string[] = []

  if (subagents.length > 0) {
    sections.push(`Subagents\n${subagents.map(formatCandidate).join('\n')}`)
  }
  if (sessions.length > 0) {
    sections.push(`Peer sessions\n${sessions.map(formatCandidate).join('\n')}`)
  }

  const warnings = Object.entries(roster.unavailable).map(
    ([source, reason]) => `- ${source}: unavailable (${reason})`,
  )
  if (warnings.length > 0)
    sections.push(`Discovery warnings\n${warnings.join('\n')}`)
  return sections.join('\n\n')
}

export const defaultPeerDiscoveryDeps: PeerDiscoveryDeps = {
  async getUnavailable() {
    const { getUdsMessagingStartupError } = await import('./udsMessaging.js')
    return getUdsMessagingStartupError() ? { local: 'unreadable' } : {}
  },
  async listLocal() {
    const { listPeers } = await import('./udsClient.js')
    return (await listPeers()).map(session => ({
      kind: 'local-session',
      transport: 'uds',
      id: session.sessionId ?? String(session.pid),
      sessionId: session.sessionId,
      bridgeSessionId: session.bridgeSessionId,
      name: session.name ?? session.kind,
      address: `uds:${session.messagingSocketPath}`,
      status: session.status ?? 'reachable',
      cwd: session.cwd,
      lastActive: session.updatedAt ?? session.startedAt,
      canReply: true,
    }))
  },
  async listCloud() {
    const { fetchCodeSessionsFromSessionsAPI, isCloudSessionEnvironment } =
      await import('./teleport/api.js')
    const sessions = await fetchCodeSessionsFromSessionsAPI()
    return sessions
      .filter(
        session =>
          session.status !== 'archived' &&
          isCloudSessionEnvironment(session.environment_kind),
      )
      .map(session => ({
        kind: 'cloud-session',
        transport: 'cloud',
        id: session.id,
        sessionId: session.id,
        name: session.title,
        address: `cloud:${session.id}`,
        status: session.status,
        lastActive: Date.parse(session.updated_at),
        canReply: true,
      }))
  },
  async listBridge() {
    const { listBridgePeers } = await import('../bridge/peerSessions.js')
    const peers = await listBridgePeers()
    return peers.map(peer => {
      return {
        kind: 'bridge-session',
        transport: 'bridge',
        id: peer.sessionId,
        sessionId: peer.sessionId,
        name: peer.name,
        address: peer.address,
        status: peer.status ?? 'reachable',
        cwd: peer.cwd,
        lastActive: peer.updatedAt,
        canReply: true,
      }
    })
  },
  async getSelfIds() {
    const [{ getSessionId }, { getSelfBridgeCompatId }] = await Promise.all([
      import('../bootstrap/state.js'),
      import('../bridge/replBridgeHandle.js'),
    ])
    return [
      String(process.pid),
      getSessionId(),
      getSelfBridgeCompatId(),
    ].filter((value): value is string => value !== undefined)
  },
}
