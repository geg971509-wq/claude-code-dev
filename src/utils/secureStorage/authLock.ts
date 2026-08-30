import { mkdir, mkdirSync } from 'fs'
import { join } from 'path'
import { getErrnoCode } from '../errors.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { lock, lockSync } from '../lockfile.js'
import { getSecureStorage } from './index.js'
import type { SecureStorageData } from './types.js'

const LOCK_WAIT_MS = 10 * 60 * 1000
const LOCK_RETRY_MS = 100
const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
let asyncLockHolders = 0

function lockPaths(): { target: string; lockfilePath: string } {
  const configDir = getClaudeConfigHomeDir()
  return {
    target: join(configDir, '.credentials.json'),
    lockfilePath: join(configDir, '.credentials.lock'),
  }
}

const lockOptions = (lockfilePath: string) => ({
  lockfilePath,
  realpath: false,
  stale: 30_000,
  update: 10_000,
})

export function readSecureStorageFresh(): SecureStorageData | null {
  const storage = getSecureStorage()
  return typeof storage.readFresh === 'function'
    ? storage.readFresh()
    : storage.read()
}

export async function withAuthMutationLock<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const { target, lockfilePath } = lockPaths()
  await new Promise<void>((resolve, reject) => {
    mkdir(getClaudeConfigHomeDir(), { recursive: true }, error => {
      if (error) reject(error)
      else resolve()
    })
  })
  const release = await lock(target, {
    ...lockOptions(lockfilePath),
    retries: {
      retries: Math.ceil(LOCK_WAIT_MS / 1000),
      factor: 1.2,
      minTimeout: LOCK_RETRY_MS,
      maxTimeout: 1000,
    },
  })
  asyncLockHolders++
  try {
    return await fn()
  } finally {
    asyncLockHolders--
    await release().catch(() => {})
  }
}

export function withAuthMutationLockSync<T>(fn: () => T): T {
  // A synchronous mutation can run while this process owns the async lock.
  // The holder re-reads before writing, so an account switch still wins.
  if (asyncLockHolders > 0) return fn()

  const { target, lockfilePath } = lockPaths()
  mkdirSync(getClaudeConfigHomeDir(), { recursive: true })
  const deadline = Date.now() + LOCK_WAIT_MS
  let release: (() => void) | undefined
  while (!release) {
    try {
      release = lockSync(target, lockOptions(lockfilePath))
    } catch (error) {
      if (getErrnoCode(error) !== 'ELOCKED' || Date.now() >= deadline) {
        throw error
      }
      Atomics.wait(waitBuffer, 0, 0, LOCK_RETRY_MS)
    }
  }

  try {
    return fn()
  } finally {
    release()
  }
}
