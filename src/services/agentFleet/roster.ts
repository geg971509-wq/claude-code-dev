import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type { PeerRoster } from '../../utils/peerRegistry.js'
import {
  listAllLiveSessions,
  requestAgentFleetSnapshot,
  type PeerSession,
} from '../../utils/udsClient.js'
import {
  type AgentFleetTaskRecords,
  recordFromSession,
  recordsFromAppStateTasks,
  recordsFromPeerRoster,
} from './adapters.js'
import type {
  AgentFleetFilter,
  AgentFleetRecord,
  AgentFleetSnapshot,
  AgentFleetSource,
} from './types.js'

export type AgentFleetSnapshotDeps = {
  listSessions?: () => Promise<readonly PeerSession[]>
  getTaskRecords?: () => AgentFleetTaskRecords | Promise<AgentFleetTaskRecords>
  getPeerRoster?: () => PeerRoster | Promise<PeerRoster>
  getOwnerSnapshots?: (
    sessions: readonly PeerSession[],
  ) => Promise<AgentFleetOwnerSnapshots>
  ownerSessionId?: string
  canonicalizeCwd?: (cwd: string) => Promise<string>
  now?: () => number
}

export type AgentFleetOwnerSnapshots = {
  snapshots: readonly AgentFleetSnapshot[]
  failed: boolean
}

async function requestOwnerSnapshots(
  sessions: readonly PeerSession[],
): Promise<AgentFleetOwnerSnapshots> {
  const results = await Promise.allSettled(
    sessions.flatMap(session =>
      session.messagingSocketPath
        ? [requestAgentFleetSnapshot(session.messagingSocketPath)]
        : [],
    ),
  )
  return {
    snapshots: results.flatMap(result =>
      result.status === 'fulfilled' ? [result.value] : [],
    ),
    failed: results.some(result => result.status === 'rejected'),
  }
}

async function canonicalCwd(
  cwd: string,
  canonicalize: ((cwd: string) => Promise<string>) | undefined,
): Promise<string> {
  if (canonicalize) return canonicalize(cwd)
  try {
    return await realpath(cwd)
  } catch {
    return path.resolve(cwd)
  }
}

function sessionBody(id: string | undefined): string | undefined {
  return id?.replace(/^(?:session_|cse_)/, '')
}

function mergeRecords(records: AgentFleetRecord[]): AgentFleetRecord[] {
  const merged: AgentFleetRecord[] = []
  const sessions = new Map<string, number>()
  const taskIds = new Set(
    records
      .filter(record => record.id.startsWith('task:'))
      .map(record => record.rawId),
  )
  for (const record of records) {
    const body = sessionBody(record.sessionId)
    const existingIndex = body ? sessions.get(body) : undefined
    if (existingIndex !== undefined) {
      const existing = merged[existingIndex]!
      const mirrors = new Set(existing.mirroredTransports ?? [])
      if (record.transport) mirrors.add(record.transport)
      for (const transport of record.mirroredTransports ?? []) {
        mirrors.add(transport)
      }
      existing.mirroredTransports = [...mirrors]
      continue
    }
    if (record.id.startsWith('peer:') && taskIds.has(record.rawId)) continue
    if (body) sessions.set(body, merged.length)
    merged.push(record)
  }
  return merged
}

function collectUnavailable(
  sessionFailed: boolean,
  taskFailed: boolean,
  peerFailed: boolean,
  roster: PeerRoster | undefined,
): AgentFleetSource[] {
  const unavailable = new Set<AgentFleetSource>()
  if (sessionFailed || taskFailed) unavailable.add('background')
  if (peerFailed || Object.keys(roster?.unavailable ?? {}).length > 0) {
    unavailable.add('peer')
  }
  return [...unavailable]
}

export async function buildAgentFleetSnapshot(
  cwd = process.cwd(),
  filter: AgentFleetFilter = {},
  deps: AgentFleetSnapshotDeps = {},
): Promise<AgentFleetSnapshot> {
  const canonical = await canonicalCwd(filter.cwd ?? cwd, deps.canonicalizeCwd)
  const [sessionResult, taskResult, peerResult] = await Promise.allSettled([
    Promise.resolve().then(() => (deps.listSessions ?? listAllLiveSessions)()),
    Promise.resolve().then(() => deps.getTaskRecords?.() ?? {}),
    Promise.resolve().then(() => deps.getPeerRoster?.()),
  ])
  const sessions =
    sessionResult.status === 'fulfilled' ? sessionResult.value : []
  const tasks = taskResult.status === 'fulfilled' ? taskResult.value : {}
  const roster =
    peerResult.status === 'fulfilled' ? peerResult.value : undefined
  const ownerSnapshots =
    sessionResult.status === 'fulfilled'
      ? await (deps.getOwnerSnapshots ?? requestOwnerSnapshots)(sessions)
      : { snapshots: [], failed: true }
  const rawRecords = mergeRecords([
    ...sessions.map(recordFromSession),
    ...recordsFromAppStateTasks(tasks, deps.ownerSessionId, canonical),
    ...(roster ? recordsFromPeerRoster(roster) : []),
    ...ownerSnapshots.snapshots.flatMap(snapshot => snapshot.records),
  ])
  const canonicalRecords = await Promise.all(
    rawRecords.map(async record => ({
      ...record,
      cwd: record.cwd
        ? await canonicalCwd(record.cwd, deps.canonicalizeCwd)
        : undefined,
    })),
  )
  const records = canonicalRecords
    .filter(record => filter.all || record.cwd === canonical)
    .filter(record => !filter.state || record.state === filter.state)
    .filter(record => !filter.source || record.source === filter.source)
    .sort((left, right) => {
      const startedAt = right.startedAt - left.startedAt
      return startedAt || left.id.localeCompare(right.id)
    })
  const unavailableSources = collectUnavailable(
    sessionResult.status === 'rejected' || ownerSnapshots.failed,
    taskResult.status === 'rejected',
    peerResult.status === 'rejected',
    roster,
  )
  for (const source of ownerSnapshots.snapshots.flatMap(
    snapshot => snapshot.unavailableSources,
  )) {
    if (!unavailableSources.includes(source)) unavailableSources.push(source)
  }
  return {
    generatedAt: deps.now?.() ?? Date.now(),
    revision: records.map(record => record.revision).join('|') || 'empty',
    cwd: canonical,
    records,
    partial: unavailableSources.length > 0,
    unavailableSources,
  }
}

export function findFleetRecord(
  snapshot: AgentFleetSnapshot,
  id: string,
): AgentFleetRecord | undefined {
  return snapshot.records.find(
    record =>
      record.id === id ||
      record.rawId === id ||
      record.sessionId === id ||
      String(record.pid) === id,
  )
}
