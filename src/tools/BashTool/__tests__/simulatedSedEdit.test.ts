/**
 * Thin subprocess wrapper so process-global mock.module state cannot replace
 * BashTool's filesystem dependencies.
 */
import { describe, test } from 'bun:test'
import { relative, resolve } from 'node:path'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..', '..')
const RUNNER_ABS = resolve(__dirname, 'simulatedSedEdit.runner.ts')
const RUNNER_REL = './' + relative(PROJECT_ROOT, RUNNER_ABS).replace(/\\/g, '/')

describe('BashTool simulated sed edits', () => {
  test('runs the stale-preview regression in an isolated subprocess', async () => {
    const proc = Bun.spawn(['bun', 'test', RUNNER_REL], {
      cwd: PROJECT_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text()
      const stdout = await new Response(proc.stdout).text()
      const output = (stderr + '\n' + stdout).slice(-3000)
      throw new Error(
        `simulatedSedEdit subprocess failed (exit ${code}):\n${output}`,
      )
    }
  }, 60_000)
})
