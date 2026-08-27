import { randomUUID } from 'node:crypto'
import {
  attachHandler,
  killHandler,
  logsHandler,
  listLiveSessions,
} from '../../cli/bg.js'
import { getSessionId } from '../../bootstrap/state.js'
import { discoverPeerRosterForTarget } from '../../utils/peerDiscovery.js'
import type { PeerCandidate, PeerRoster } from '../../utils/peerRegistry.js'
import { sendCrossSessionPeer } from '../../utils/peerTransport.js'
import { requestAgentFleetAction } from '../../utils/udsClient.js'
import type {
  AgentFleetAction,
  AgentFleetActionResult,
  AgentFleetRecord,
} from './types.js'

export type AgentFleetActionOwners = {
  stop: typeof killHandler
  logs: typeof logsHandler
  attach: typeof attachHandler
  listLive: typeof listLiveSessions
  discover: (target: string) => Promise<PeerRoster>
  sendPeer: typeof sendCrossSessionPeer
  requestOwnerAction: typeof requestAgentFleetAction
  createMessageId: () => string
  getSessionId: () => string
  reload?: (
    record: AgentFleetRecord,
  ) => AgentFleetRecord | undefined | Promise<AgentFleetRecord | undefined>
  message?: (record: AgentFleetRecord, content: string) => Promise<void>
  resume?: (record: AgentFleetRecord, prompt: string) => Promise<void>
  retry?: (record: AgentFleetRecord, prompt: string) => Promise<void>
  stopRecord?: (record: AgentFleetRecord) => Promise<void>
  logsRecord?: (record: AgentFleetRecord) => Promise<string | undefined>
  cleanupRecord?: (record: AgentFleetRecord) => Promise<void>
}

const defaultOwners: AgentFleetActionOwners = {
  stop: killHandler,
  logs: logsHandler,
  attach: attachHandler,
  listLive: listLiveSessions,
  discover: target =>
    discoverPeerRosterForTarget(
      { agentNameRegistry: new Map(), tasks: {} },
      target,
    ),
  sendPeer: sendCrossSessionPeer,
  requestOwnerAction: requestAgentFleetAction,
  createMessageId: randomUUID,
  getSessionId,
}

function matchingPeer(
  roster: PeerRoster,
  record: AgentFleetRecord,
): PeerCandidate | undefined {
  return roster.candidates.find(
    candidate =>
      candidate.transport === record.transport &&
      ((record.ref !== undefined && candidate.ref === record.ref) ||
        (record.address !== undefined &&
          candidate.address === record.address) ||
        (record.sessionId !== undefined &&
          candidate.sessionId === record.sessionId) ||
        (record.rawId !== undefined && candidate.id === record.rawId)),
  )
}

function localRecordOwner(
  action: AgentFleetAction,
  overrides: Partial<AgentFleetActionOwners>,
): boolean {
  switch (action.type) {
    case 'message':
      return overrides.message !== undefined
    case 'resume':
      return overrides.resume !== undefined
    case 'retry':
      return overrides.retry !== undefined
    case 'stop':
      return overrides.stopRecord !== undefined
    case 'logs':
      return overrides.logsRecord !== undefined
    case 'cleanup':
      return overrides.cleanupRecord !== undefined
    case 'attach':
      return false
  }
}

async function dispatchOwnerAction(
  record: AgentFleetRecord,
  action: AgentFleetAction,
  owners: AgentFleetActionOwners,
): Promise<AgentFleetActionResult> {
  const roster = await owners.discover(record.ownerSessionId ?? '')
  const owner = roster.candidates.find(
    candidate =>
      candidate.transport === 'uds' &&
      (candidate.sessionId === record.ownerSessionId ||
        candidate.id === record.ownerSessionId),
  )
  if (!owner?.address) {
    return {
      ok: false,
      code: 'owner-unavailable',
      message: `Owner ${record.ownerSessionId} is not reachable.`,
    }
  }
  return owners.requestOwnerAction(owner.address, action)
}

async function sendRecordMessage(
  record: AgentFleetRecord,
  content: string,
  owners: AgentFleetActionOwners,
): Promise<void> {
  const target =
    record.address ??
    (record.socketPath ? `uds:${record.socketPath}` : undefined)
  if (!target) throw new Error(`Agent ${record.id} has no peer address`)
  const roster = await owners.discover(target)
  const candidate = matchingPeer(roster, record)
  if (!candidate) throw new Error(`Agent ${record.id} is not reachable`)
  await owners.sendPeer(candidate, {
    content,
    msgId: owners.createMessageId(),
    fromMode: 'prompting',
    sessionId: owners.getSessionId(),
  })
}

function stale(
  record: AgentFleetRecord,
  action: AgentFleetAction,
): AgentFleetActionResult | undefined {
  if (
    record.revision !== action.revision ||
    record.updatedAt !== action.updatedAt
  ) {
    return {
      ok: false,
      code: 'stale',
      message: `Agent ${record.id} changed; refresh the Fleet list and try again.`,
    }
  }
  if (!record.capabilities.includes(action.type)) {
    return {
      ok: false,
      code: 'unsupported',
      message: `Action ${action.type} is not available for ${record.id}.`,
    }
  }
  return undefined
}

export async function dispatchAgentFleetAction(
  record: AgentFleetRecord | undefined,
  action: AgentFleetAction,
  ownerOverrides: Partial<AgentFleetActionOwners> = {},
): Promise<AgentFleetActionResult> {
  const owners = { ...defaultOwners, ...ownerOverrides }
  if (!record)
    return {
      ok: false,
      code: 'not-found',
      message: `Agent ${action.id} was not found.`,
    }
  const submitted = stale(record, action)
  if (submitted) return submitted
  let current = record
  try {
    current = (await owners.reload?.(record)) ?? record
  } catch (error) {
    return {
      ok: false,
      code: 'owner-unavailable',
      message: error instanceof Error ? error.message : String(error),
    }
  }
  const validation = stale(current, action)
  if (validation) return validation
  try {
    if (current.ownerSessionId && !localRecordOwner(action, ownerOverrides)) {
      return await dispatchOwnerAction(current, action, owners)
    }
    const target = current.sessionId ?? String(current.pid ?? current.id)
    switch (action.type) {
      case 'message':
        if (owners.message) await owners.message(current, action.content)
        else await sendRecordMessage(current, action.content, owners)
        return { ok: true, action: action.type, id: current.id }
      case 'resume':
        if (!owners.resume) return unsupported(current, action)
        await owners.resume(current, action.prompt)
        return { ok: true, action: action.type, id: current.id }
      case 'retry':
        if (!owners.retry) return unsupported(current, action)
        await owners.retry(current, action.prompt)
        return { ok: true, action: action.type, id: current.id }
      case 'stop':
        if (owners.stopRecord) await owners.stopRecord(current)
        else await owners.stop(target)
        return { ok: true, action: action.type, id: current.id }
      case 'logs': {
        if (owners.logsRecord) {
          const output = await owners.logsRecord(current)
          return { ok: true, action: action.type, id: current.id, output }
        }
        await owners.logs(target)
        return { ok: true, action: action.type, id: current.id }
      }
      case 'attach':
        await owners.attach(target)
        return { ok: true, action: action.type, id: current.id }
      case 'cleanup': {
        if (owners.cleanupRecord) {
          await owners.cleanupRecord(current)
          return { ok: true, action: action.type, id: current.id }
        }
        const live = await owners.listLive()
        if (!live.some(session => session.sessionId === current.sessionId)) {
          return { ok: true, action: action.type, id: current.id }
        }
        await owners.stop(target)
        return { ok: true, action: action.type, id: current.id }
      }
    }
  } catch (error) {
    return {
      ok: false,
      code: 'transport-error',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

function unsupported(
  record: AgentFleetRecord,
  action: AgentFleetAction,
): AgentFleetActionResult {
  return {
    ok: false,
    code: 'unsupported',
    message: `Action ${action.type} has no owner for ${record.id}.`,
  }
}
