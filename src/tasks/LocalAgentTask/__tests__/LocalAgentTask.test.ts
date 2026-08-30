/**
 * LocalAgentTask.runner.ts installs many process-global mock.module() stubs.
 * Run it in a subprocess so those stubs cannot leak into unrelated test files.
 */
import { describe, test } from 'bun:test'
import { relative, resolve } from 'path'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..', '..')
const RUNNER_ABS = resolve(__dirname, 'LocalAgentTask.runner.ts')
const RUNNER_REL = './' + relative(PROJECT_ROOT, RUNNER_ABS).replace(/\\/g, '/')

describe('LocalAgentTask', () => {
  test('runs LocalAgentTask tests in an isolated subprocess', async () => {
    const proc = Bun.spawn([process.execPath, 'test', RUNNER_REL], {
      cwd: PROJECT_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text()
      const stdout = await new Response(proc.stdout).text()
      throw new Error(
        `LocalAgentTask subprocess failed (exit ${code}):\n${(stderr + '\n' + stdout).slice(-5000)}`,
      )
    }
  }, 60_000)
})
