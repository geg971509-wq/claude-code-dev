import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..')

async function runScript(source: string): Promise<{
  code: number
  output: string
}> {
  const proc = Bun.spawn([process.execPath, '-e', source], {
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

const setup = `
  import { mock } from 'bun:test'
  mock.module('src/bootstrap/state.js', () => ({
    getIsInteractive: () => false,
    getIsScrollDraining: () => false,
    getLastMainRequestId: () => undefined,
    getSessionId: () => 'test-session',
    isSessionPersistenceDisabled: () => true,
  }))
  mock.module('src/services/analytics/datadog.js', () => ({
    shutdownDatadog: async () => {},
  }))
  mock.module('src/services/analytics/firstPartyEventLogger.js', () => ({
    shutdown1PEventLogging: async () => {},
  }))
  mock.module('src/services/analytics/index.js', () => ({
    logEvent: () => {},
  }))
  let cleanupRuns = 0
  process.on('exit', () => console.error('cleanup-runs:' + cleanupRuns))
  mock.module('src/utils/cleanupRegistry.js', () => ({
    runCleanupFunctions: async () => {
      cleanupRuns++
      if (process.env.SHUTDOWN_TEST_MODE === 'fatal-race') {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    },
  }))
  mock.module('src/utils/debug.js', () => ({
    logForDebugging: message => console.error('debug:' + message),
  }))
  mock.module('src/utils/diagLogs.js', () => ({
    logForDiagnosticsNoPII: (_level, event) => console.error('diagnostic:' + event),
  }))
  mock.module('src/utils/envUtils.js', () => ({ isEnvTruthy: () => false }))
  mock.module('src/utils/sessionStorage.js', () => ({
    getCurrentSessionTitle: () => undefined,
    sessionIdExists: () => false,
  }))
  mock.module('src/utils/sleep.js', () => ({ sleep: async () => {} }))
  mock.module('src/utils/sentry.js', () => ({ closeSentry: async () => {} }))
  mock.module('src/utils/startupProfiler.js', () => ({ profileReport: () => {} }))
  mock.module('src/utils/hooks.js', () => ({
    executeSessionEndHooks: async () => {
      if (process.env.SHUTDOWN_TEST_MODE === 'failsafe') {
        await new Promise(() => {})
      }
    },
    getSessionEndHookTimeoutMs: () => {
      if (process.env.SHUTDOWN_TEST_MODE === 'sync-rejection') {
        throw new Error('hook timeout lookup failed')
      }
      return 0
    },
  }))
  const {
    gracefulShutdown,
    gracefulShutdownSync,
    resetShutdownState,
    setSigintInterceptor,
    setupGracefulShutdown,
  } = await import('src/utils/gracefulShutdown.js')
  resetShutdownState()
  setupGracefulShutdown()
`

describe('gracefulShutdown fatal handlers', () => {
  test('main does not register a duplicate SIGINT process.exit handler', () => {
    const source = readFileSync(resolve(PROJECT_ROOT, 'src/main.tsx'), 'utf8')
    expect(source).not.toContain("process.on('SIGINT'")
  })

  test('interactive bash command claims SIGINT, aborts, then releases it', async () => {
    const { code, output } = await runScript(`
      ${setup}
      mock.module('@anthropic/ink', () => ({ instances: new Map() }))
      mock.module('src/components/BashModeProgress.tsx', () => ({
        BashModeProgress: () => null,
      }))
      mock.module('src/utils/renderOptions.ts', () => ({
        getBaseRenderOptions: () => ({}),
      }))
      mock.module('src/tools/BashTool/BashTool.tsx', () => ({
        BashTool: {
          call: async (_input, context) => {
            await new Promise(resolve =>
              context.abortController.signal.addEventListener('abort', resolve, { once: true })
            )
            console.error('abort-reason:' + context.abortController.signal.reason)
            throw new Error('cancelled shell')
          },
        },
      }))
      mock.module('src/utils/messages.ts', () => ({
        createSyntheticUserCaveatMessage: () => ({ type: 'system' }),
        createUserInterruptionMessage: () => ({ type: 'user' }),
        createUserMessage: ({ content }) => ({ type: 'user', message: { role: 'user', content } }),
        prepareUserContent: ({ inputString }) => inputString,
      }))
      mock.module('src/utils/shell/resolveDefaultShell.ts', () => ({
        resolveDefaultShell: () => 'bash',
      }))
      mock.module('src/utils/shell/shellToolUtils.ts', () => ({
        isPowerShellToolEnabled: () => false,
      }))
      mock.module('src/utils/toolResultStorage.ts', () => ({
        processToolResultBlock: async () => ({ content: '' }),
      }))
      mock.module('src/utils/xml.ts', () => ({ escapeXml: value => String(value) }))

      const { processBashCommand } = await import('src/utils/processUserInput/processBashCommand.tsx')
      const abortController = new AbortController()
      const command = processBashCommand(
        'git push -u origin master',
        [],
        [],
        {
          options: { isNonInteractiveSession: false, verbose: false },
          abortController,
        },
        () => {},
      )
      setTimeout(() => process.kill(process.pid, 'SIGINT'), 20)
      await command
      console.error('bash-done')
      process.kill(process.pid, 'SIGINT')
    `)

    expect(code).toBe(0)
    expect(output).toContain('abort-reason:user-cancel')
    expect(output).toContain('bash-done')
    expect(output).toContain('diagnostic:shutdown_signal')
    expect(output).toContain('cleanup-runs:1')
  })

  test('failsafe still exits when hook timeout lookup fails', async () => {
    const { code, output } = await runScript(`
      process.env.SHUTDOWN_TEST_MODE = 'sync-rejection'
      ${setup}
      const keepAlive = setInterval(() => {}, 1000)
      process.on('exit', () => clearInterval(keepAlive))
      void gracefulShutdown(1).catch(error => {
        console.error('rejection:' + error.message)
      })
      setTimeout(() => process.exit(9), 6500)
    `)

    expect(code).toBe(1)
    expect(output).toContain('rejection:hook timeout lookup failed')
    expect(output).toContain('cleanup-runs:0')
  }, 15_000)

  test('clean shutdown escalates when a fatal error arrives during cleanup', async () => {
    const { code, output } = await runScript(`
      process.env.SHUTDOWN_TEST_MODE = 'fatal-race'
      ${setup}
      const first = gracefulShutdown(0)
      const shared = gracefulShutdown(0)
      console.error('same-promise:' + (first === shared))
      setTimeout(() => { throw new Error('fatal during shutdown') }, 20)
      await first
    `)

    expect(code).toBe(1)
    expect(output).toContain('diagnostic:uncaught_exception')
    expect(output).toContain('same-promise:true')
    expect(output).toContain('cleanup-runs:1')
  })

  test('failsafe uses an exit code raised after shutdown starts', async () => {
    const { code, output } = await runScript(`
      process.env.SHUTDOWN_TEST_MODE = 'failsafe'
      ${setup}
      const keepAlive = setInterval(() => {}, 1000)
      const first = gracefulShutdown(0)
      process.on('uncaughtException', () => {
        const shared = gracefulShutdown(1)
        console.error('same-promise:' + (first === shared))
        console.error('exit-code:' + process.exitCode)
      })
      setTimeout(() => { throw new Error('fatal during hung shutdown') }, 20)
      await first
      clearInterval(keepAlive)
    `)

    expect(code).toBe(1)
    expect(output).toContain('same-promise:true')
    expect(output).toContain('exit-code:1')
    expect(output).toContain('cleanup-runs:1')
  }, 15_000)

  test('sync rejection fallback uses the latest exit code', async () => {
    const { code, output } = await runScript(`
      process.env.SHUTDOWN_TEST_MODE = 'sync-rejection'
      ${setup}
      gracefulShutdownSync(0)
      gracefulShutdownSync(1)
    `)

    expect(code).toBe(1)
    expect(output).toContain('debug:Graceful shutdown failed:')
    expect(output).toContain('cleanup-runs:0')
  })

  test('primitive fatal values exit 1 without a secondary TypeError', async () => {
    for (const [trigger, diagnostic] of [
      [`setTimeout(() => { throw 42 }, 0)`, 'uncaught_exception'],
      [`Promise.reject('primitive rejection')`, 'unhandled_rejection'],
    ]) {
      const { code, output } = await runScript(`${setup}\n${trigger}`)
      expect(code).toBe(1)
      expect(output).toContain(`diagnostic:${diagnostic}`)
      expect(output).not.toContain('TypeError')
    }
  }, 30_000)

  test('shared AbortError exits 0 after one ordered cleanup', async () => {
    const { code, output } = await runScript(`
      import { AbortError } from './src/utils/errors.ts'
      ${setup}
      setTimeout(() => { throw new AbortError('cancelled') }, 0)
    `)

    expect(code).toBe(0)
    expect(output).toContain('cleanup-runs:1')
    expect(output).not.toContain('diagnostic:')
  })

  test('named AbortError exits 0 after one ordered cleanup', async () => {
    const { code, output } = await runScript(`
      ${setup}
      const namedAbort = new Error('cancelled')
      namedAbort.name = 'AbortError'
      setTimeout(() => { throw namedAbort }, 0)
    `)

    expect(code).toBe(0)
    expect(output).toContain('cleanup-runs:1')
    expect(output).not.toContain('diagnostic:')
  })

  test('rejected abort remains silent and non-fatal', async () => {
    const { code, output } = await runScript(`
      import { AbortError } from './src/utils/errors.ts'
      ${setup}
      Promise.reject(new AbortError('cancelled'))
    `)

    expect(code).toBe(0)
    expect(output).toContain('cleanup-runs:0')
    expect(output).not.toContain('diagnostic:')
  })
})
