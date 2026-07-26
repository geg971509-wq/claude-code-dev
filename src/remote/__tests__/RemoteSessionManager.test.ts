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
  test('retains a permission request until a response is accepted', async () => {
    const { code, output } = await runIsolated(`
      import { mock } from 'bun:test'
      import { debugMock } from './tests/mocks/debug.ts'
      import { logMock } from './tests/mocks/log.ts'

      let websocketCallbacks
      const sent = []
      const sendResults = [false, true]
      let reconnects = 0
      mock.module('src/utils/debug.ts', debugMock)
      mock.module('src/utils/log.ts', logMock)
      mock.module('src/utils/teleport/api.ts', () => ({
        sendEventToRemoteSession: async () => true,
      }))
      mock.module('src/remote/SessionsWebSocket.ts', () => ({
        SessionsWebSocket: class {
          constructor(_sessionId, _orgUuid, _getAccessToken, callbacks) {
            websocketCallbacks = callbacks
          }
          connect() { return Promise.resolve() }
          close() {}
          reconnect() { reconnects++ }
          isConnected() { return true }
          sendControlRequest() {}
          sendControlResponse(response) {
            sent.push(response)
            return sendResults.shift() ?? true
          }
        },
      }))

      const { RemoteSessionManager } = await import(
        'src/remote/RemoteSessionManager.ts'
      )
      let permissionRequests = 0
      const manager = new RemoteSessionManager(
        {
          sessionId: 'session-1',
          orgUuid: 'org-1',
          getAccessToken: () => 'token',
        },
        {
          onMessage() {},
          onPermissionRequest() { permissionRequests++ },
        },
      )
      manager.connect()
      websocketCallbacks.onMessage({
        type: 'control_request',
        request_id: 'request-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          tool_use_id: 'tool-1',
          input: {},
        },
      })

      const first = manager.respondToPermissionRequest('request-1', {
        behavior: 'deny',
        message: 'not now',
      })
      manager.reconnect()
      const sendsAfterReconnect = sent.length
      const second = manager.respondToPermissionRequest('request-1', {
        behavior: 'allow',
        updatedInput: {},
      })
      const third = manager.respondToPermissionRequest('request-1', {
        behavior: 'deny',
        message: 'already handled',
      })

      console.log(JSON.stringify({
        first,
        second,
        third,
        sendCount: sent.length,
        sendsAfterReconnect,
        reconnects,
        permissionRequests,
      }))
    `)

    expect(code).toBe(0)
    expect(output).toContain(
      JSON.stringify({
        first: false,
        second: true,
        third: false,
        sendCount: 2,
        sendsAfterReconnect: 1,
        reconnects: 1,
        permissionRequests: 1,
      }),
    )
  })

  test('server cancellation removes a retained permission request', async () => {
    const { code, output } = await runIsolated(`
      import { mock } from 'bun:test'
      import { debugMock } from './tests/mocks/debug.ts'
      import { logMock } from './tests/mocks/log.ts'

      let websocketCallbacks
      let sendCount = 0
      mock.module('src/utils/debug.ts', debugMock)
      mock.module('src/utils/log.ts', logMock)
      mock.module('src/utils/teleport/api.ts', () => ({
        sendEventToRemoteSession: async () => true,
      }))
      mock.module('src/remote/SessionsWebSocket.ts', () => ({
        SessionsWebSocket: class {
          constructor(_sessionId, _orgUuid, _getAccessToken, callbacks) {
            websocketCallbacks = callbacks
          }
          connect() { return Promise.resolve() }
          close() {}
          reconnect() {}
          isConnected() { return true }
          sendControlRequest() {}
          sendControlResponse() { sendCount++; return false }
        },
      }))

      const { RemoteSessionManager } = await import(
        'src/remote/RemoteSessionManager.ts'
      )
      const cancelled = []
      const manager = new RemoteSessionManager(
        {
          sessionId: 'session-1',
          orgUuid: 'org-1',
          getAccessToken: () => 'token',
        },
        {
          onMessage() {},
          onPermissionRequest() {},
          onPermissionCancelled(requestId, toolUseId) {
            cancelled.push([requestId, toolUseId])
          },
        },
      )
      manager.connect()
      websocketCallbacks.onMessage({
        type: 'control_request',
        request_id: 'request-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          tool_use_id: 'tool-1',
          input: {},
        },
      })
      const first = manager.respondToPermissionRequest('request-1', {
        behavior: 'deny',
        message: 'not now',
      })
      websocketCallbacks.onMessage({
        type: 'control_cancel_request',
        request_id: 'request-1',
      })
      const afterCancel = manager.respondToPermissionRequest('request-1', {
        behavior: 'deny',
        message: 'too late',
      })

      console.log(JSON.stringify({ first, afterCancel, sendCount, cancelled }))
    `)

    expect(code).toBe(0)
    expect(output).toContain(
      JSON.stringify({
        first: false,
        afterCancel: false,
        sendCount: 1,
        cancelled: [['request-1', 'tool-1']],
      }),
    )
  })

  test('remote permission UI stays pending until delivery succeeds', async () => {
    const { code, output } = await runIsolated(`
      import { mock } from 'bun:test'
      import * as React from 'react'
      import { debugMock } from './tests/mocks/debug.ts'
      import { logMock } from './tests/mocks/log.ts'

      let managerCallbacks
      let accepted = false
      mock.module('src/utils/debug.ts', debugMock)
      mock.module('src/utils/log.ts', logMock)
      mock.module('src/remote/RemoteSessionManager.ts', () => ({
        RemoteSessionManager: class {
          constructor(_config, callbacks) { managerCallbacks = callbacks }
          connect() {}
          disconnect() {}
          respondToPermissionRequest() { return accepted }
          sendMessage() { return Promise.resolve(true) }
          cancelSession() {}
        },
      }))

      const { renderToString } = await import('src/utils/staticRender.tsx')
      const { AppStoreContext } = await import('src/state/AppState.tsx')
      const { getDefaultAppState } = await import('src/state/AppStateStore.ts')
      const { createStore } = await import('src/state/store.ts')
      const { useRemoteSession } = await import('src/hooks/useRemoteSession.ts')
      let queue = []
      let messages = []
      const loading = []
      const setQueue = updater => {
        queue = typeof updater === 'function' ? updater(queue) : updater
      }
      const setMessages = updater => {
        messages = typeof updater === 'function' ? updater(messages) : updater
      }
      function Probe() {
        useRemoteSession({
          config: {
            sessionId: 'session-1',
            orgUuid: 'org-1',
            getAccessToken: () => 'token',
          },
          setMessages,
          setIsLoading(value) { loading.push(value) },
          setToolUseConfirmQueue: setQueue,
          tools: [],
        })
        return null
      }

      const store = createStore(getDefaultAppState())
      await renderToString(
        React.createElement(
          AppStoreContext.Provider,
          { value: store },
          React.createElement(Probe),
        ),
      )
      managerCallbacks.onPermissionRequest({
        subtype: 'can_use_tool',
        tool_name: 'UnknownTool',
        tool_use_id: 'tool-1',
        input: {},
      }, 'request-1')
      const prompt = queue[0]
      prompt.onAllow({}, [])
      const failed = {
        queueLength: queue.length,
        loading: [...loading],
        warnings: messages.filter(message => message.level === 'warning').length,
      }

      accepted = true
      prompt.onAllow({}, [])
      console.log(JSON.stringify({
        failed,
        succeeded: {
          queueLength: queue.length,
          loading: [...loading],
          warnings: messages.filter(message => message.level === 'warning').length,
        },
      }))
    `)

    if (code !== 0) throw new Error(output)
    expect(output).toContain(
      JSON.stringify({
        failed: {
          queueLength: 1,
          loading: [false],
          warnings: 1,
        },
        succeeded: {
          queueLength: 0,
          loading: [false, true],
          warnings: 1,
        },
      }),
    )
  })

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
