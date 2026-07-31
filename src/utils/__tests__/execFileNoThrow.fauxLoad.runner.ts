import { expect, mock, test } from 'bun:test'
import { logMock } from '../../../tests/mocks/log'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/fauxExec.js', () => {
  throw new Error('synthetic faux module load failure')
})

process.env.CLAUDE_CODE_USE_FAUX_EXEC = '1'
process.env.CLAUDE_CODE_FAUX_EXEC_SCRIPT = '/tmp/faux-exec.json'

const { execFileNoThrowWithCwd } = await import('../execFileNoThrow.js')

test('resolves when the faux exec module cannot load', async () => {
  const result = await execFileNoThrowWithCwd('git', ['status'])

  expect(result.code).toBe(1)
  expect(result.error).toContain('[faux exec]')
  expect(result.error).toContain('synthetic faux module load failure')
})
