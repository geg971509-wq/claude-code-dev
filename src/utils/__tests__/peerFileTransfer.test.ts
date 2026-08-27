import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  materializeLocalPeerFiles,
  stageLocalPeerFile,
} from '../peerFileTransfer.js'

let root = ''
let previousConfigDir: string | undefined

beforeEach(async () => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  root = await mkdtemp(join(tmpdir(), 'peer-file-transfer-'))
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
})

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await rm(root, { recursive: true, force: true })
})

describe('peer file transfer', () => {
  test('stages, verifies, materializes, and removes a local transfer copy', async () => {
    const source = join(root, 'hello peer.txt')
    const bytes = Buffer.from('hello peer \u4e16\u754c\n')
    await writeFile(source, bytes)

    const staged = await stageLocalPeerFile(source)
    expect(staged.file_name).toBe('hello peer.txt')
    expect(staged.file_size).toBe(bytes.length)
    expect(staged.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))

    const materialized = await materializeLocalPeerFiles([staged], 'receiver')
    expect(materialized.received).toBe(1)
    expect(materialized.verified).toBe(1)
    expect(materialized.paths).toHaveLength(1)
    expect(materialized.prefix).toContain('@"')
    expect(await readFile(materialized.paths[0]!)).toEqual(bytes)
    await expect(readFile(staged.path)).rejects.toThrow()
  })

  test('rejects transfer records outside the private spool and bad hashes', async () => {
    const source = join(root, 'outside.txt')
    await writeFile(source, 'outside')
    const bad = {
      path: source,
      file_name: 'outside.txt',
      file_size: 7,
      sha256: '0'.repeat(64),
      media_type: 'text/plain',
    }

    const materialized = await materializeLocalPeerFiles([bad], 'receiver')
    expect(materialized.verified).toBe(0)
    expect(materialized.paths).toEqual([])
    expect(materialized.prefix).toContain('was not delivered')
  })
})
