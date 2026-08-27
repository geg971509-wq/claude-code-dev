import { createHash } from 'node:crypto'

export type PeerTransport =
  | 'in-process'
  | 'mailbox'
  | 'uds'
  | 'cloud'
  | 'bridge'

export type PeerKind =
  | 'main'
  | 'subagent'
  | 'teammate'
  | 'local-session'
  | 'cloud-session'
  | 'bridge-session'

export type PeerUnavailableReason =
  | 'unreadable'
  | 'timeout'
  | 'fetch_failed'
  | 'not_configured'

export type PeerSourceRecord = {
  kind: PeerKind
  transport: PeerTransport
  id: string
  name?: string
  address?: string
  sessionId?: string
  bridgeSessionId?: string | null
  status?: string
  cwd?: string
  lastActive?: number
  canReply?: boolean
}

export type PeerCandidate = Omit<PeerSourceRecord, 'name'> & {
  name: string
  ref: string
  mirroredTransports: PeerTransport[]
}

export type PeerUnavailableSources = Partial<
  Record<'local' | 'cloud' | 'bridge', PeerUnavailableReason>
>

export type PeerRoster = {
  candidates: PeerCandidate[]
  byName: Map<string, PeerCandidate[]>
  unavailable: PeerUnavailableSources
}

export type PeerRosterSources = {
  main?: PeerSourceRecord[]
  inProcess?: PeerSourceRecord[]
  team?: PeerSourceRecord[]
  local?: PeerSourceRecord[]
  cloud?: PeerSourceRecord[]
  bridge?: PeerSourceRecord[]
  selfIds?: string[]
  unavailable?: PeerUnavailableSources
}

export type PeerResolution =
  | { kind: 'resolved'; candidate: PeerCandidate }
  | { kind: 'ambiguous'; candidates: PeerCandidate[] }
  | { kind: 'not-found'; unavailable: PeerUnavailableSources }

const MIN_REF_LENGTH = 4
const MIN_NAME_PREFIX_LENGTH = 3
const MAX_AMBIGUITY_CANDIDATES = 3

const TRANSPORT_ORDER: Record<PeerTransport, number> = {
  'in-process': 0,
  mailbox: 1,
  uds: 2,
  cloud: 3,
  bridge: 4,
}

export function normalizePeerName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
}

function isSafePeerName(name: string): boolean {
  const normalized = normalizePeerName(name)
  return (
    normalized.length > 0 &&
    normalized !== '*' &&
    !normalized.includes('@') &&
    !normalized.startsWith('/') &&
    !/^(?:uds|bridge|cloud|tcp):/i.test(normalized)
  )
}

function fallbackName(record: PeerSourceRecord): string {
  const suffix = normalizePeerName(record.id).replace(/[^a-z0-9_-]/g, '')
  return `${record.kind}-${suffix.slice(-6) || 'unknown'}`
}

function displayName(record: PeerSourceRecord): string {
  const name = record.name?.trim()
  return name && isSafePeerName(name) ? name : fallbackName(record)
}

function sessionBody(id: string | null | undefined): string | undefined {
  if (!id) return undefined
  return id.replace(/^(?:session_|cse_)/, '')
}

function stableIdentity(record: PeerSourceRecord): string {
  return `${record.kind}:${record.id}`
}

function refHash(record: PeerSourceRecord): string {
  return createHash('sha256').update(stableIdentity(record)).digest('hex')
}

function assignRefs(records: PeerSourceRecord[]): PeerCandidate[] {
  const hashes = records.map(refHash)
  return records.map((record, index) => {
    const hash = hashes[index]!
    let length = MIN_REF_LENGTH
    while (
      length < hash.length &&
      hashes.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          other.slice(0, length) === hash.slice(0, length),
      )
    ) {
      length++
    }
    return {
      ...record,
      name: displayName(record),
      ref: hash.slice(0, length),
      mirroredTransports: [],
    }
  })
}

function recordMatchesSelf(record: PeerSourceRecord, selfIds: Set<string>) {
  return (
    selfIds.has(record.id) ||
    (record.sessionId !== undefined && selfIds.has(record.sessionId)) ||
    (record.bridgeSessionId != null && selfIds.has(record.bridgeSessionId))
  )
}

export function buildPeerRoster(sources: PeerRosterSources): PeerRoster {
  const selfIds = new Set(sources.selfIds ?? [])
  const records: PeerSourceRecord[] = []
  const localKeys = new Set<string>()
  const remoteBySession = new Map<string, number>()
  const localByRemoteSession = new Map<string, number>()

  const add = (record: PeerSourceRecord): number | undefined => {
    if (recordMatchesSelf(record, selfIds)) return undefined
    records.push(record)
    return records.length - 1
  }

  for (const record of sources.main ?? []) add(record)
  for (const record of sources.inProcess ?? []) add(record)
  for (const record of sources.team ?? []) add(record)

  for (const record of sources.local ?? []) {
    const key = `${normalizePeerName(displayName(record))}\0${record.address ?? ''}`
    if (localKeys.has(key)) continue
    localKeys.add(key)
    const index = add(record)
    if (index === undefined) continue
    const remoteBody = sessionBody(record.bridgeSessionId ?? record.sessionId)
    if (remoteBody) localByRemoteSession.set(remoteBody, index)
  }

  const addRemote = (record: PeerSourceRecord) => {
    if (recordMatchesSelf(record, selfIds)) return
    const body = sessionBody(record.sessionId ?? record.id)
    if (body) {
      const localIndex = localByRemoteSession.get(body)
      if (localIndex !== undefined) {
        const local = records[localIndex]!
        const mirrors = new Set(
          (local as PeerCandidate).mirroredTransports ?? [],
        )
        mirrors.add(record.transport)
        ;(local as PeerCandidate).mirroredTransports = [...mirrors]
        return
      }
      const existingIndex = remoteBySession.get(body)
      if (existingIndex !== undefined) {
        const existing = records[existingIndex]!
        const mirrors = new Set(
          (existing as PeerCandidate).mirroredTransports ?? [],
        )
        mirrors.add(record.transport)
        ;(existing as PeerCandidate).mirroredTransports = [...mirrors]
        return
      }
    }
    const index = add(record)
    if (index !== undefined && body) remoteBySession.set(body, index)
  }

  for (const record of sources.cloud ?? []) addRemote(record)
  for (const record of sources.bridge ?? []) addRemote(record)

  const preassignedMirrors = new Map<string, PeerTransport[]>()
  for (const record of records) {
    const mirrors = (record as PeerCandidate).mirroredTransports
    if (mirrors?.length) preassignedMirrors.set(stableIdentity(record), mirrors)
  }

  const candidates = assignRefs(records)
    .map(candidate => ({
      ...candidate,
      mirroredTransports:
        preassignedMirrors.get(stableIdentity(candidate)) ?? [],
    }))
    .sort((left, right) => {
      const transport =
        TRANSPORT_ORDER[left.transport] - TRANSPORT_ORDER[right.transport]
      if (transport !== 0) return transport
      const name = normalizePeerName(left.name).localeCompare(
        normalizePeerName(right.name),
      )
      return name !== 0 ? name : left.ref.localeCompare(right.ref)
    })

  const byName = new Map<string, PeerCandidate[]>()
  for (const candidate of candidates) {
    const name = normalizePeerName(candidate.name)
    const matches = byName.get(name) ?? []
    matches.push(candidate)
    byName.set(name, matches)
  }

  return {
    candidates,
    byName,
    unavailable: { ...(sources.unavailable ?? {}) },
  }
}

export function formatPeerAddress(name: string, ref: string): string {
  return `${name} [${ref}]`
}

function parsePeerTarget(target: string): { name: string; ref?: string } {
  const trimmed = target.trim()
  const match = /^(.*?)\s+\[([a-z0-9_-]{3,64})\]$/i.exec(trimmed)
  return match
    ? { name: match[1]!.trim(), ref: match[2]!.toLowerCase() }
    : { name: trimmed }
}

function resolved(matches: PeerCandidate[]): PeerResolution {
  if (matches.length === 1) {
    return { kind: 'resolved', candidate: matches[0]! }
  }
  return {
    kind: 'ambiguous',
    candidates: matches.slice(0, MAX_AMBIGUITY_CANDIDATES),
  }
}

export function resolvePeerTarget(
  roster: PeerRoster,
  target: string,
): PeerResolution {
  const parsed = parsePeerTarget(target)
  const normalized = normalizePeerName(parsed.name)

  if (!parsed.ref) {
    const byId = roster.candidates.filter(
      candidate =>
        candidate.id === parsed.name && candidate.transport === 'in-process',
    )
    if (byId.length > 0) return resolved(byId)
  }

  if (parsed.ref) {
    const matches = roster.candidates.filter(candidate => {
      return (
        candidate.ref === parsed.ref &&
        normalizePeerName(candidate.name) === normalized
      )
    })
    if (matches.length > 0) return resolved(matches)
    return { kind: 'not-found', unavailable: roster.unavailable }
  }

  const exact = roster.byName.get(normalized) ?? []
  if (exact.length > 0) {
    const inProcess = exact.filter(
      candidate => candidate.transport === 'in-process',
    )
    return resolved(inProcess.length > 0 ? inProcess : exact)
  }

  if (normalized.length >= MIN_NAME_PREFIX_LENGTH) {
    const prefixMatches = roster.candidates.filter(candidate =>
      normalizePeerName(candidate.name).startsWith(normalized),
    )
    if (prefixMatches.length > 0) return resolved(prefixMatches)
  }

  return { kind: 'not-found', unavailable: roster.unavailable }
}
