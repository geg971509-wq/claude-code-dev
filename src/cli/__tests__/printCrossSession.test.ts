import { describe, expect, test } from 'bun:test'
import {
  createAutoCompactStateStatusMessage,
  createCrossSessionReceiptStatusMessage,
  getHeadlessPeerHoldTimeoutMs,
  shouldExpireHeadlessPeerHold,
} from '../print.js'
import { SDKStatusMessageSchema } from '../../entrypoints/sdk/coreSchemas.js'
import { asAgentId } from '../../types/ids.js'

describe('headless cross-session lifecycle', () => {
  test('accepts revisioned autocompact status frames', () => {
    const message = createAutoCompactStateStatusMessage(
      {
        state: 'started',
        revision: 7,
        timestamp: '2026-08-27T00:00:00.000Z',
        agentId: asAgentId('agent-1'),
        source: 'sdk',
        preCompactTokens: 120_000,
      },
      'session-1',
      '00000000-0000-4000-8000-000000000005',
    )
    const parsed = SDKStatusMessageSchema().safeParse(message)

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data).toHaveProperty('autocompact_state.revision', 7)
  })

  test('emits a stable SDK status event for peer receipts', () => {
    const message = createCrossSessionReceiptStatusMessage(
      {
        msgId: 'message-1',
        status: 'held',
        from: 'uds:/tmp/peer.sock',
        reason: 'waiting for approval',
      },
      'session-1',
      '00000000-0000-4000-8000-000000000001',
    )
    expect(message as Record<string, unknown>).toEqual({
      type: 'system',
      subtype: 'status',
      status: null,
      peerMessageStatus: 'held',
      peerMessageId: 'message-1',
      peerMessageFrom: 'uds:/tmp/peer.sock',
      peerMessageReason: 'waiting for approval',
      uuid: '00000000-0000-4000-8000-000000000001',
      session_id: 'session-1',
    })
    expect(SDKStatusMessageSchema().safeParse(message).success).toBe(true)
  })

  test('uses the official five-minute default and accepts bounded overrides', () => {
    expect(getHeadlessPeerHoldTimeoutMs(undefined)).toBe(300_000)
    expect(getHeadlessPeerHoldTimeoutMs('1250')).toBe(1_250)
    expect(getHeadlessPeerHoldTimeoutMs('60s')).toBe(60_000)
    expect(getHeadlessPeerHoldTimeoutMs('10m')).toBe(600_000)
    expect(getHeadlessPeerHoldTimeoutMs('never')).toBe(0)
    expect(getHeadlessPeerHoldTimeoutMs('invalid')).toBe(300_000)
    expect(getHeadlessPeerHoldTimeoutMs('')).toBe(300_000)
    expect(getHeadlessPeerHoldTimeoutMs('-1')).toBe(300_000)
  })

  test('expires only parity holds that have no headless approval surface', () => {
    expect(shouldExpireHeadlessPeerHold('mode-mismatch')).toBe(true)
    expect(shouldExpireHeadlessPeerHold('no-mode-asserted')).toBe(true)
    expect(shouldExpireHeadlessPeerHold('explicit-setting')).toBe(false)
    expect(shouldExpireHeadlessPeerHold('mode-unknown')).toBe(false)
  })
})
