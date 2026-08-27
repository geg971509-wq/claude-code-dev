import { chmod, mkdir, readFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getTranscriptPath } from '../../utils/sessionStorage.js'
import { atomicWriteFile } from '../../utils/sessionStoragePortable.js'

export type PrecomputedCompactStore = {
  read(): Promise<unknown | undefined>
  write(value: unknown): Promise<void>
  clear(): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as Error & { code?: unknown }).code === 'ENOENT'
  )
}

export function createPrecomputedCompactStore(
  sessionId: string,
  transcriptPath = getTranscriptPath(),
): PrecomputedCompactStore {
  const filePath = join(dirname(transcriptPath), sessionId, 'precompact.json')
  let queue: Promise<void> = Promise.resolve()

  function enqueue(operation: () => Promise<void>): Promise<void> {
    const run = queue.then(operation, operation)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function remove(): Promise<void> {
    try {
      await unlink(filePath)
    } catch (error) {
      if (!isMissingFile(error)) throw error
    }
  }

  return {
    async read() {
      await queue
      let content: string
      try {
        content = await readFile(filePath, 'utf8')
      } catch (error) {
        if (isMissingFile(error)) return undefined
        throw error
      }

      let value: unknown
      try {
        value = JSON.parse(content)
      } catch {
        await enqueue(remove)
        return undefined
      }
      if (
        !isRecord(value) ||
        value.sessionId !== sessionId ||
        !('result' in value) ||
        value.result === undefined
      ) {
        await enqueue(remove)
        return undefined
      }
      return value.result
    },
    write(value) {
      return enqueue(async () => {
        await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
        await atomicWriteFile(
          filePath,
          JSON.stringify({ sessionId, result: value }),
          { mode: 0o600 },
        )
        await chmod(filePath, 0o600)
      })
    },
    clear() {
      return enqueue(remove)
    },
  }
}
