import { describe, test } from 'bun:test'
import { relative, resolve } from 'path'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..', '..', '..')
const RUNNER_ABS = resolve(__dirname, 'queryModelGrok.isolated.ts')
const RUNNER_REL = './' + relative(PROJECT_ROOT, RUNNER_ABS).replace(/\\/g, '/')

describe('queryModelGrok', () => {
  test('runs query tests in an isolated subprocess', async () => {
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (
        key.startsWith('GROK_') ||
        key === 'CLAUDE_CODE_MAX_RETRIES' ||
        key === 'OPENAI_STREAM_IDLE_TIMEOUT_MS'
      ) {
        delete env[key]
      }
    }

    const proc = Bun.spawn(['bun', 'test', RUNNER_REL], {
      cwd: PROJECT_ROOT,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text()
      const stdout = await new Response(proc.stdout).text()
      const output = `${stderr}\n${stdout}`.slice(-3000)
      throw new Error(`Grok query subprocess failed (exit ${code}):\n${output}`)
    }
  }, 60_000)
})
