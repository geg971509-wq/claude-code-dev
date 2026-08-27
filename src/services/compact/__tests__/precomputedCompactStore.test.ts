import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPrecomputedCompactStore } from '../precomputedCompactStore.js'

let projectDir: string
let sidecar: string
let transcript: string

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'precomputed-compact-'))
  sidecar = join(projectDir, 'session', 'precompact.json')
  transcript = join(projectDir, 'session.jsonl')
  mkdirSync(join(projectDir, 'session'))
})

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true })
})

describe('precomputed compact sidecar', () => {
  test('atomically writes private data and reads the matching session', async () => {
    const store = createPrecomputedCompactStore('session', transcript)
    const value = { status: 'ready', key: 'main' }

    await store.write(value)

    expect(await store.read()).toEqual(value)
    expect(statSync(sidecar).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(sidecar, 'utf8'))).toEqual({
      sessionId: 'session',
      result: value,
    })
  })

  test('serializes concurrent writes and deletes in invocation order', async () => {
    const store = createPrecomputedCompactStore('session', transcript)

    await Promise.all([store.write({ generation: 1 }), store.clear()])
    expect(existsSync(sidecar)).toBe(false)

    await Promise.all([store.clear(), store.write({ generation: 2 })])
    expect(await store.read()).toEqual({ generation: 2 })
  })

  test('removes corrupt, truncated, and foreign-session sidecars', async () => {
    const store = createPrecomputedCompactStore('session', transcript)

    for (const content of [
      '{"sessionId":"session",',
      JSON.stringify({ sessionId: 'other', result: { status: 'ready' } }),
      JSON.stringify({ sessionId: 'session' }),
    ]) {
      writeFileSync(sidecar, content)
      expect(await store.read()).toBeUndefined()
      expect(existsSync(sidecar)).toBe(false)
    }
  })

  test('places the sidecar beside the transcript', async () => {
    const nestedDir = join(projectDir, 'resumed-session')
    const nestedTranscript = join(nestedDir, 'session.jsonl')
    const store = createPrecomputedCompactStore('session', nestedTranscript)

    await store.write({ status: 'ready' })

    expect(existsSync(join(nestedDir, 'session', 'precompact.json'))).toBe(true)
    expect(existsSync(sidecar)).toBe(false)
  })

  test('isolates simultaneous sessions in the same project directory', async () => {
    const first = createPrecomputedCompactStore(
      'session-a',
      join(projectDir, 'session-a.jsonl'),
    )
    const second = createPrecomputedCompactStore(
      'session-b',
      join(projectDir, 'session-b.jsonl'),
    )

    await first.write({ generation: 'a' })
    await second.write({ generation: 'b' })

    expect(await first.read()).toEqual({ generation: 'a' })
    expect(await second.read()).toEqual({ generation: 'b' })

    await first.clear()
    expect(await second.read()).toEqual({ generation: 'b' })
  })
})
