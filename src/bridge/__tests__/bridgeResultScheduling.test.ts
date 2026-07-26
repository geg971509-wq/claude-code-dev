import { describe, expect, test } from 'bun:test'

import {
  hasPendingBridgeMessages,
  isTranscriptResetResultReady,
  shouldDeferBridgeResult,
} from '../bridgeResultScheduling.js'

describe('bridgeResultScheduling', () => {
  test('treats normal completion and session replacement as terminal', async () => {
    const replBridge = (await import('../replBridge.js')) as Record<
      string,
      unknown
    >
    const isTerminalBridgeClose = replBridge.isTerminalBridgeClose

    expect(typeof isTerminalBridgeClose).toBe('function')
    expect(
      (isTerminalBridgeClose as (code: number | undefined) => boolean)(1000),
    ).toBe(true)
    expect(
      (isTerminalBridgeClose as (code: number | undefined) => boolean)(4004),
    ).toBe(true)
    expect(
      (isTerminalBridgeClose as (code: number | undefined) => boolean)(1006),
    ).toBe(false)
  })

  test('keeps shared server state when a newer bridge replaces this one', async () => {
    const replBridge = (await import('../replBridge.js')) as Record<
      string,
      unknown
    >
    const shouldTeardownSharedBridgeSession =
      replBridge.shouldTeardownSharedBridgeSession

    expect(typeof shouldTeardownSharedBridgeSession).toBe('function')
    expect(
      (
        shouldTeardownSharedBridgeSession as (
          code: number | undefined,
        ) => boolean
      )(1000),
    ).toBe(true)
    expect(
      (
        shouldTeardownSharedBridgeSession as (
          code: number | undefined,
        ) => boolean
      )(4004),
    ).toBe(false)
  })

  test('detects pending mirrored messages', () => {
    expect(hasPendingBridgeMessages(2, 3)).toBe(true)
    expect(hasPendingBridgeMessages(3, 3)).toBe(false)
  })

  test('defers when the bridge handle is unavailable', () => {
    expect(
      shouldDeferBridgeResult({
        hasHandle: false,
        isConnected: true,
        lastWrittenIndex: 3,
        messageCount: 3,
      }),
    ).toBe(true)
  })

  test('defers when the bridge is connected but transcript flush is pending', () => {
    expect(
      shouldDeferBridgeResult({
        hasHandle: true,
        isConnected: true,
        lastWrittenIndex: 1,
        messageCount: 2,
      }),
    ).toBe(true)
  })

  test('sends immediately once the latest transcript is already mirrored', () => {
    expect(
      shouldDeferBridgeResult({
        hasHandle: true,
        isConnected: true,
        lastWrittenIndex: 2,
        messageCount: 2,
      }),
    ).toBe(false)
  })

  test('treats transcript reset as ready only after the transcript is empty', () => {
    expect(isTranscriptResetResultReady(true, 0)).toBe(true)
    expect(isTranscriptResetResultReady(true, 1)).toBe(false)
    expect(isTranscriptResetResultReady(false, 0)).toBe(false)
  })
})
