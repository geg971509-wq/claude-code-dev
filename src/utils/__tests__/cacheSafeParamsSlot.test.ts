import { describe, test } from 'bun:test'
import { relative, resolve } from 'path'

const PROJECT_ROOT = resolve(import.meta.dir, '..', '..', '..')
const RUNNER_ABS = resolve(import.meta.dir, 'cacheSafeParamsSlot.runner.ts')
const RUNNER_REL = './' + relative(PROJECT_ROOT, RUNNER_ABS).replace(/\\/g, '/')

describe('cache-safe params slot', () => {
  test('runs session-boundary tests in an isolated subprocess', async () => {
    const proc = Bun.spawn(['bun', 'test', RUNNER_REL], {
      cwd: PROJECT_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    if (code !== 0) {
      const [stderr, stdout] = await Promise.all([
        new Response(proc.stderr).text(),
        new Response(proc.stdout).text(),
      ])
      throw new Error(
        `Cache-safe params subprocess failed (exit ${code}):\n${`${stderr}\n${stdout}`.slice(-3000)}`,
      )
    }
  }, 60_000)
})
