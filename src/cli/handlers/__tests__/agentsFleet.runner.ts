import { resolve } from 'node:path'

const PROJECT_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

export type AgentsCommandResult = {
  durationMs: number
  exitCode: number
  stderr: string
  stdout: string
  timedOut: boolean
}

export async function runAgentsCommand(
  args: string[],
  timeoutMs = 8_000,
  env: NodeJS.ProcessEnv = {},
): Promise<AgentsCommandResult> {
  const startedAt = performance.now()
  const proc = Bun.spawn(
    [
      'bun',
      'run',
      '--feature',
      'CROSS_SESSION_MESSAGING',
      'src/entrypoints/cli.tsx',
      'agents',
      ...args,
    ],
    {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        CLAUDE_CODE_DISABLE_TELEMETRY: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        NODE_ENV: 'production',
        ...env,
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const stdoutPromise = new Response(proc.stdout).text()
  const stderrPromise = new Response(proc.stderr).text()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    proc.kill('SIGKILL')
  }, timeoutMs)

  try {
    const exitCode = await proc.exited
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
    return {
      durationMs: performance.now() - startedAt,
      exitCode,
      stderr,
      stdout,
      timedOut,
    }
  } finally {
    clearTimeout(timeout)
  }
}
