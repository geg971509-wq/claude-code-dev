import { describe, test } from 'bun:test'
import { relative, resolve } from 'path'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..', '..', '..')
const RUNNER_ABS = resolve(__dirname, 'queryModelGemini.isolated.ts')
const RUNNER_REL = './' + relative(PROJECT_ROOT, RUNNER_ABS).replace(/\\/g, '/')

describe('queryModelGemini', () => {
  test('runs final usage tests in an isolated subprocess', async () => {
    const proc = Bun.spawn(['bun', 'test', RUNNER_REL], {
      cwd: PROJECT_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timeout = setTimeout(() => proc.kill(), 10_000)

    try {
      const code = await proc.exited
      if (code !== 0) {
        const stderr = await new Response(proc.stderr).text()
        const stdout = await new Response(proc.stdout).text()
        const output = `${stderr}\n${stdout}`.slice(-3000)
        throw new Error(
          `Gemini query subprocess failed (exit ${code}):\n${output}`,
        )
      }
    } finally {
      clearTimeout(timeout)
    }
  }, 15_000)
})
