import { describe, expect, test } from 'bun:test'
import { resolveJobTarget, type BgJobRecord } from '../jobStore.js'

function job(overrides: Partial<BgJobRecord> = {}): BgJobRecord {
  return {
    pid: 1234,
    sessionId: '12345678-aaaa-bbbb-cccc-123456789abc',
    jobId: '12345678',
    cwd: '/tmp/project',
    startedAt: 1,
    kind: 'bg',
    ...overrides,
  }
}

describe('resolveJobTarget', () => {
  test('resolves the stable short id and session prefix', () => {
    const record = job()
    expect(resolveJobTarget([record], '12345678')).toBe(record)
    expect(resolveJobTarget([record], '12345678-aaaa')).toBe(record)
  })

  test('rejects ambiguous prefixes instead of guessing', () => {
    const a = job({ jobId: 'abcd1234', sessionId: 'abcd1234-aaaa' })
    const b = job({ jobId: 'abcd5678', sessionId: 'abcd5678-bbbb' })
    const result = resolveJobTarget([a, b], 'abcd')
    expect(result).toMatchObject({ kind: 'ambiguous', target: 'abcd' })
  })

  test('keeps exact pid and name compatibility', () => {
    const record = job({ pid: 4321, name: 'nightly' })
    expect(resolveJobTarget([record], '4321')).toBe(record)
    expect(resolveJobTarget([record], 'nightly')).toBe(record)
  })
})
