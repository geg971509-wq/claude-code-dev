/**
 * Same-file mutation serialization (ported from pi's file-mutation-queue.ts).
 *
 * Within a single tool batch, non-concurrency-safe tools already run
 * serially — the race this closes is ACROSS query loops: the main loop and
 * parallel subagents editing the same file concurrently (e.g. fileHistory's
 * v1 backup being overwritten mid-edit, interleaved writes). Mutations to
 * DIFFERENT files still run fully parallel.
 *
 * Deliberate coverage boundaries:
 * - Only tools exposing `getPath()` AND not read-only are locked. That is
 *   FileEdit/FileWrite/NotebookEdit — and CronCreate/CronDelete, whose
 *   getPath() returns the real cron file; serializing those is intentional.
 * - Bash/PowerShell redirection writes can't be seen (no parseable path).
 * - MCP tools don't implement getPath and are unaffected.
 * - Symlink aliases of the same file are not unified (realpath would fail
 *   for not-yet-created files).
 *
 * The lock is held only around tool.call — permission prompts happen
 * outside, so an approval dialog never blocks another agent's file work.
 */

import { resolve } from 'path'

interface LockableTool<TInput> {
  getPath?: (input: TInput) => string | undefined
  isReadOnly: (input: TInput) => boolean
}

/**
 * The lock key for a tool call, or null when the call doesn't mutate a
 * file. `input` must be the BACKFILLED input (backfillObservableInput has
 * already expanded `~` and normalized separators at that point), so callers
 * don't fork into two locks for `~/x` vs `/home/u/x`.
 */
export function getFileMutationLockPath<TInput>(
  tool: LockableTool<TInput>,
  input: TInput,
): string | null {
  if (tool.isReadOnly(input)) return null
  const path = tool.getPath?.(input)
  if (!path) return null
  return resolve(path)
}

// Module-level promise chains, one per normalized path. A process exit takes
// the Map with it; entries self-clean once their tail settles.
const chains = new Map<string, Promise<void>>()

/**
 * Run `fn` holding the exclusive lock for `path`. The chain link is always
 * resolved — even when `fn` throws or the caller aborts while queued — so a
 * failed/abandoned call never wedges later mutations of the same file.
 */
export async function withFileMutationLock<T>(
  path: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const key = resolve(path)
  const prev = chains.get(key) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>(r => {
    release = r
  })
  const tail = prev.then(() => mine)
  chains.set(key, tail)

  const cleanup = (): void => {
    release()
    if (chains.get(key) === tail) {
      chains.delete(key)
    }
  }

  if (signal) {
    // Race our turn against abort: if aborted while queued, skip fn but
    // STILL release our link so the chain isn't wedged for everyone after us.
    const abortedWhileQueued = await Promise.race([
      prev.then(() => false),
      new Promise<true>(resolveAbort => {
        if (signal.aborted) {
          resolveAbort(true)
        } else {
          signal.addEventListener('abort', () => resolveAbort(true), {
            once: true,
          })
        }
      }),
    ])
    if (abortedWhileQueued) {
      cleanup()
      const err = new Error('Aborted while waiting for file mutation lock')
      err.name = 'AbortError'
      throw err
    }
  } else {
    await prev
  }

  try {
    return await fn()
  } finally {
    cleanup()
  }
}

/** Test-only: drop all chain state. */
export function resetFileMutationLocksForTesting(): void {
  chains.clear()
}
