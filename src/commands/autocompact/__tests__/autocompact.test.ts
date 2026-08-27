import { describe, test } from 'bun:test'
import { relative, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dir, '../../../..')
const runner = `./${relative(
  projectRoot,
  resolve(import.meta.dir, 'autocompact.runner.ts'),
).replaceAll('\\', '/')}`

describe('/autocompact', () => {
  test('runs config persistence tests in an isolated subprocess', async () => {
    const process = Bun.spawn(['bun', 'test', runner], {
      cwd: projectRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await process.exited
    if (exitCode !== 0) {
      const output = `${await new Response(process.stderr).text()}\n${await new Response(process.stdout).text()}`
      throw new Error(
        `autocompact subprocess failed (exit ${exitCode}):\n${output.slice(-3000)}`,
      )
    }
  }, 60_000)
})
