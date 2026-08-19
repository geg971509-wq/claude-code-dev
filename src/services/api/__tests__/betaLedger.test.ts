import { afterEach, describe, expect, test } from 'bun:test'
import {
  findRejectedBetas,
  getRejectedBetas,
  isBetaRejected,
  markBetaRejected,
  resetRejectedBetas,
} from '../betaLedger.js'

afterEach(() => {
  resetRejectedBetas()
})

describe('findRejectedBetas', () => {
  const rejection =
    '400 {"type":"error","error":{"type":"invalid_request_error",' +
    '"message":"anthropic-beta: unrecognized beta \'context-1m-2025-08-07\'"}}'

  test('names the beta the server rejected', () => {
    expect(findRejectedBetas(400, rejection)).toEqual(['context-1m-2025-08-07'])
  })

  test('ignores non-400s', () => {
    expect(findRejectedBetas(529, rejection)).toEqual([])
  })

  test('requires the message to actually be about anthropic-beta', () => {
    // 一个碰巧含有 `xxx-2026-01-01` 字样的普通 400 不能把无关 header 摘掉 ——
    // 误摘的后果是功能静默消失，比原来的报错更难查。
    expect(
      findRejectedBetas(400, 'Invalid value for foo-2026-01-01 in request'),
    ).toEqual([])
  })

  test('does not re-report an already dropped header', () => {
    markBetaRejected('context-1m-2025-08-07')
    expect(findRejectedBetas(400, rejection)).toEqual([])
  })

  test('honours the exclusion list', () => {
    expect(
      findRejectedBetas(400, rejection, ['context-1m-2025-08-07']),
    ).toEqual([])
  })

  test('collects every named header, deduplicated', () => {
    const msg =
      'anthropic-beta: unsupported: effort-2025-11-24, effort-2025-11-24, ' +
      'fast-mode-2026-02-01'
    expect(findRejectedBetas(400, msg).sort()).toEqual([
      'effort-2025-11-24',
      'fast-mode-2026-02-01',
    ])
  })
})

describe('the ledger', () => {
  test('latches a dropped header for the rest of the session', () => {
    expect(isBetaRejected('effort-2025-11-24')).toBe(false)
    markBetaRejected('effort-2025-11-24')
    expect(isBetaRejected('effort-2025-11-24')).toBe(true)
    expect(getRejectedBetas()).toEqual(['effort-2025-11-24'])
  })
})
