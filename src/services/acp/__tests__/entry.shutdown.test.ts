import { describe, expect, test } from 'bun:test'
import { relative, resolve } from 'path'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..', '..')
const RUNNER_ABS = resolve(__dirname, 'entry.shutdown.runner.ts')
const RUNNER_REL = './' + relative(PROJECT_ROOT, RUNNER_ABS).replace(/\\/g, '/')

async function runScenario(scenario: string): Promise<{
  code: number
  output: string
}> {
  const proc = Bun.spawn([process.execPath, RUNNER_REL, scenario], {
    cwd: PROJECT_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const code = await proc.exited
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, output: `${stderr}\n${stdout}` }
}

function count(output: string, value: string): number {
  return output.split(value).length - 1
}

describe('ACP entry shutdown', () => {
  test('fatal rejection waits for session cleanup before exiting 1', async () => {
    const { code, output } = await runScenario('fatal')

    expect(code).toBe(1)
    expect(output.indexOf('close:end')).toBeLessThan(output.indexOf('exit:1'))
    expect(count(output, 'close:start')).toBe(1)
    expect(count(output, 'exit:')).toBe(1)
  })

  test('normal shutdown racing fatal closes once and exits 1 once', async () => {
    const { code, output } = await runScenario('race')

    expect(code).toBe(1)
    expect(count(output, 'close:start')).toBe(1)
    expect(count(output, 'exit:1')).toBe(1)
    expect(count(output, 'exit:')).toBe(1)
  })

  test('abort rejection is ignored', async () => {
    const { code, output } = await runScenario('abort')

    expect(code).toBe(0)
    expect(output).not.toContain('close:start')
    expect(output).not.toContain('exit:')
  })
})
