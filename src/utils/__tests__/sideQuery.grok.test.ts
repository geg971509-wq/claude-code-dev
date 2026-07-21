import { describe, test } from 'bun:test'
import { relative, resolve } from 'path'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..')
const RUNNER_ABS = resolve(__dirname, 'sideQuery.grok.isolated.ts')
const RUNNER_REL = './' + relative(PROJECT_ROOT, RUNNER_ABS).replace(/\\/g, '/')

describe('sideQuery Grok path', () => {
  test('runs malformed tool argument tests in an isolated subprocess', async () => {
    const proc = Bun.spawn(['bun', 'test', RUNNER_REL], {
      cwd: PROJECT_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timeout = setTimeout(() => proc.kill(), 5_000)

    try {
      const code = await proc.exited
      if (code !== 0) {
        const stderr = await new Response(proc.stderr).text()
        const stdout = await new Response(proc.stdout).text()
        const output = `${stderr}\n${stdout}`.slice(-3000)
        throw new Error(
          `Grok sideQuery subprocess failed (exit ${code}):\n${output}`,
        )
      }
    } finally {
      clearTimeout(timeout)
    }
  }, 10_000)
})
