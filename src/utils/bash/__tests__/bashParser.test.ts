import { beforeAll, describe, expect, test } from 'bun:test'
import {
  ensureParserInitialized,
  getParserModule,
} from 'src/utils/bash/bashParser.js'

type ParseFn = (source: string, timeoutMs?: number) => unknown

let parse: ParseFn

beforeAll(async () => {
  await ensureParserInitialized()
  const mod = getParserModule()
  if (!mod) throw new Error('parser module unavailable')
  parse = mod.parse as ParseFn
})

describe('saveLex/restoreLex offset packing', () => {
  // Regression: LexSave packed both offsets into 16-bit fields, so any command
  // longer than 65535 chars wrapped on restore and the parser re-parsed the
  // same text until the deadline aborted it — parse() returned null for every
  // such command. Boundary is exercised from both sides because the failure was
  // silent (a null parse, not a throw).
  test('parses a command just under the old 16-bit boundary', () => {
    expect(parse(`echo ${'x'.repeat(65_000)}`)).not.toBeNull()
  })

  test('parses a command past the old 16-bit boundary', () => {
    expect(parse(`echo ${'x'.repeat(65_540)}`)).not.toBeNull()
  })

  test('parses a command well past the boundary', () => {
    expect(parse(`echo ${'x'.repeat(200_000)}`)).not.toBeNull()
  })

  test('a long command does not consume the whole timeout budget', () => {
    // The overflow made wall time track timeoutMs instead of input size: a
    // generous budget meant the re-parse loop spun for all of it.
    const source = `echo ${'x'.repeat(100_000)}`
    const start = performance.now()
    expect(parse(source, 10_000)).not.toBeNull()
    expect(performance.now() - start).toBeLessThan(1_000)
  })

  test('offsets survive a backtrack past the boundary', () => {
    // `[` forces parseSimpleCommand's backtracking path, which is what calls
    // restoreLex — a round-trip that silently truncated before the fix.
    const pad = 'x'.repeat(70_000)
    expect(parse(`echo ${pad} && [ -f /tmp/f ]`)).not.toBeNull()
  })
})
