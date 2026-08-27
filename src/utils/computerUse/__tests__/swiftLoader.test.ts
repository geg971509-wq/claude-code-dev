import { describe, test } from 'bun:test'
import { relative, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dir, '../../../..')
const runner = resolve(import.meta.dir, 'swiftLoader.runner.ts')
const runnerRelative = `./${relative(projectRoot, runner).replace(/\\/g, '/')}`

describe('computer-use Swift loader', () => {
  test('runs TCC bridge tests in an isolated subprocess', async () => {
    const proc = Bun.spawn(['bun', 'test', runnerRelative], {
      cwd: projectRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    if (code !== 0) {
      const output = `${await new Response(proc.stderr).text()}\n${await new Response(proc.stdout).text()}`
      throw new Error(
        `computer-use Swift loader subprocess failed (exit ${code}):\n${output.slice(-5000)}`,
      )
    }
  }, 30_000)
})
