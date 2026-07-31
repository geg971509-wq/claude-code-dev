import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteFile } from '../sessionStoragePortable.js'

let tempDir: string

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `claude-atomic-write-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(tempDir, { recursive: true })
})

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

describe('atomicWriteFile', () => {
  test('writes content to a new file and leaves no temp files behind', async () => {
    const target = join(tempDir, 'session.jsonl')
    await atomicWriteFile(target, '{"a":1}\n{"b":2}\n', { mode: 0o600 })

    expect(readFileSync(target, 'utf8')).toBe('{"a":1}\n{"b":2}\n')
    expect(readdirSync(tempDir)).toEqual(['session.jsonl'])
  })

  test('applies the requested mode when creating a new file', async () => {
    const target = join(tempDir, 'new.jsonl')
    await atomicWriteFile(target, 'x', { mode: 0o600 })

    expect(statSync(target).mode & 0o777).toBe(0o600)
  })

  test('replaces existing content and preserves the file permissions', async () => {
    const target = join(tempDir, 'existing.jsonl')
    writeFileSync(target, 'old-content', { mode: 0o600 })

    await atomicWriteFile(target, 'new-content')

    expect(readFileSync(target, 'utf8')).toBe('new-content')
    // rename would otherwise replace 0o600 with the temp file's
    // umask-masked creation mode — transcripts must stay private.
    expect(statSync(target).mode & 0o777).toBe(0o600)
    expect(readdirSync(tempDir)).toEqual(['existing.jsonl'])
  })

  test('cleans up the temp file when the rename fails', async () => {
    // rename(2) cannot move a file over a non-empty directory, forcing the
    // failure path after the temp file has been written.
    const target = join(tempDir, 'blocked')
    mkdirSync(join(target, 'child'), { recursive: true })

    await expect(atomicWriteFile(target, 'data')).rejects.toThrow()

    expect(readdirSync(tempDir)).toEqual(['blocked'])
  })
})
