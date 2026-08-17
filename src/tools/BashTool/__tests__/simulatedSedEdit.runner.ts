import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from '../../FileEditTool/constants.js'
import { BashTool, type BashToolInput } from '../BashTool.js'

let root: string | undefined

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

describe('BashTool simulated sed edits', () => {
  test('rejects an approved edit when the file changed after preview', async () => {
    root = mkdtempSync(join(tmpdir(), 'bash-sed-edit-'))
    const path = join(root, 'fixture.txt')
    writeFileSync(path, 'content shown in preview\n')

    const input = {
      command: `sed -i 's/preview/approved/' ${path}`,
      description: 'Apply approved edit',
      _simulatedSedEdit: {
        filePath: path,
        oldContent: 'content shown in preview\n',
        newContent: 'content approved by user\n',
      },
    } as unknown as BashToolInput
    writeFileSync(path, 'external edit during approval\n')

    const call = BashTool.call(input, {
      readFileState: new Map(),
      updateFileHistoryState: () => {},
    } as unknown as Parameters<typeof BashTool.call>[1])

    await expect(call).rejects.toThrow(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
    expect(readFileSync(path, 'utf8')).toBe('external edit during approval\n')
  })
})
