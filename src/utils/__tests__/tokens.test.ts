import { describe, test } from 'bun:test'
import { relative, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dir, '../../..')
const runner = `./${relative(
  projectRoot,
  resolve(import.meta.dir, 'tokens.runner.ts'),
).replaceAll('\\', '/')}`

describe('token utilities', () => {
  test('runs mocked token-estimation tests in an isolated subprocess', async () => {
    const process = Bun.spawn(['bun', 'test', runner], {
      cwd: projectRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await process.exited
    if (exitCode !== 0) {
      const output = `${await new Response(process.stderr).text()}\n${await new Response(process.stdout).text()}`
      throw new Error(
        `token utility subprocess failed (exit ${exitCode}):\n${output.slice(-3000)}`,
      )
    }
  }, 60_000)
})
