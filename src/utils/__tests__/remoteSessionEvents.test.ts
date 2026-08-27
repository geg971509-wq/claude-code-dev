import { describe, expect, test } from 'bun:test'
import {
  postRemoteUserEvent,
  type RemoteSessionEventRequest,
} from '../remoteSessionEvents.js'

const request: RemoteSessionEventRequest = {
  baseUrl: 'https://sessions.example.test',
  sessionId: 'session_123',
  content: [{ type: 'text', text: 'hello' }],
  msgId: 'msg-123',
}

const attachment = {
  file_uuid: 'file-1',
  file_name: 'report.txt',
}

describe('postRemoteUserEvent', () => {
  test('posts the official event envelope and authentication headers', async () => {
    const calls: Array<Record<string, unknown>> = []
    const result = await postRemoteUserEvent(request, {
      getAuth: async () => ({
        accessToken: 'oauth-token',
        organizationId: 'org-1',
        trustedDeviceToken: 'device-token',
      }),
      post: async (url, body, config) => {
        calls.push({ url, body, config })
        return { status: 201, data: {} }
      },
    })

    expect(result).toEqual({ ok: true, msgId: 'msg-123', status: 201 })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(
      'https://sessions.example.test/v1/sessions/session_123/events',
    )
    expect(calls[0]?.body).toEqual({
      events: [
        {
          uuid: 'msg-123',
          session_id: 'session_123',
          type: 'user',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'hello' }],
          },
        },
      ],
    })
    expect(calls[0]?.config).toMatchObject({
      headers: {
        Authorization: 'Bearer oauth-token',
        'X-Trusted-Device-Token': 'device-token',
        'x-organization-uuid': 'org-1',
      },
    })
  })

  test('includes uploaded file attachments in the user event', async () => {
    let body: unknown
    const result = await postRemoteUserEvent(
      { ...request, fileAttachments: [attachment] },
      {
        getAuth: async () => ({ accessToken: 'oauth-token' }),
        post: async (_url, nextBody) => {
          body = nextBody
          return { status: 201, data: {} }
        },
      },
    )

    expect(result.ok).toBe(true)
    expect(body).toMatchObject({
      events: [{ file_attachments: [attachment] }],
    })
  })

  test('refreshes once on 401 and reuses the exact event UUID', async () => {
    const tokens = ['stale-token', 'fresh-token']
    const bodies: unknown[] = []
    let refreshes = 0
    const result = await postRemoteUserEvent(request, {
      getAuth: async () => ({ accessToken: tokens.shift()! }),
      refreshAuth: async staleToken => {
        expect(staleToken).toBe('stale-token')
        refreshes++
        return true
      },
      post: async (_url, body, config) => {
        bodies.push(body)
        return {
          status: (config.headers.Authorization as string).includes('stale')
            ? 401
            : 200,
          data: {},
        }
      },
    })

    expect(result).toEqual({ ok: true, msgId: 'msg-123', status: 200 })
    expect(refreshes).toBe(1)
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toEqual(bodies[1])
  })

  test('returns stable error codes for invalid IDs, auth, and rejection', async () => {
    const invalid = await postRemoteUserEvent(
      { ...request, sessionId: '../admin' },
      {
        getAuth: async () => ({ accessToken: 'token' }),
        post: async () => ({ status: 200, data: {} }),
      },
    )
    const unauthorized = await postRemoteUserEvent(request, {
      getAuth: async () => ({ accessToken: 'token' }),
      refreshAuth: async () => false,
      post: async () => ({ status: 401, data: {} }),
    })
    const rejected = await postRemoteUserEvent(request, {
      getAuth: async () => ({ accessToken: 'token' }),
      post: async () => ({ status: 409, data: { error: { message: 'busy' } } }),
    })

    expect(invalid).toMatchObject({ ok: false, errorCode: 'invalid_session' })
    expect(unauthorized).toMatchObject({ ok: false, errorCode: 'unauthorized' })
    expect(rejected).toMatchObject({
      ok: false,
      errorCode: 'rejected',
      error: 'busy',
    })
  })
})
