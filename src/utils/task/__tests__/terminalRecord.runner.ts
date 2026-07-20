import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'path'
import { logMock } from '../../../../tests/mocks/log'
import { stateMock } from '../../../../tests/mocks/state'

let root = ''

mock.module('src/bootstrap/state.js', stateMock)
mock.module('src/utils/permissions/filesystem.js', () => ({
  getProjectTempDir: () => root,
}))
mock.module('src/utils/log.ts', logMock)

const {
  _clearOutputsForTest,
  _resetTaskOutputDirForTest,
  cleanupTaskOutput,
  getTaskOutputDir,
  readTerminalTaskRecord,
  writeTerminalTaskRecord,
} = await import('../diskOutput.js')

function record(overrides: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    id: 'a1234567890abcde',
    type: 'local_agent' as const,
    status: 'completed' as const,
    description: 'test agent',
    startTime: 1,
    endTime: 2,
    prompt: 'inspect code',
    result: 'done',
    ...overrides,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-terminal-record-'))
  _resetTaskOutputDirForTest()
})

afterEach(async () => {
  await _clearOutputsForTest()
  rmSync(root, { recursive: true, force: true })
})

describe('terminal task records', () => {
  test('atomically overwrites a prior terminal generation', async () => {
    await writeTerminalTaskRecord(record({ result: 'first', endTime: 2 }))
    await writeTerminalTaskRecord(record({ result: 'second', endTime: 3 }))

    expect(await readTerminalTaskRecord('a1234567890abcde')).toEqual(
      record({ result: 'second', endTime: 3 }),
    )
  })

  test('returns null for missing, malformed, or mismatched records', async () => {
    expect(await readTerminalTaskRecord('a1234567890abcde')).toBeNull()

    mkdirSync(getTaskOutputDir(), { recursive: true })
    const path = join(getTaskOutputDir(), 'a1234567890abcde.meta.json')
    writeFileSync(path, '{broken')
    expect(await readTerminalTaskRecord('a1234567890abcde')).toBeNull()

    writeFileSync(path, JSON.stringify(record({ version: 2 })))
    expect(await readTerminalTaskRecord('a1234567890abcde')).toBeNull()

    writeFileSync(path, JSON.stringify(record({ id: 'a000000000000000' })))
    expect(await readTerminalTaskRecord('a1234567890abcde')).toBeNull()
  })

  test('rejects traversal and symlink records', async () => {
    expect(await readTerminalTaskRecord('../outside')).toBeNull()

    mkdirSync(getTaskOutputDir(), { recursive: true })
    const target = join(root, 'outside.json')
    writeFileSync(target, JSON.stringify(record()))
    symlinkSync(target, join(getTaskOutputDir(), 'a1234567890abcde.meta.json'))
    expect(await readTerminalTaskRecord('a1234567890abcde')).toBeNull()
  })

  test('bounds persisted text fields', async () => {
    await writeTerminalTaskRecord(record({ result: 'x'.repeat(100_000) }))

    expect(
      (await readTerminalTaskRecord('a1234567890abcde'))?.result?.length,
    ).toBe(64 * 1024)
  })

  test('cleanup removes output and terminal metadata', async () => {
    await writeTerminalTaskRecord(record())
    mkdirSync(getTaskOutputDir(), { recursive: true })
    const outputPath = join(getTaskOutputDir(), 'a1234567890abcde.output')
    const metadataPath = join(getTaskOutputDir(), 'a1234567890abcde.meta.json')
    writeFileSync(outputPath, 'output')

    await cleanupTaskOutput('a1234567890abcde')

    expect(existsSync(outputPath)).toBe(false)
    expect(existsSync(metadataPath)).toBe(false)
  })
})
