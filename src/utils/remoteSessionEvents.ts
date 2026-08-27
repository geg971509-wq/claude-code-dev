import { errorMessage } from './errors.js'

export type RemoteSessionEventRequest = {
  baseUrl: string
  sessionId: string
  content: string | Array<{ type: string; [key: string]: unknown }>
  msgId: string
  fileAttachments?: RemoteFileAttachment[]
}

export type RemoteFileAttachment = {
  file_uuid: string
  file_name: string
  is_image?: boolean
  file_size?: number
  sha256?: string
  media_type?: string
}

type RemoteSessionEventAuth = {
  accessToken: string
  organizationId?: string
  trustedDeviceToken?: string
}

type HttpResponse = { status: number; data: unknown }

type RemoteSessionEventDeps = {
  getAuth: () => Promise<RemoteSessionEventAuth>
  post: (
    url: string,
    body: unknown,
    config: {
      headers: Record<string, string>
      timeout: number
      validateStatus: (status: number) => boolean
    },
  ) => Promise<HttpResponse>
  refreshAuth?: (staleAccessToken: string) => Promise<boolean>
}

type RemoteSessionEventResult =
  | { ok: true; msgId: string; status: number }
  | {
      ok: false
      msgId: string
      errorCode:
        | 'invalid_session'
        | 'unauthorized'
        | 'rejected'
        | 'network_error'
      error: string
      status?: number
    }

const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/

function headers(auth: RemoteSessionEventAuth): Record<string, string> {
  const result: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'ccr-byoc-2025-07-29',
  }
  if (auth.organizationId) {
    result['x-organization-uuid'] = auth.organizationId
  }
  if (auth.trustedDeviceToken) {
    result['X-Trusted-Device-Token'] = auth.trustedDeviceToken
  }
  return result
}

function responseError(data: unknown, status: number): string {
  if (typeof data === 'object' && data !== null) {
    const error = (data as { error?: unknown }).error
    if (typeof error === 'string') return error
    if (typeof error === 'object' && error !== null) {
      const message = (error as { message?: unknown }).message
      if (typeof message === 'string') return message
    }
  }
  return `HTTP ${status}`
}

export async function postRemoteUserEvent(
  request: RemoteSessionEventRequest,
  deps: RemoteSessionEventDeps,
): Promise<RemoteSessionEventResult> {
  if (!SAFE_SESSION_ID.test(request.sessionId)) {
    return {
      ok: false,
      msgId: request.msgId,
      errorCode: 'invalid_session',
      error: 'Invalid target session ID',
    }
  }

  const body = {
    events: [
      {
        uuid: request.msgId,
        session_id: request.sessionId,
        type: 'user',
        parent_tool_use_id: null,
        message: { role: 'user', content: request.content },
        ...(request.fileAttachments?.length
          ? { file_attachments: request.fileAttachments }
          : {}),
      },
    ],
  }
  const url = `${request.baseUrl.replace(/\/$/, '')}/v1/sessions/${request.sessionId}/events`

  try {
    let auth = await deps.getAuth()
    let response = await deps.post(url, body, {
      headers: headers(auth),
      timeout: 30_000,
      validateStatus: status => status < 500,
    })

    if (response.status === 401 && deps.refreshAuth) {
      const refreshed = await deps.refreshAuth(auth.accessToken)
      if (refreshed) {
        auth = await deps.getAuth()
        response = await deps.post(url, body, {
          headers: headers(auth),
          timeout: 30_000,
          validateStatus: status => status < 500,
        })
      }
    }

    if (response.status >= 200 && response.status < 300) {
      return { ok: true, msgId: request.msgId, status: response.status }
    }
    return {
      ok: false,
      msgId: request.msgId,
      errorCode: response.status === 401 ? 'unauthorized' : 'rejected',
      error: responseError(response.data, response.status),
      status: response.status,
    }
  } catch (error) {
    return {
      ok: false,
      msgId: request.msgId,
      errorCode: 'network_error',
      error: errorMessage(error),
    }
  }
}
