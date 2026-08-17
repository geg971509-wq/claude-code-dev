/**
 * 薄层子进程包装器。SearchExtraToolsTool.runner.ts 用 mock.module 替换了
 * src/services/searchExtraTools/toolIndex.js 和 src/constants/tools.js —
 * 两者都是 process-global 的，会让 toolIndex.test.ts 拿到 stub 而不是真实
 * 实现。放进独立进程后互不影响。
 */
import { describe, expect, test } from 'bun:test'
import { relative, resolve } from 'path'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..', '..')
const RUNNER_ABS = resolve(__dirname, 'SearchExtraToolsTool.runner.ts')
const RUNNER_REL = './' + relative(PROJECT_ROOT, RUNNER_ABS).replace(/\\/g, '/')

describe('SearchExtraToolsTool', () => {
  test('runs all SearchExtraToolsTool tests in isolated subprocess', async () => {
    const proc = Bun.spawn(['bun', 'test', RUNNER_REL], {
      cwd: PROJECT_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text()
      const stdout = await new Response(proc.stdout).text()
      throw new Error(
        `SearchExtraToolsTool subprocess failed (exit ${code}):\n${(stderr + '\n' + stdout).slice(-3000)}`,
      )
    }
    expect(code).toBe(0)
  }, 60_000)
})
