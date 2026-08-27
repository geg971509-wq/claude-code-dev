import { describe, expect, mock, test } from 'bun:test'
import { ACPClient } from '../acp/client'
import type { ProxyResponse } from '../acp/types'
import { submitAcpPrompt } from '../lib/acp-thread-events'
import { initialThreadState, threadStateReducer } from '../lib/thread-state'

describe('ACPClient prompt completion', () => {
  test('forwards the session id and stop reason', () => {
    const client = new ACPClient({ proxyUrl: 'ws://localhost' })
    const completed: string[][] = []
    client.setPromptCompleteHandler((sessionId, stopReason) => {
      completed.push([sessionId, stopReason])
    })

    const handleResponse = (
      client as unknown as { handleResponse(response: ProxyResponse): void }
    ).handleResponse.bind(client)
    handleResponse({
      type: 'prompt_complete',
      payload: { sessionId: 'session-1', stopReason: 'cancelled' },
    })

    expect(completed).toEqual([['session-1', 'cancelled']])
  })
})

describe('ACPClient errors', () => {
  test('forwards an optional error session id', () => {
    const client = new ACPClient({ proxyUrl: 'ws://localhost' })
    const errors: Array<[string, string | undefined]> = []
    client.setErrorMessageHandler((message, sessionId) => {
      errors.push([message, sessionId])
    })
    const handleResponse = (
      client as unknown as { handleResponse(response: ProxyResponse): void }
    ).handleResponse.bind(client)

    handleResponse({
      type: 'error',
      payload: { message: 'old prompt failed', sessionId: 'session-old' },
    })
    handleResponse({ type: 'error', payload: { message: 'generic error' } })

    expect(errors).toEqual([
      ['old prompt failed', 'session-old'],
      ['generic error', undefined],
    ])
  })

  test('does not reject a new load for a stale prompt error', async () => {
    const client = new ACPClient({ proxyUrl: 'ws://localhost' })
    const send = mock(() => {})
    const internals = client as unknown as {
      sessionId: string | null
      pendingSessionTarget: string | null
      _agentCapabilities: { loadSession: boolean }
      send: typeof send
      handleResponse(response: ProxyResponse): void
    }
    internals.sessionId = 'session-old'
    internals._agentCapabilities = { loadSession: true }
    internals.send = send
    client.setErrorMessageHandler(() => {})

    const load = client.loadSession({ sessionId: 'session-new' })
    let settled = false
    void load.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    internals.handleResponse({
      type: 'error',
      payload: { message: 'old prompt failed', sessionId: 'session-old' },
    })
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(internals.pendingSessionTarget).toBe('session-new')
    internals.handleResponse({
      type: 'session_loaded',
      payload: { sessionId: 'session-new' },
    })
    await expect(load).resolves.toBe('session-new')
  })

  test('still rejects a pending load for an uncorrelated protocol error', async () => {
    const client = new ACPClient({ proxyUrl: 'ws://localhost' })
    const internals = client as unknown as {
      _agentCapabilities: { loadSession: boolean }
      send(message: unknown): void
      handleResponse(response: ProxyResponse): void
    }
    internals._agentCapabilities = { loadSession: true }
    internals.send = mock(() => {})
    client.setErrorMessageHandler(() => {})

    const load = client.loadSession({ sessionId: 'session-new' })
    internals.handleResponse({
      type: 'error',
      payload: { message: 'load failed' },
    })

    await expect(load).rejects.toThrow('load failed')
  })
})

describe('ACPClient prompt session guard', () => {
  test('rejects a mismatched expected session before sending', async () => {
    const client = new ACPClient({ proxyUrl: 'ws://localhost' })
    const send = mock(() => {})
    const internals = client as unknown as {
      sessionId: string | null
      send: typeof send
    }
    internals.sessionId = 'session-new'
    internals.send = send

    await expect(
      client.sendPrompt([{ type: 'text', text: 'hi' }], 'session-old'),
    ).rejects.toThrow('Session changed before prompt send')
    expect(send).not.toHaveBeenCalled()
  })

  test('does not send prepared images into a session selected during preparation', async () => {
    const client = new ACPClient({ proxyUrl: 'ws://localhost' })
    const send = mock(() => {})
    const internals = client as unknown as {
      sessionId: string | null
      send: typeof send
    }
    internals.sessionId = 'session-old'
    internals.send = send
    let state = initialThreadState('session-old')
    let finishPreparation: (image: {
      type: 'image'
      mimeType: string
      data: string
    }) => void = () => {}

    const submission = submitAcpPrompt({
      sessionId: 'session-old',
      content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }],
      prepareImage: () =>
        new Promise(resolve => {
          finishPreparation = resolve
        }),
      sendPrompt: content => client.sendPrompt(content, 'session-old'),
      dispatch: action => {
        state = threadStateReducer(state, action)
      },
    })
    internals.sessionId = 'session-new'
    state = threadStateReducer(state, {
      type: 'reset',
      sessionId: 'session-new',
    })
    finishPreparation({
      type: 'image',
      mimeType: 'image/jpeg',
      data: '/9j/',
    })

    expect(await submission).toMatchObject({ status: 'send_failed' })
    expect(send).not.toHaveBeenCalled()
    expect(state).toEqual(initialThreadState('session-new'))
  })
})
