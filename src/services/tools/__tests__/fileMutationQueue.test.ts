import { afterEach, describe, expect, test } from 'bun:test'
import { resolve } from 'path'
import {
  getFileMutationLockPath,
  resetFileMutationLocksForTesting,
  withFileMutationLock,
} from '../fileMutationQueue'

afterEach(() => {
  resetFileMutationLocksForTesting()
})

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('getFileMutationLockPath', () => {
  const editTool = {
    getPath: (input: { file_path: string }) => input.file_path,
    isReadOnly: () => false,
  }
  const readTool = {
    getPath: (input: { file_path: string }) => input.file_path,
    isReadOnly: () => true,
  }
  const noPathTool = { isReadOnly: () => false }

  test('returns resolved path for mutation tools', () => {
    expect(getFileMutationLockPath(editTool, { file_path: '/a/b.txt' })).toBe(
      resolve('/a/b.txt'),
    )
  })

  test('returns null for read-only tools', () => {
    expect(
      getFileMutationLockPath(readTool, { file_path: '/a/b.txt' }),
    ).toBeNull()
  })

  test('returns null when the tool has no getPath', () => {
    expect(getFileMutationLockPath(noPathTool, {})).toBeNull()
  })
})

describe('withFileMutationLock', () => {
  test('serializes concurrent calls on the same path', async () => {
    const events: string[] = []
    const run = (id: string, ms: number) =>
      withFileMutationLock('/tmp/x', async () => {
        events.push(`${id}:start`)
        await sleep(ms)
        events.push(`${id}:end`)
      })
    await Promise.all([run('a', 40), run('b', 10)])
    // b must not start until a fully finishes
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })

  test('runs different paths in parallel', async () => {
    const events: string[] = []
    const run = (path: string, id: string, ms: number) =>
      withFileMutationLock(path, async () => {
        events.push(`${id}:start`)
        await sleep(ms)
        events.push(`${id}:end`)
      })
    await Promise.all([run('/tmp/x', 'a', 40), run('/tmp/y', 'b', 10)])
    // Interleaved: b finishes before a despite starting second
    expect(events).toEqual(['a:start', 'b:start', 'b:end', 'a:end'])
  })

  test('releases the lock when fn throws', async () => {
    await expect(
      withFileMutationLock('/tmp/x', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    // Lock must be usable again
    await expect(
      withFileMutationLock('/tmp/x', async () => 'ok'),
    ).resolves.toBe('ok')
  })

  test('abort while queued skips fn but does not wedge the chain', async () => {
    const controller = new AbortController()
    // Holder occupies the lock for a while
    const holder = withFileMutationLock('/tmp/x', async () => {
      await sleep(60)
    })
    // Queued caller aborts mid-wait
    let fnRan = false
    const queued = withFileMutationLock(
      '/tmp/x',
      async () => {
        fnRan = true
      },
      controller.signal,
    )
    setTimeout(() => controller.abort(), 10)
    await expect(queued).rejects.toThrow(/Aborted while waiting/)
    await holder
    expect(fnRan).toBe(false)
    // Chain is still usable afterwards
    await expect(
      withFileMutationLock('/tmp/x', async () => 'ok'),
    ).resolves.toBe('ok')
  })

  test('already-aborted signal rejects immediately', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      withFileMutationLock('/tmp/x', async () => 'never', controller.signal),
    ).rejects.toThrow(/Aborted while waiting/)
  })
})
