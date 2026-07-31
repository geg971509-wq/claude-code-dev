import { describe, expect, test } from 'bun:test'
import {
  UserCancellationError,
  abortable,
  createDeadlineAbortSignal,
  isUserCancellation,
  linkAbortSignal,
  userCancellationReason,
} from '../abort'
import { AbortError, isAbortError } from '../errors'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('abortable', () => {
  test('resolves with the promise value when the signal never aborts', async () => {
    const controller = new AbortController()
    await expect(
      abortable(Promise.resolve(42), controller.signal),
    ).resolves.toBe(42)
  })

  test('rejects with the promise rejection when it loses the race', async () => {
    const controller = new AbortController()
    const failure = new Error('boom')
    await expect(
      abortable(Promise.reject(failure), controller.signal),
    ).rejects.toBe(failure)
  })

  test('rejects with an AbortError when the signal aborts with no custom reason', async () => {
    const controller = new AbortController()
    const pending = new Promise<number>(() => {})
    const raced = abortable(pending, controller.signal)
    controller.abort()
    const reason = await raced.catch((e: unknown) => e)
    expect(reason).toBeInstanceOf(AbortError)
    expect(isAbortError(reason)).toBe(true)
  })

  test('preserves a custom abort reason as the rejection', async () => {
    const controller = new AbortController()
    const reason = userCancellationReason()
    const raced = abortable(new Promise<number>(() => {}), controller.signal)
    controller.abort(reason)
    await expect(raced).rejects.toBe(reason)
  })

  test('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      abortable(Promise.resolve(1), controller.signal),
    ).rejects.toBeInstanceOf(AbortError)
  })

  test('late abort after settle does not change the outcome', async () => {
    const controller = new AbortController()
    const raced = abortable(Promise.resolve('done'), controller.signal)
    await expect(raced).resolves.toBe('done')
    controller.abort()
    await expect(raced).resolves.toBe('done')
  })
})

describe('linkAbortSignal', () => {
  test('forwards abort and preserves the source reason', () => {
    const source = new AbortController()
    const target = new AbortController()
    const reason = userCancellationReason()
    linkAbortSignal(source.signal, target)
    source.abort(reason)
    expect(target.signal.aborted).toBe(true)
    expect(target.signal.reason).toBe(reason)
  })

  test('aborts the target synchronously when the source is already aborted', () => {
    const source = new AbortController()
    source.abort('gone')
    const target = new AbortController()
    linkAbortSignal(source.signal, target)
    expect(target.signal.aborted).toBe(true)
    expect(target.signal.reason).toBe('gone')
  })

  test('unlink stops forwarding', () => {
    const source = new AbortController()
    const target = new AbortController()
    const unlink = linkAbortSignal(source.signal, target)
    unlink()
    source.abort()
    expect(target.signal.aborted).toBe(false)
  })
})

describe('createDeadlineAbortSignal', () => {
  test('aborts with timedOut() true when the deadline fires', async () => {
    const parent = new AbortController()
    const deadline = createDeadlineAbortSignal(parent.signal, 10)
    expect(deadline.signal.aborted).toBe(false)
    await sleep(30)
    expect(deadline.signal.aborted).toBe(true)
    expect(deadline.timedOut()).toBe(true)
    expect(isAbortError(deadline.signal.reason)).toBe(true)
    expect(parent.signal.aborted).toBe(false)
    deadline.clear()
  })

  test('parent abort before the deadline keeps timedOut() false and the parent reason', async () => {
    const parent = new AbortController()
    const deadline = createDeadlineAbortSignal(parent.signal, 10_000)
    const reason = userCancellationReason()
    parent.abort(reason)
    expect(deadline.signal.aborted).toBe(true)
    expect(deadline.timedOut()).toBe(false)
    expect(deadline.signal.reason).toBe(reason)
    deadline.clear()
  })

  test('clear() prevents the deadline from aborting', async () => {
    const parent = new AbortController()
    const deadline = createDeadlineAbortSignal(parent.signal, 10)
    deadline.clear()
    await sleep(30)
    expect(deadline.signal.aborted).toBe(false)
    expect(deadline.timedOut()).toBe(false)
  })
})

describe('UserCancellationError', () => {
  test('has userCancelled true and name AbortError', () => {
    const e = new UserCancellationError()
    expect(e.userCancelled).toBe(true)
    expect(e.name).toBe('AbortError')
    expect(e.message).toBe('Aborted by the user')
  })

  test('is caught by isAbortError and isUserCancellation', () => {
    const e = new UserCancellationError()
    expect(isAbortError(e)).toBe(true)
    expect(isUserCancellation(e)).toBe(true)
    expect(isUserCancellation(new AbortError('x'))).toBe(false)
    expect(isUserCancellation('cancelled')).toBe(false)
  })

  test('userCancellationReason returns a UserCancellationError', () => {
    expect(userCancellationReason()).toBeInstanceOf(UserCancellationError)
  })
})
