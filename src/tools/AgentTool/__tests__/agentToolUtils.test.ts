/**
 * 薄层子进程包装器。agentToolUtils.runner.ts 用 mock.module 替换了
 * src/Tool.js、src/constants/tools.js、src/utils/messages.js、
 * src/services/AgentSummary/agentSummary.js 等多个共享模块 —— mock.module
 * 是 process-global 的，这些 stub 会漏给 agentSummary.test.ts 之类的文件。
 * 放进独立进程后互不影响。
 */
import { describe, expect, test } from 'bun:test'
import { relative, resolve } from 'path'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..', '..')
const RUNNER_ABS = resolve(__dirname, 'agentToolUtils.runner.ts')
const RUNNER_REL = './' + relative(PROJECT_ROOT, RUNNER_ABS).replace(/\\/g, '/')

describe('agentToolUtils', () => {
  test('runs all agentToolUtils tests in isolated subprocess', async () => {
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
        `agentToolUtils subprocess failed (exit ${code}):\n${(stderr + '\n' + stdout).slice(-3000)}`,
      )
    }
    expect(code).toBe(0)
  }, 60_000)
})
