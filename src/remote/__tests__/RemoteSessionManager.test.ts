import { describe, expect, test } from 'bun:test'
import { resolve } from 'path'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..')

async function runIsolated(source: string): Promise<{
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
  return { code, output: `${stdout}\n${stderr}` }
}

describe('RemoteSessionManager', () => {
  test('owns initial connection rejection without leaking unhandledRejection', async () => {
    const { code, output } = await runIsolated(`
      import { mock } from 'bun:test'
      import { debugMock } from './tests/mocks/debug.ts'
      import { logMock } from './tests/mocks/log.ts'

      mock.module('src/utils/debug.ts', debugMock)
      mock.module('src/utils/log.ts', logMock)
      mock.module('src/utils/teleport/api.ts', () => ({
        sendEventToRemoteSession: async () => true,
      }))
      mock.module('src/remote/SessionsWebSocket.ts', () => ({
        SessionsWebSocket: class {
          connect() { return Promise.reject('setup failed') }
          close() {}
          reconnect() {}
          isConnected() { return false }
          sendControlRequest() {}
          sendControlResponse() {}
        },
      }))

      const { RemoteSessionManager } = await import(
        'src/remote/RemoteSessionManager.ts'
      )
      const errors = []
      let disconnected = 0
      let unhandled = 0
      process.on('unhandledRejection', () => { unhandled++ })

      const manager = new RemoteSessionManager(
        {
          sessionId: 'session-1',
          orgUuid: 'org-1',
          getAccessToken: () => 'token',
        },
        {
          onMessage() {},
          onPermissionRequest() {},
          onError(error) { errors.push(error) },
          onDisconnected() { disconnected++ },
        },
      )
      manager.connect()
      await new Promise(resolve => setTimeout(resolve, 20))
      console.log(JSON.stringify({
        disconnected,
        unhandled,
        errorCount: errors.length,
        errorIsError: errors[0] instanceof Error,
        errorMessage: errors[0]?.message,
      }))
    `)

    expect(code).toBe(0)
    expect(output).toContain(
      JSON.stringify({
        disconnected: 1,
        unhandled: 0,
        errorCount: 1,
        errorIsError: true,
        errorMessage: 'setup failed',
      }),
    )
  })
})
