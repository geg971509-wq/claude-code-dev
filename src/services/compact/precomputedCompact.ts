import type { CompactionStateEvent } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { logError } from '../../utils/log.js'
import { roughTokenCountEstimationForMessages } from '../tokenEstimation.js'
import type { PreparedCompactSummary } from './compact.js'
import {
  createPrecomputedCompactStore,
  type PrecomputedCompactStore,
} from './precomputedCompactStore.js'

export type PrecomputedCompactStatus = 'pending' | 'ready' | 'failed'

export type PrecomputedCompactTransition = {
  state: Extract<
    CompactionStateEvent['state'],
    'ready' | 'rehydrated' | 'discarded' | 'failed'
  >
  reason: string
  preCompactTokens?: number
}

export type PrecomputedCompactEntry = {
  key: string
  status: PrecomputedCompactStatus
  sessionId: string
  model: string
  precomputedAtUuid: string
  preservedUuids: string[]
  preCompactTokens: number
  createdAt: number
  result?: PreparedCompactSummary
  error?: string
}

type ReadyEntry = PrecomputedCompactEntry & { result: PreparedCompactSummary }
type Producer = (signal: AbortSignal) => Promise<ReadyEntry>
type TransitionSink = (event: PrecomputedCompactTransition) => void
type RehydrateOptions = {
  now?: number
  onTransition?: TransitionSink
}
type ActiveProducer = {
  generation: number
  controller: AbortController
  settled: Promise<void>
}

const MAX_FAILURES = 3
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_FUTURE_MS = 60_000
const MAX_GROWTH_TOKENS = 150_000
const managers = new Map<string, PrecomputedCompactManager>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function uuidOf(message: Message): string | undefined {
  return typeof message.uuid === 'string' ? message.uuid : undefined
}

function isMessage(value: unknown): value is Message {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    typeof value.uuid === 'string'
  )
}

function isPreparedCompactSummary(
  value: unknown,
): value is PreparedCompactSummary {
  if (
    !isRecord(value) ||
    !isMessage(value.summaryResponse) ||
    value.summaryResponse.type !== 'assistant' ||
    typeof value.summary !== 'string' ||
    value.summary.length === 0 ||
    typeof value.preservedUserSection !== 'string'
  ) {
    return false
  }
  return (
    Array.isArray(value.messagesToKeep) && value.messagesToKeep.every(isMessage)
  )
}

function parseTimestamp(value: unknown): number | undefined {
  const timestamp =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Date.parse(value)
        : Number.NaN
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function parseStoredEntry(value: unknown): ReadyEntry | undefined {
  if (!isRecord(value)) return undefined
  const createdAt = parseTimestamp(value.createdAt)
  if (
    value.status !== 'ready' ||
    typeof value.key !== 'string' ||
    value.key.length === 0 ||
    typeof value.sessionId !== 'string' ||
    typeof value.model !== 'string' ||
    typeof value.precomputedAtUuid !== 'string' ||
    !Array.isArray(value.preservedUuids) ||
    !value.preservedUuids.every(uuid => typeof uuid === 'string') ||
    typeof value.preCompactTokens !== 'number' ||
    !Number.isFinite(value.preCompactTokens) ||
    value.preCompactTokens < 0 ||
    createdAt === undefined ||
    !isPreparedCompactSummary(value.result)
  ) {
    return undefined
  }
  return {
    key: value.key,
    status: 'ready',
    sessionId: value.sessionId,
    model: value.model,
    precomputedAtUuid: value.precomputedAtUuid,
    preservedUuids: [...value.preservedUuids],
    preCompactTokens: value.preCompactTokens,
    createdAt,
    result: value.result,
  }
}

function contentBlocks(message: Message): readonly unknown[] {
  return Array.isArray(message.message?.content) ? message.message.content : []
}

function isCompactBoundary(message: Message): boolean {
  return message.type === 'system' && message.subtype === 'compact_boundary'
}

function hasContinuousParents(anchor: Message, suffix: Message[]): boolean {
  if (!suffix.some(message => 'parentUuid' in message)) return true
  let parent = uuidOf(anchor)
  for (const message of suffix) {
    if (message.parentUuid !== parent) return false
    parent = uuidOf(message)
  }
  return true
}

function hasCompleteApiRounds(suffix: Message[]): boolean {
  const pendingToolUses = new Set<string>()
  let awaitingAssistant = false
  let awaitingHumanResponse = false
  let lastAssistantId: string | undefined
  for (const message of suffix) {
    const blocks = contentBlocks(message)
    if (message.type === 'assistant') {
      const assistantId = message.message?.id ?? uuidOf(message)
      if (
        assistantId !== lastAssistantId &&
        lastAssistantId !== undefined &&
        pendingToolUses.size > 0
      ) {
        return false
      }
      lastAssistantId = assistantId
      awaitingAssistant = false
      awaitingHumanResponse = false
    } else if (
      message.type === 'user' &&
      !blocks.some(block => isRecord(block) && block.type === 'tool_result')
    ) {
      if (awaitingHumanResponse) return false
      awaitingHumanResponse = true
    }
    for (const block of blocks) {
      if (!isRecord(block)) continue
      if (block.type === 'tool_use') {
        if (typeof block.id !== 'string' || pendingToolUses.has(block.id))
          return false
        pendingToolUses.add(block.id)
      } else if (block.type === 'tool_result') {
        if (
          typeof block.tool_use_id !== 'string' ||
          !pendingToolUses.delete(block.tool_use_id)
        ) {
          return false
        }
        awaitingAssistant = true
      }
    }
  }
  return pendingToolUses.size === 0 && !awaitingAssistant
}

function validChain(entry: ReadyEntry, messages: Message[]): boolean {
  const anchors = messages
    .map((message, index) => ({ message, index }))
    .filter(item => uuidOf(item.message) === entry.precomputedAtUuid)
  if (anchors.length !== 1) return false
  const anchor = anchors[0]
  if (!anchor) return false
  const suffix = messages.slice(anchor.index + 1)
  return (
    !suffix.some(isCompactBoundary) &&
    hasContinuousParents(anchor.message, suffix) &&
    hasCompleteApiRounds(suffix)
  )
}

export function mergePrecomputedResult(
  entry: PrecomputedCompactEntry,
  messages: Message[],
): PreparedCompactSummary | undefined {
  if (!entry.result) return undefined
  const anchorIndex = messages.findIndex(
    message => uuidOf(message) === entry.precomputedAtUuid,
  )
  if (anchorIndex < 0) return undefined

  const existing = entry.result.messagesToKeep ?? []
  const existingByUuid = new Map(
    existing.flatMap(message => {
      const uuid = uuidOf(message)
      return uuid ? [[uuid, message] as const] : []
    }),
  )
  const retained = new Set(entry.preservedUuids)
  const seen = new Set<string>()
  const messagesToKeep = messages.flatMap((message, index) => {
    const uuid = uuidOf(message)
    if (
      !uuid ||
      seen.has(uuid) ||
      (index <= anchorIndex && !retained.has(uuid))
    ) {
      return []
    }
    seen.add(uuid)
    return [existingByUuid.get(uuid) ?? message]
  })
  return { ...entry.result, messagesToKeep }
}

export class PrecomputedCompactManager {
  private readonly entries = new Map<string, PrecomputedCompactEntry>()
  private readonly active = new Map<string, ActiveProducer>()
  private readonly transitions = new Map<string, TransitionSink>()
  private readonly store: PrecomputedCompactStore
  private consecutiveFailures = 0
  private generation = 0
  private rehydrateAttempted = false

  constructor(
    private readonly sessionId: string,
    private readonly persist = true,
    store: PrecomputedCompactStore = createPrecomputedCompactStore(sessionId),
  ) {
    this.store = store
  }

  async rehydrate(
    model: string,
    messages: Message[],
    options: RehydrateOptions = {},
  ): Promise<boolean> {
    if (!this.persist || this.rehydrateAttempted) return false
    this.rehydrateAttempted = true
    let stored: unknown
    try {
      stored = await this.store.read()
    } catch (error) {
      logError(error)
      return false
    }
    const entry = parseStoredEntry(stored)
    if (
      !entry ||
      entry.key !== 'main' ||
      !this.validateEntry(entry, model, messages, options.now ?? Date.now())
    ) {
      if (entry) {
        options.onTransition?.({
          state: 'discarded',
          reason: 'precompute_discarded',
        })
      }
      await this.clearPersisted()
      return false
    }
    this.entries.set(entry.key, entry)
    if (options.onTransition) {
      this.transitions.set(entry.key, options.onTransition)
    }
    this.emitTransition(entry.key, {
      state: 'rehydrated',
      reason: 'precompute_rehydrated',
      preCompactTokens: entry.preCompactTokens,
    })
    return true
  }

  async arm(
    key: string,
    producer: Producer,
    onTransition?: TransitionSink,
  ): Promise<boolean> {
    if (this.consecutiveFailures >= MAX_FAILURES || this.entries.has(key))
      return false
    if (onTransition) this.transitions.set(key, onTransition)
    const generation = ++this.generation
    const controller = new AbortController()
    this.entries.set(key, {
      key,
      status: 'pending',
      sessionId: this.sessionId,
      model: '',
      precomputedAtUuid: '',
      preservedUuids: [],
      preCompactTokens: 0,
      createdAt: Date.now(),
    })

    const settled = Promise.resolve()
      .then(() => producer(controller.signal))
      .then(async result => {
        if (!this.isCurrent(key, generation) || controller.signal.aborted)
          return
        const ready: ReadyEntry = {
          ...result,
          key,
          sessionId: this.sessionId,
          status: 'ready',
        }
        this.entries.set(key, ready)
        this.consecutiveFailures = 0
        this.emitTransition(key, {
          state: 'ready',
          reason: 'precompute_ready',
          preCompactTokens: ready.preCompactTokens,
        })
        if (this.persists(key)) {
          try {
            await this.store.write(ready)
          } catch (error) {
            logError(error)
          }
        }
      })
      .catch(async error => {
        if (!this.isCurrent(key, generation) || controller.signal.aborted)
          return
        this.consecutiveFailures++
        const current = this.entries.get(key)
        if (current) {
          this.entries.set(key, {
            ...current,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          })
          this.emitTransition(key, {
            state: 'failed',
            reason: 'precompute_failed',
          })
        }
        if (this.persists(key)) await this.clearPersisted()
      })
      .finally(() => {
        if (this.isCurrent(key, generation)) this.active.delete(key)
      })
    this.active.set(key, { generation, controller, settled })
    return true
  }

  get(key: string): PrecomputedCompactEntry | undefined {
    return this.entries.get(key)
  }

  async borrow(
    key: string,
    signal?: AbortSignal,
  ): Promise<PrecomputedCompactEntry | undefined> {
    const current = this.entries.get(key)
    if (!current || current.status !== 'pending') return current
    const active = this.active.get(key)
    if (!active) return undefined
    if (signal?.aborted) return undefined
    if (signal) {
      await Promise.race([
        active.settled,
        new Promise<void>(resolve =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        ),
      ])
      if (signal.aborted) return undefined
    } else {
      await active.settled
    }
    return this.entries.get(key)
  }

  wait(key: string): Promise<PrecomputedCompactEntry | undefined> {
    return this.borrow(key)
  }

  async consume(
    key: string,
    model: string,
    messages: Message[],
    now = Date.now(),
    signal?: AbortSignal,
  ): Promise<PrecomputedCompactEntry | undefined> {
    const borrowed = await this.borrow(key, signal)
    if (signal?.aborted) return undefined
    const entry = borrowed && parseStoredEntry(borrowed)
    if (
      !entry ||
      !this.validateEntry(entry, model, messages, now) ||
      !validChain(entry, messages)
    ) {
      await this.discard(key)
      return undefined
    }
    this.entries.delete(key)
    this.active.delete(key)
    this.transitions.delete(key)
    ++this.generation
    if (this.persists(key)) await this.clearPersisted()
    return entry
  }

  async discard(key: string): Promise<void> {
    const hadEntry = this.entries.has(key)
    const active = this.active.get(key)
    active?.controller.abort()
    this.active.delete(key)
    this.entries.delete(key)
    if (hadEntry) {
      this.emitTransition(key, {
        state: 'discarded',
        reason: 'precompute_discarded',
      })
    }
    this.transitions.delete(key)
    ++this.generation
    if (this.persists(key)) await this.clearPersisted()
  }

  async cleanup(): Promise<void> {
    ++this.generation
    for (const active of this.active.values()) active.controller.abort()
    for (const key of this.entries.keys()) {
      this.emitTransition(key, {
        state: 'discarded',
        reason: 'precompute_discarded',
      })
    }
    this.active.clear()
    this.entries.clear()
    this.transitions.clear()
    if (this.persist) await this.clearPersisted()
  }

  async shutdown(): Promise<void> {
    ++this.generation
    for (const active of this.active.values()) active.controller.abort()
    this.active.clear()
    this.entries.clear()
    this.transitions.clear()
  }

  private isCurrent(key: string, generation: number): boolean {
    return this.active.get(key)?.generation === generation
  }

  private persists(key: string): boolean {
    return this.persist && key === 'main'
  }

  private emitTransition(
    key: string,
    event: PrecomputedCompactTransition,
  ): void {
    try {
      this.transitions.get(key)?.(event)
    } catch (error) {
      logError(error)
    }
  }

  private async clearPersisted(): Promise<void> {
    try {
      await this.store.clear()
    } catch (error) {
      logError(error)
    }
  }

  private validateEntry(
    entry: ReadyEntry,
    model: string,
    messages: Message[],
    now: number,
  ): boolean {
    if (entry.sessionId !== this.sessionId || entry.model !== model)
      return false
    if (
      now - entry.createdAt > MAX_AGE_MS ||
      entry.createdAt > now + MAX_FUTURE_MS
    ) {
      return false
    }
    const anchors = messages.filter(
      message => uuidOf(message) === entry.precomputedAtUuid,
    )
    if (anchors.length !== 1) return false
    const uuids = new Set(messages.flatMap(message => uuidOf(message) ?? []))
    if (new Set(entry.preservedUuids).size !== entry.preservedUuids.length)
      return false
    if (!entry.preservedUuids.every(uuid => uuids.has(uuid))) return false
    const keptUuids = (entry.result.messagesToKeep ?? []).map(uuidOf)
    if (
      keptUuids.some(uuid => uuid === undefined) ||
      keptUuids.length !== entry.preservedUuids.length ||
      !keptUuids.every(uuid => uuid && entry.preservedUuids.includes(uuid))
    ) {
      return false
    }
    const currentTokens = roughTokenCountEstimationForMessages(
      messages as Parameters<typeof roughTokenCountEstimationForMessages>[0],
    )
    return (
      currentTokens <= entry.preCompactTokens + MAX_GROWTH_TOKENS &&
      currentTokens >= entry.preCompactTokens * 0.5
    )
  }
}

export function getPrecomputedCompactManager(
  sessionId: string,
  persist = true,
): PrecomputedCompactManager {
  const existing = managers.get(sessionId)
  if (existing) return existing
  const manager = new PrecomputedCompactManager(sessionId, persist)
  managers.set(sessionId, manager)
  return manager
}

export async function shutdownPrecomputedCompactManagers(): Promise<void> {
  const current = [...managers.values()]
  managers.clear()
  await Promise.all(current.map(manager => manager.shutdown()))
}

export async function discardPrecomputedCompactForSession(
  sessionId: string,
  key = 'main',
): Promise<void> {
  await managers.get(sessionId)?.discard(key)
}

registerCleanup(shutdownPrecomputedCompactManagers)
