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

type RawStreamContext = {
  route: OpenAIRawStreamRoute
  model: string
  source?: string
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

export async function* logOpenAIRawStream<T>(
  stream: AsyncIterable<T>,
  context: RawStreamContext,
): AsyncGenerator<T, void> {
  if (!isOpenAIRawStreamLoggingEnabled()) {
    yield* stream
    return
  }

  const sessionId = getSessionId()
  const logPath = getOpenAIRawStreamLogPath()
  const writerEntry = acquireWriter(logPath)
  const streamId = randomUUID()
  const protocol =
    context.route === 'chat-completions' ? 'chat-completions' : 'responses'
  let sequence = 0

  try {
    for await (const event of stream) {
      logRawEvent(writerEntry.writer, {
        timestamp: new Date().toISOString(),
        sessionId,
        streamId,
        route: context.route,
        protocol,
        model: context.model,
        source: context.source ?? null,
        sequence,
        event,
      })
      sequence++
      yield event
      if (sequence % 50 === 0) {
        await new Promise<void>(resolve => setImmediate(resolve))
      }
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
