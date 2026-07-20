import { randomBytes } from 'crypto'
import { constants as fsConstants } from 'fs'
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  rename,
  stat,
  symlink,
  unlink,
} from 'fs/promises'
import { join } from 'path'
import { getSessionId } from '../../bootstrap/state.js'
import type { TaskType } from '../../Task.js'
import { getErrnoCode } from '../errors.js'
import { readFileRange, tailFile } from '../fsOperations.js'
import { logError } from '../log.js'
import { getProjectTempDir } from '../permissions/filesystem.js'

// SECURITY: O_NOFOLLOW prevents following symlinks when opening task output files.
// Without this, an attacker in the sandbox could create symlinks in the tasks directory
// pointing to arbitrary files, causing Claude Code on the host to write to those files.
// O_NOFOLLOW is not available on Windows, but the sandbox attack vector is Unix-only.
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0

const DEFAULT_MAX_READ_BYTES = 8 * 1024 * 1024 // 8MB
const TERMINAL_TASK_RECORD_VERSION = 1
const MAX_TERMINAL_RECORD_BYTES = 256 * 1024
const MAX_TERMINAL_FIELD_LENGTH = 64 * 1024
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const TASK_TYPES: readonly TaskType[] = [
  'local_bash',
  'local_agent',
  'remote_agent',
  'in_process_teammate',
  'local_workflow',
  'monitor_mcp',
  'dream',
]
const TERMINAL_STATUSES = ['completed', 'failed', 'killed'] as const

type TerminalTaskStatus = (typeof TERMINAL_STATUSES)[number]

export type TerminalTaskRecord = {
  version: typeof TERMINAL_TASK_RECORD_VERSION
  id: string
  type: TaskType
  status: TerminalTaskStatus
  description: string
  toolUseId?: string
  startTime: number
  endTime?: number
  exitCode?: number | null
  error?: string
  prompt?: string
  result?: string
}

/**
 * Disk cap for task output files. In file mode (bash), a watchdog polls
 * file size and kills the process. In pipe mode (hooks), DiskTaskOutput
 * drops chunks past this limit. Shared so both caps stay in sync.
 */
export const MAX_TASK_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024
export const MAX_TASK_OUTPUT_BYTES_DISPLAY = '5GB'

/**
 * Get the task output directory for this session.
 * Uses project temp directory so reads are auto-allowed by checkReadableInternalPath.
 *
 * The session ID is included so concurrent sessions in the same project don't
 * clobber each other's output files. Startup cleanup in one session previously
 * unlinked in-flight output files from other sessions — the writing process's fd
 * keeps the inode alive but reads via path fail ENOENT, and getStdout() returned
 * empty string (inc-4586 / boris-20260309-060423).
 *
 * The session ID is captured at FIRST CALL, not re-read on every invocation.
 * /clear calls regenerateSessionId(), which would otherwise cause
 * ensureOutputDir() to create a new-session path while existing TaskOutput
 * instances still hold old-session paths — open() would ENOENT. Background
 * bash tasks surviving /clear need their output files to stay reachable.
 */
let _taskOutputDir: string | undefined
export function getTaskOutputDir(): string {
  if (_taskOutputDir === undefined) {
    _taskOutputDir = join(getProjectTempDir(), getSessionId(), 'tasks')
  }
  return _taskOutputDir
}

/** Test helper — clears the memoized dir. */
export function _resetTaskOutputDirForTest(): void {
  _taskOutputDir = undefined
}

/**
 * Ensure the task output directory exists
 */
async function ensureOutputDir(): Promise<void> {
  await mkdir(getTaskOutputDir(), { recursive: true })
}

function validateTaskId(taskId: string): void {
  if (
    !TASK_ID_PATTERN.test(taskId) ||
    taskId === '.' ||
    taskId === '..' ||
    taskId.includes('..')
  ) {
    throw new Error(`Invalid task ID: ${taskId}`)
  }
}

function getTaskRecordPath(taskId: string): string {
  validateTaskId(taskId)
  return join(getTaskOutputDir(), `${taskId}.meta.json`)
}

/**
 * Get the output file path for a task
 */
export function getTaskOutputPath(taskId: string): string {
  validateTaskId(taskId)
  return join(getTaskOutputDir(), `${taskId}.output`)
}

function truncateTerminalField(value: string | undefined): string | undefined {
  if (value === undefined || value.length <= MAX_TERMINAL_FIELD_LENGTH) {
    return value
  }
  const truncated = value.slice(0, MAX_TERMINAL_FIELD_LENGTH)
  return /[\uD800-\uDBFF]$/.test(truncated) ? truncated.slice(0, -1) : truncated
}

const TERMINAL_RECORD_TEXT_FIELDS = [
  'result',
  'prompt',
  'error',
  'description',
  'toolUseId',
] as const

function shrinkTerminalField(value: string): string {
  const truncated = value.slice(0, Math.floor(value.length / 2))
  return /[\uD800-\uDBFF]$/.test(truncated) ? truncated.slice(0, -1) : truncated
}

function normalizeTerminalTaskRecord(
  record: TerminalTaskRecord,
): TerminalTaskRecord {
  const normalized: TerminalTaskRecord = {
    ...record,
    description: truncateTerminalField(record.description) ?? '',
    toolUseId: truncateTerminalField(record.toolUseId),
    error: truncateTerminalField(record.error),
    prompt: truncateTerminalField(record.prompt),
    result: truncateTerminalField(record.result),
  }

  for (const field of TERMINAL_RECORD_TEXT_FIELDS) {
    while (
      normalized[field] &&
      Buffer.byteLength(JSON.stringify(normalized), 'utf8') >
        MAX_TERMINAL_RECORD_BYTES
    ) {
      normalized[field] = shrinkTerminalField(normalized[field])
    }
  }

  return normalized
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function parseTerminalTaskRecord(
  raw: string,
  expectedId: string,
): TerminalTaskRecord | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null

  const record = value as Record<string, unknown>
  if (
    record.version !== TERMINAL_TASK_RECORD_VERSION ||
    record.id !== expectedId ||
    typeof record.type !== 'string' ||
    !TASK_TYPES.includes(record.type as TaskType) ||
    typeof record.status !== 'string' ||
    !TERMINAL_STATUSES.includes(record.status as TerminalTaskStatus) ||
    typeof record.description !== 'string' ||
    typeof record.startTime !== 'number' ||
    !Number.isFinite(record.startTime) ||
    (record.endTime !== undefined &&
      (typeof record.endTime !== 'number' ||
        !Number.isFinite(record.endTime))) ||
    (record.exitCode !== undefined &&
      record.exitCode !== null &&
      (!Number.isInteger(record.exitCode) ||
        typeof record.exitCode !== 'number')) ||
    !isOptionalString(record.toolUseId) ||
    !isOptionalString(record.error) ||
    !isOptionalString(record.prompt) ||
    !isOptionalString(record.result)
  ) {
    return null
  }

  for (const field of [
    record.description,
    record.toolUseId,
    record.error,
    record.prompt,
    record.result,
  ]) {
    if (typeof field === 'string' && field.length > MAX_TERMINAL_FIELD_LENGTH) {
      return null
    }
  }

  return record as TerminalTaskRecord
}

export async function writeTerminalTaskRecord(
  record: TerminalTaskRecord,
): Promise<void> {
  validateTaskId(record.id)
  await ensureOutputDir()
  const target = getTaskRecordPath(record.id)
  const temp = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  const payload = JSON.stringify(normalizeTerminalTaskRecord(record))
  if (Buffer.byteLength(payload, 'utf8') > MAX_TERMINAL_RECORD_BYTES) {
    throw new Error(`Terminal task record is too large: ${record.id}`)
  }

  let file: FileHandle | undefined
  try {
    file = await open(
      temp,
      process.platform === 'win32'
        ? 'wx'
        : fsConstants.O_WRONLY |
            fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            O_NOFOLLOW,
      0o600,
    )
    await file.writeFile(payload, 'utf8')
    await file.sync()
    await file.close()
    file = undefined
    await rename(temp, target)
  } catch (error) {
    await file?.close().catch(() => {})
    await unlink(temp).catch(() => {})
    throw error
  }
}

export async function readTerminalTaskRecord(
  taskId: string,
): Promise<TerminalTaskRecord | null> {
  try {
    validateTaskId(taskId)
    const path = getTaskRecordPath(taskId)
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) return null
    if (info.size > MAX_TERMINAL_RECORD_BYTES) return null

    const file = await open(
      path,
      process.platform === 'win32' ? 'r' : fsConstants.O_RDONLY | O_NOFOLLOW,
    )
    try {
      return parseTerminalTaskRecord(await file.readFile('utf8'), taskId)
    } finally {
      await file.close()
    }
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') return null
    logError(error)
    return null
  }
}

export async function deleteTerminalTaskRecord(taskId: string): Promise<void> {
  try {
    await unlink(getTaskRecordPath(taskId))
  } catch (error) {
    if (getErrnoCode(error) !== 'ENOENT') throw error
  }
}

// Tracks fire-and-forget promises (initTaskOutput, initTaskOutputAsSymlink,
// evictTaskOutput, #drain) so tests can drain before teardown. Prevents the
// async-ENOENT-after-teardown flake class (#24957, #25065): a voided async
// resumes after preload's afterEach nuked the temp dir → ENOENT → unhandled
// rejection → flaky test failure. allSettled so a rejection doesn't short-
// circuit the drain and leave other ops racing the rmSync.
const _pendingOps = new Set<Promise<unknown>>()
function track<T>(p: Promise<T>): Promise<T> {
  _pendingOps.add(p)
  void p.finally(() => _pendingOps.delete(p)).catch(() => {})
  return p
}

/**
 * Encapsulates async disk writes for a single task's output.
 *
 * Uses a flat array as a write queue processed by a single drain loop,
 * so each chunk can be GC'd immediately after its write completes.
 * This avoids the memory retention problem of chained .then() closures
 * where every reaction captures its data until the whole chain resolves.
 */
export class DiskTaskOutput {
  #path: string
  #fileHandle: FileHandle | null = null
  #queue: string[] = []
  #bytesWritten = 0
  #capped = false
  #flushPromise: Promise<void> | null = null
  #flushResolve: (() => void) | null = null

  constructor(taskId: string) {
    this.#path = getTaskOutputPath(taskId)
  }

  append(content: string): void {
    if (this.#capped) {
      return
    }
    // content.length (UTF-16 code units) undercounts UTF-8 bytes by at most ~3×.
    // Acceptable for a coarse disk-fill guard — avoids re-scanning every chunk.
    this.#bytesWritten += content.length
    if (this.#bytesWritten > MAX_TASK_OUTPUT_BYTES) {
      this.#capped = true
      this.#queue.push(
        `\n[output truncated: exceeded ${MAX_TASK_OUTPUT_BYTES_DISPLAY} disk cap]\n`,
      )
    } else {
      this.#queue.push(content)
    }
    if (!this.#flushPromise) {
      this.#flushPromise = new Promise<void>(resolve => {
        this.#flushResolve = resolve
      })
      void track(this.#drain())
    }
  }

  flush(): Promise<void> {
    return this.#flushPromise ?? Promise.resolve()
  }

  cancel(): void {
    this.#queue.length = 0
  }

  async #drainAllChunks(): Promise<void> {
    while (true) {
      try {
        if (!this.#fileHandle) {
          await ensureOutputDir()
          this.#fileHandle = await open(
            this.#path,
            process.platform === 'win32'
              ? 'a'
              : fsConstants.O_WRONLY |
                  fsConstants.O_APPEND |
                  fsConstants.O_CREAT |
                  O_NOFOLLOW,
          )
        }
        while (true) {
          await this.#writeAllChunks()
          if (this.#queue.length === 0) {
            break
          }
        }
      } finally {
        if (this.#fileHandle) {
          const fileHandle = this.#fileHandle
          this.#fileHandle = null
          await fileHandle.close()
        }
      }
      // you could have another .append() while we're waiting for the file to close, so we check the queue again before fully exiting
      if (this.#queue.length) {
        continue
      }

      break
    }
  }

  #writeAllChunks(): Promise<void> {
    // This code is extremely precise.
    // You **must not** add an await here!! That will cause memory to balloon as the queue grows.
    // It's okay to add an `await` to the caller of this method (e.g. #drainAllChunks) because that won't cause Buffer[] to be kept alive in memory.
    return this.#fileHandle!.appendFile(
      // This variable needs to get GC'd ASAP.
      this.#queueToBuffers(),
    )
  }

  /** Keep this in a separate method so that GC doesn't keep it alive for any longer than it should. */
  #queueToBuffers(): Buffer {
    // Use .splice to in-place mutate the array, informing the GC it can free it.
    const queue = this.#queue.splice(0, this.#queue.length)

    let totalLength = 0
    for (const str of queue) {
      totalLength += Buffer.byteLength(str, 'utf8')
    }

    const buffer = Buffer.allocUnsafe(totalLength)
    let offset = 0
    for (const str of queue) {
      offset += buffer.write(str, offset, 'utf8')
    }

    return buffer
  }

  async #drain(): Promise<void> {
    try {
      await this.#drainAllChunks()
    } catch (e) {
      // Transient fs errors (EMFILE on busy CI, EPERM on Windows pending-
      // delete) previously rode up through `void this.#drain()` as an
      // unhandled rejection while the flush promise resolved anyway — callers
      // saw an empty file with no error. Retry once for the transient case
      // (queue is intact if open() failed), then log and give up.
      logError(e)
      if (this.#queue.length > 0) {
        try {
          await this.#drainAllChunks()
        } catch (e2) {
          logError(e2)
        }
      }
    } finally {
      const resolve = this.#flushResolve!
      this.#flushPromise = null
      this.#flushResolve = null
      resolve()
    }
  }
}

const outputs = new Map<string, DiskTaskOutput>()

/**
 * Test helper — cancel pending writes, await in-flight ops, clear the map.
 * backgroundShells.test.ts and other task tests spawn real shells that
 * write through this module without afterEach cleanup; their entries
 * leak into diskOutput.test.ts on the same shard.
 *
 * Awaits all tracked promises until the set stabilizes — a settling promise
 * may spawn another (initTaskOutputAsSymlink's catch → initTaskOutput).
 * Call this in afterEach BEFORE rmSync to avoid async-ENOENT-after-teardown.
 */
export async function _clearOutputsForTest(): Promise<void> {
  for (const output of outputs.values()) {
    output.cancel()
  }
  while (_pendingOps.size > 0) {
    await Promise.allSettled([..._pendingOps])
  }
  outputs.clear()
}

function getOrCreateOutput(taskId: string): DiskTaskOutput {
  let output = outputs.get(taskId)
  if (!output) {
    output = new DiskTaskOutput(taskId)
    outputs.set(taskId, output)
  }
  return output
}

/**
 * Append output to a task's disk file asynchronously.
 * Creates the file if it doesn't exist.
 */
export function appendTaskOutput(taskId: string, content: string): void {
  getOrCreateOutput(taskId).append(content)
}

/**
 * Wait for all pending writes for a task to complete.
 * Useful before reading output to ensure all data is flushed.
 */
export async function flushTaskOutput(taskId: string): Promise<void> {
  const output = outputs.get(taskId)
  if (output) {
    await output.flush()
  }
}

/**
 * Evict a task's DiskTaskOutput from the in-memory map after flushing.
 * Unlike cleanupTaskOutput, this does not delete the output file on disk.
 * Call this when a task completes and its output has been consumed.
 */
export function evictTaskOutput(taskId: string): Promise<void> {
  return track(
    (async () => {
      const output = outputs.get(taskId)
      if (output) {
        await output.flush()
        outputs.delete(taskId)
      }
    })(),
  )
}

/**
 * Get delta (new content) since last read.
 * Reads only from the byte offset, up to maxBytes — never loads the full file.
 */
export async function getTaskOutputDelta(
  taskId: string,
  fromOffset: number,
  maxBytes: number = DEFAULT_MAX_READ_BYTES,
): Promise<{ content: string; newOffset: number }> {
  try {
    const result = await readFileRange(
      getTaskOutputPath(taskId),
      fromOffset,
      maxBytes,
    )
    if (!result) {
      return { content: '', newOffset: fromOffset }
    }
    return {
      content: result.content,
      newOffset: fromOffset + result.bytesRead,
    }
  } catch (e) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return { content: '', newOffset: fromOffset }
    }
    logError(e)
    return { content: '', newOffset: fromOffset }
  }
}

/**
 * Get output for a task, reading the tail of the file.
 * Caps at maxBytes to avoid loading multi-GB files into memory.
 */
export async function getTaskOutput(
  taskId: string,
  maxBytes: number = DEFAULT_MAX_READ_BYTES,
): Promise<string> {
  try {
    const { content, bytesTotal, bytesRead } = await tailFile(
      getTaskOutputPath(taskId),
      maxBytes,
    )
    if (bytesTotal > bytesRead) {
      return `[${Math.round((bytesTotal - bytesRead) / 1024)}KB of earlier output omitted]\n${content}`
    }
    return content
  } catch (e) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return ''
    }
    logError(e)
    return ''
  }
}

/**
 * Get the current size (offset) of a task's output file.
 */
export async function getTaskOutputSize(taskId: string): Promise<number> {
  try {
    return (await stat(getTaskOutputPath(taskId))).size
  } catch (e) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return 0
    }
    logError(e)
    return 0
  }
}

/**
 * Clean up a task's output file and write queue.
 */
export async function cleanupTaskOutput(taskId: string): Promise<void> {
  const output = outputs.get(taskId)
  if (output) {
    output.cancel()
    outputs.delete(taskId)
  }

  await Promise.all([
    unlink(getTaskOutputPath(taskId)).catch(error => {
      if (getErrnoCode(error) !== 'ENOENT') logError(error)
    }),
    deleteTerminalTaskRecord(taskId).catch(logError),
  ])
}

/**
 * Initialize output file for a new task.
 * Creates an empty file to ensure the path exists.
 */
export function initTaskOutput(taskId: string): Promise<string> {
  return track(
    (async () => {
      await ensureOutputDir()
      const outputPath = getTaskOutputPath(taskId)
      // SECURITY: O_NOFOLLOW prevents symlink-following attacks from the sandbox.
      // O_EXCL ensures we create a new file and fail if something already exists at this path.
      // On Windows, use string flags — numeric O_EXCL can produce EINVAL through libuv.
      const fh = await open(
        outputPath,
        process.platform === 'win32'
          ? 'wx'
          : fsConstants.O_WRONLY |
              fsConstants.O_CREAT |
              fsConstants.O_EXCL |
              O_NOFOLLOW,
      )
      await fh.close()
      return outputPath
    })(),
  )
}

/**
 * Initialize output file as a symlink to another file (e.g., agent transcript).
 * Tries to create the symlink first; if a file already exists, removes it and retries.
 */
export function initTaskOutputAsSymlink(
  taskId: string,
  targetPath: string,
): Promise<string> {
  return track(
    (async () => {
      try {
        await ensureOutputDir()
        const outputPath = getTaskOutputPath(taskId)

        try {
          await symlink(targetPath, outputPath)
        } catch {
          await unlink(outputPath)
          await symlink(targetPath, outputPath)
        }

        return outputPath
      } catch (error) {
        logError(error)
        return initTaskOutput(taskId)
      }
    })(),
  )
}
