import { randomUUID } from 'crypto'
import { appendFileSync, chmodSync, mkdirSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { getSessionId } from '../../../bootstrap/state.js'
import {
  type BufferedWriter,
  createBufferedWriter,
} from '../../../utils/bufferedWriter.js'
import { registerCleanup } from '../../../utils/cleanupRegistry.js'
import { getClaudeConfigHomeDir } from '../../../utils/envUtils.js'

export type OpenAIRawStreamRoute =
  | 'chat-completions'
  | 'chatgpt-responses'
  | 'official-responses'

export type RawStreamContext = {
  route: OpenAIRawStreamRoute
  model: string
  source?: string
  streamId?: string
  requestAttempt?: number
  streamAttempt?: number
  status?: string
  requestId?: string
}

export type RawStreamLifecycleContext = RawStreamContext &
  (
    | {
        lifecycle: 'retry'
        phase: 'request' | 'stream'
        attempt: number
        maxRetries: number
        delayMs: number
        error: unknown
      }
    | {
        lifecycle: 'error'
        phase: 'request' | 'stream'
        eventCount?: number
        error: unknown
      }
  )

type RawStreamMetadata = {
  sessionId: string
  streamId: string
  route: OpenAIRawStreamRoute
  protocol: 'chat-completions' | 'responses'
  model: string
  source: string | null
  requestAttempt: number | null
  streamAttempt: number | null
  status: string | null
  requestId: string | null
}

type SafeErrorDiagnostics = {
  name?: string
  message?: string
  status?: number
  statusCode?: number
  requestId?: string
  code?: string | number
  type?: string
  param?: string
  bodyPreview?: string
  incompleteReason?: string
}

type TestOverrides = {
  enabled?: boolean
  path?: string
  argv?: readonly string[]
}

type WriterEntry = {
  writer: BufferedWriter
  users: number
}

const writers = new Map<string, WriterEntry>()
let cleanupRegistered = false
let testOverrides: TestOverrides | null = null

export function isOpenAIRawStreamLoggingEnabled(
  argv: readonly string[] = process.argv,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
  const effectiveArgv = testOverrides?.argv ?? argv
  if (effectiveArgv.includes('--no-openai-raw-log')) return false
  if (testOverrides?.enabled !== undefined) return testOverrides.enabled
  return nodeEnv !== 'test'
}

export function getOpenAIRawStreamLogPath(): string {
  if (testOverrides?.path) return testOverrides.path

  const sessionId = getSessionId()
  const logDir = process.env.CLAUDE_CODE_DEBUG_LOGS_DIR
    ? resolve(process.env.CLAUDE_CODE_DEBUG_LOGS_DIR)
    : join(getClaudeConfigHomeDir(), 'debug')
  return join(logDir, `${sessionId}.openai.jsonl`)
}

function createWriter(path: string): BufferedWriter {
  let permissionsReady = false
  return createBufferedWriter({
    writeFn: content => {
      const dir = dirname(path)
      try {
        if (!permissionsReady) {
          mkdirSync(dir, { recursive: true, mode: 0o700 })
          chmodSync(dir, 0o700)
        }
      } catch {
        return
      }

      try {
        appendFileSync(path, content, { mode: 0o600 })
      } catch {
        return
      }

      permissionsReady = true
      try {
        chmodSync(path, 0o600)
      } catch {
        // Best-effort permission hardening must not duplicate the batch.
      }
    },
    flushIntervalMs: 1000,
    maxBufferSize: 50,
    maxBufferBytes: 64 * 1024,
  })
}

function acquireWriter(path: string): WriterEntry {
  let entry = writers.get(path)
  if (!entry) {
    entry = { writer: createWriter(path), users: 0 }
    writers.set(path, entry)
  }
  entry.users++

  if (!cleanupRegistered) {
    cleanupRegistered = true
    registerCleanup(async () => {
      for (const currentEntry of writers.values()) {
        try {
          currentEntry.writer.dispose()
        } catch {
          // Raw stream diagnostics must never interrupt shutdown.
        }
      }
    })
  }

  return entry
}

function releaseWriter(path: string, entry: WriterEntry): void {
  entry.users--
  if (entry.users > 0) return

  try {
    entry.writer.dispose()
  } catch {
    // Raw stream diagnostics must never interrupt stream cleanup.
  }
  if (writers.get(path) === entry) writers.delete(path)
}

function logRawEvent(
  writer: BufferedWriter,
  entry: Record<string, unknown>,
): void {
  try {
    writer.write(`${JSON.stringify(entry)}\n`)
  } catch {
    // Serialization and writer setup are best-effort diagnostics.
  }
}

function truncateString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, 500) : undefined
}

function safeErrorDiagnostics(error: unknown): SafeErrorDiagnostics {
  try {
    if (typeof error === 'string') return { message: error.slice(0, 500) }
    if (error == null || typeof error !== 'object') return {}

    const details = error as Record<string, unknown>
    const providerError =
      details.error != null && typeof details.error === 'object'
        ? (details.error as Record<string, unknown>)
        : undefined
    const incompleteDetails =
      details.incomplete_details != null &&
      typeof details.incomplete_details === 'object'
        ? (details.incomplete_details as Record<string, unknown>)
        : undefined
    const providerIncompleteDetails =
      providerError?.incomplete_details != null &&
      typeof providerError.incomplete_details === 'object'
        ? (providerError.incomplete_details as Record<string, unknown>)
        : undefined
    const diagnostics: SafeErrorDiagnostics = {}
    const name = truncateString(details.name)
    const message = truncateString(details.message ?? providerError?.message)
    const requestId = truncateString(
      details.requestId ??
        details.request_id ??
        providerError?.requestId ??
        providerError?.request_id,
    )
    const code = details.code ?? providerError?.code
    const type = truncateString(details.type ?? providerError?.type)
    const param = truncateString(details.param ?? providerError?.param)
    const bodyPreview = truncateString(
      details.bodyPreview ?? providerError?.bodyPreview,
    )
    const incompleteReason = truncateString(
      details.incompleteReason ??
        incompleteDetails?.reason ??
        providerError?.incompleteReason ??
        providerIncompleteDetails?.reason,
    )

    if (name !== undefined) diagnostics.name = name
    if (message !== undefined) diagnostics.message = message
    if (typeof details.status === 'number') diagnostics.status = details.status
    if (typeof details.statusCode === 'number') {
      diagnostics.statusCode = details.statusCode
    }
    if (requestId !== undefined) diagnostics.requestId = requestId
    if (typeof code === 'string') diagnostics.code = code.slice(0, 500)
    else if (typeof code === 'number') diagnostics.code = code
    if (type !== undefined) diagnostics.type = type
    if (param !== undefined) diagnostics.param = param
    if (bodyPreview !== undefined) diagnostics.bodyPreview = bodyPreview
    if (incompleteReason !== undefined) {
      diagnostics.incompleteReason = incompleteReason
    }
    return diagnostics
  } catch {
    return {}
  }
}

function createMetadata(context: RawStreamContext): RawStreamMetadata {
  return {
    sessionId: getSessionId(),
    streamId: context.streamId ?? randomUUID(),
    route: context.route,
    protocol:
      context.route === 'chat-completions' ? 'chat-completions' : 'responses',
    model: context.model,
    source: context.source ?? null,
    requestAttempt: context.requestAttempt ?? null,
    streamAttempt: context.streamAttempt ?? null,
    status: context.status ?? null,
    requestId: context.requestId ?? null,
  }
}

function observeCompletionStatus(event: unknown): string | undefined {
  try {
    if (event == null || typeof event !== 'object') return undefined
    const rawEvent = event as Record<string, unknown>
    const response =
      rawEvent.response != null && typeof rawEvent.response === 'object'
        ? (rawEvent.response as Record<string, unknown>)
        : undefined
    if (typeof response?.status === 'string') return response.status
    if (Array.isArray(rawEvent.choices)) {
      for (const choice of rawEvent.choices) {
        if (choice == null || typeof choice !== 'object') continue
        const finishReason = (choice as Record<string, unknown>).finish_reason
        if (typeof finishReason === 'string') return finishReason
      }
    }
    if (rawEvent.type === 'response.completed') return 'completed'
    if (rawEvent.type === 'response.incomplete') return 'incomplete'
    if (rawEvent.type === 'response.failed') return 'failed'
    return undefined
  } catch {
    return undefined
  }
}

export function logOpenAIRawLifecycle(
  context: RawStreamLifecycleContext,
): void {
  try {
    if (!isOpenAIRawStreamLoggingEnabled()) return
    const logPath = getOpenAIRawStreamLogPath()
    const writerEntry = acquireWriter(logPath)
    try {
      const { lifecycle, ...metadataContext } = context
      const metadata = createMetadata(metadataContext)
      if (lifecycle === 'retry') {
        logRawEvent(writerEntry.writer, {
          timestamp: new Date().toISOString(),
          ...metadata,
          lifecycle,
          phase: context.phase,
          attempt: context.attempt,
          maxRetries: context.maxRetries,
          delayMs: context.delayMs,
          error: safeErrorDiagnostics(context.error),
        })
      } else {
        logRawEvent(writerEntry.writer, {
          timestamp: new Date().toISOString(),
          ...metadata,
          lifecycle,
          phase: context.phase,
          eventCount: context.eventCount ?? 0,
          error: safeErrorDiagnostics(context.error),
        })
      }
    } finally {
      releaseWriter(logPath, writerEntry)
    }
  } catch {
    // Lifecycle diagnostics must never alter request or retry behavior.
  }
}

export async function* logOpenAIRawStream<T>(
  stream: AsyncIterable<T>,
  context: RawStreamContext,
): AsyncGenerator<T, void> {
  if (!isOpenAIRawStreamLoggingEnabled()) {
    yield* stream
    return
  }

  let logPath: string
  let writerEntry: WriterEntry
  let metadata: RawStreamMetadata
  try {
    logPath = getOpenAIRawStreamLogPath()
    metadata = createMetadata(context)
    writerEntry = acquireWriter(logPath)
  } catch {
    yield* stream
    return
  }

  let eventCount = 0
  let completionStatus = metadata.status ?? undefined
  logRawEvent(writerEntry.writer, {
    timestamp: new Date().toISOString(),
    ...metadata,
    lifecycle: 'start',
  })

  try {
    try {
      for await (const event of stream) {
        logRawEvent(writerEntry.writer, {
          timestamp: new Date().toISOString(),
          ...metadata,
          lifecycle: 'event',
          sequence: eventCount,
          event,
        })
        eventCount++
        completionStatus = observeCompletionStatus(event) ?? completionStatus
        yield event
        if (eventCount % 50 === 0) {
          await new Promise<void>(resolve => setImmediate(resolve))
        }
      }
      logRawEvent(writerEntry.writer, {
        timestamp: new Date().toISOString(),
        ...metadata,
        lifecycle: 'complete',
        eventCount,
        status: completionStatus ?? null,
      })
    } catch (error) {
      logRawEvent(writerEntry.writer, {
        timestamp: new Date().toISOString(),
        ...metadata,
        lifecycle: 'error',
        eventCount,
        status: completionStatus ?? null,
        error: safeErrorDiagnostics(error),
      })
      throw error
    }
  } finally {
    releaseWriter(logPath, writerEntry)
  }
}

export function _flushOpenAIRawStreamLogForTesting(): void {
  for (const entry of writers.values()) entry.writer.flush()
}

export function _setOpenAIRawStreamLoggerForTesting(
  overrides: TestOverrides,
): void {
  for (const entry of writers.values()) entry.writer.dispose()
  writers.clear()
  testOverrides = overrides
}

export function _resetOpenAIRawStreamLoggerForTesting(): void {
  for (const entry of writers.values()) entry.writer.dispose()
  writers.clear()
  testOverrides = null
}
