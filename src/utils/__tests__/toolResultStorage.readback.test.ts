import { describe, expect, test } from 'bun:test'
import {
  chooseMicrocompactClearContent,
  TIME_BASED_MC_CLEARED_MESSAGE,
} from '../../services/compact/microCompact.js'
import {
  buildClearedButRetrievableMessage,
  buildLargeToolResultMessage,
  extractPersistedOutputPath,
  PERSISTED_OUTPUT_CLOSING_TAG,
  PERSISTED_OUTPUT_TAG,
  TOOL_RESULT_CLEARED_MESSAGE,
} from '../toolResultStorage.js'

describe('buildLargeToolResultMessage read-back contract', () => {
  test('includes path, Read tool, offset/limit, and tags', () => {
    const msg = buildLargeToolResultMessage({
      filepath: '/tmp/sess/tool-results/abc.txt',
      originalSize: 50_000,
      isJson: false,
      preview: 'hello\nworld',
      hasMore: true,
    })
    expect(msg.startsWith(PERSISTED_OUTPUT_TAG)).toBe(true)
    expect(msg).toContain(PERSISTED_OUTPUT_CLOSING_TAG)
    expect(msg).toContain('/tmp/sess/tool-results/abc.txt')
    expect(msg).toMatch(/Read/i)
    expect(msg).toMatch(/offset/i)
    expect(msg).toMatch(/limit/i)
    expect(msg).toContain('hello\nworld')
  })
})

describe('cleared-but-retrievable', () => {
  test('stub is shorter path-bearing contract', () => {
    const p = '/tmp/sess/tool-results/abc.txt'
    const stub = buildClearedButRetrievableMessage(p)
    expect(stub).toContain(p)
    expect(stub).toMatch(/Read/i)
    expect(stub.length).toBeLessThan(400)
  })

  test('extractPersistedOutputPath round-trips builder', () => {
    const filepath = '/tmp/sess/tool-results/xyz.txt'
    const msg = buildLargeToolResultMessage({
      filepath,
      originalSize: 100,
      isJson: false,
      preview: 'x',
      hasMore: false,
    })
    expect(extractPersistedOutputPath(msg)).toBe(filepath)
  })

  test('extract ignores preview/body lookalikes without tag', () => {
    const fake =
      'note: Full output saved to: /evil/path.txt\nFull output is still on disk: /evil2'
    expect(extractPersistedOutputPath(fake)).toBeNull()
  })

  test('extract handles Windows path + spaces', () => {
    const filepath = 'C:\\Users\\me\\proj tool-results\\id with space.txt'
    const msg = buildClearedButRetrievableMessage(filepath)
    expect(extractPersistedOutputPath(msg)).toBe(filepath)
  })

  test('cleared stub has no preview and stays short vs large builder', () => {
    const p = '/tmp/sess/tool-results/abc.txt'
    const stub = buildClearedButRetrievableMessage(p)
    const large = buildLargeToolResultMessage({
      filepath: p,
      originalSize: 50_000,
      isJson: false,
      preview: 'x'.repeat(500),
      hasMore: true,
    })
    expect(stub).not.toMatch(/Preview/i)
    expect(stub.length).toBeLessThan(400)
    expect(stub.length).toBeLessThan(large.length / 2)
  })
})

describe('chooseMicrocompactClearContent', () => {
  test('persisted-tagged content → path-bearing stub, not bare cleared', () => {
    const filepath = '/tmp/sess/tool-results/abc.txt'
    const persisted = buildLargeToolResultMessage({
      filepath,
      originalSize: 50_000,
      isJson: false,
      preview: 'hello',
      hasMore: true,
    })
    const out = chooseMicrocompactClearContent(persisted)
    expect(out).toContain(filepath)
    expect(out).toMatch(/Read/i)
    expect(out).not.toBe(TIME_BASED_MC_CLEARED_MESSAGE)
    expect(out.length).toBeLessThan(persisted.length)
    // MC local stub must match storage builder byte-for-byte.
    expect(out).toBe(buildClearedButRetrievableMessage(filepath))
  })

  test('idempotent: path-stub in → same string out', () => {
    const filepath = '/tmp/sess/tool-results/abc.txt'
    const stub = buildClearedButRetrievableMessage(filepath)
    expect(chooseMicrocompactClearContent(stub)).toBe(stub)
  })

  test('bare / untagged / non-string → bare cleared', () => {
    expect(
      chooseMicrocompactClearContent('huge shell output without tag'),
    ).toBe(TIME_BASED_MC_CLEARED_MESSAGE)
    expect(chooseMicrocompactClearContent([{ type: 'text', text: 'x' }])).toBe(
      TIME_BASED_MC_CLEARED_MESSAGE,
    )
  })

  test('cleared constants stay in lockstep', () => {
    expect(TIME_BASED_MC_CLEARED_MESSAGE).toBe(TOOL_RESULT_CLEARED_MESSAGE)
  })

  test('extract local contract matches storage export (drift guard)', () => {
    const filepath = '/tmp/sess/tool-results/xyz.txt'
    const msg = buildLargeToolResultMessage({
      filepath,
      originalSize: 100,
      isJson: false,
      preview: 'x',
      hasMore: false,
    })
    expect(extractPersistedOutputPath(msg)).toBe(filepath)
    const cleared = chooseMicrocompactClearContent(msg)
    expect(extractPersistedOutputPath(cleared)).toBe(filepath)
  })
})
