import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, truncate, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  canSendRemotePeerFiles,
  inspectPeerFiles,
  MAX_PEER_FILE_BYTES,
} from '../SendFileTool.js'

let dir: string | undefined

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

describe('inspectPeerFiles', () => {
  test('resolves readable relative files and keeps per-file failures', async () => {
    dir = await mkdtemp(join(tmpdir(), 'send-file-'))
    await writeFile(join(dir, 'ok.txt'), 'hello')

    const result = await inspectPeerFiles(['ok.txt', '.', 'missing.txt'], dir)

    expect(result[0]).toMatchObject({
      path: join(dir, 'ok.txt'),
      fileName: 'ok.txt',
      size: 5,
    })
    expect(result[0]?.error).toBeUndefined()
    expect(result[1]?.error).toContain('regular file')
    expect(result[2]?.error).toContain('not readable')
  })

  test('rejects a file that exceeds the transfer limit', async () => {
    dir = await mkdtemp(join(tmpdir(), 'send-file-'))
    const path = join(dir, 'large.bin')
    await writeFile(path, '')
    await truncate(path, MAX_PEER_FILE_BYTES + 1)

    expect((await inspectPeerFiles([path], dir))[0]?.error).toContain('30 MB')
  })
})

describe('canSendRemotePeerFiles', () => {
  test('requires first-party transport, policy approval, and nonessential traffic', () => {
    expect(canSendRemotePeerFiles('firstParty', true, false)).toBeTrue()
    expect(canSendRemotePeerFiles('openai', true, false)).toBeFalse()
    expect(canSendRemotePeerFiles('firstParty', false, false)).toBeFalse()
    expect(canSendRemotePeerFiles('firstParty', true, true)).toBeFalse()
  })
})
