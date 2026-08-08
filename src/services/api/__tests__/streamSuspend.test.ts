import { describe, expect, test } from 'bun:test'
import {
  classifyStreamSuspend,
  classifyStreamSuspendFromError,
} from '../streamSuspend.js'

describe('classifyStreamSuspend', () => {
  test('connCode StreamSuspended wins', () => {
    expect(
      classifyStreamSuspend({
        connCode: 'StreamSuspended',
        streamIdleAborted: true,
        isStaleConnection: true,
      }),
    ).toBe('stream_suspended')
  })

  test('stale_connection', () => {
    expect(
      classifyStreamSuspend({
        isStaleConnection: true,
        streamIdleAborted: true,
      }),
    ).toBe('stale_connection')
  })

  test('context_hint_sse', () => {
    expect(
      classifyStreamSuspend({
        isContextHintSse: true,
        streamIdleAborted: true,
      }),
    ).toBe('context_hint_sse')
  })

  test('watchdog when idle aborted only', () => {
    expect(classifyStreamSuspend({ streamIdleAborted: true })).toBe('watchdog')
  })

  test('other when empty', () => {
    expect(classifyStreamSuspend({})).toBe('other')
  })
})

describe('classifyStreamSuspendFromError', () => {
  test('watchdog from idle flag alone', () => {
    expect(classifyStreamSuspendFromError(new Error('idle'), true)).toBe(
      'watchdog',
    )
  })

  test('StreamSuspended name', () => {
    const err = new Error('suspended')
    err.name = 'StreamSuspendedError'
    expect(classifyStreamSuspendFromError(err, false)).toBe('stream_suspended')
  })

  test('ECONNRESET cause → stale_connection', () => {
    const cause = Object.assign(new Error('reset'), { code: 'ECONNRESET' })
    const err = new Error('conn', { cause })
    expect(classifyStreamSuspendFromError(err, false)).toBe('stale_connection')
  })

  test('StreamSuspended code wins over idle', () => {
    const cause = Object.assign(new Error('x'), { code: 'StreamSuspended' })
    const err = new Error('conn', { cause })
    expect(classifyStreamSuspendFromError(err, true)).toBe('stream_suspended')
  })
})
