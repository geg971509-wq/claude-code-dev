import axios from 'axios'
import { randomUUID } from 'node:crypto'
import { getOrganizationUUID } from '../services/oauth/client.js'
import { handleOAuth401Error } from '../utils/auth.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { postRemoteUserEvent } from '../utils/remoteSessionEvents.js'
import {
  fetchSessionResourcesFromSessionsAPI,
  isCloudSessionEnvironment,
} from '../utils/teleport/api.js'
import { validateBridgeId } from './bridgeApi.js'
import {
  getBridgeAccessToken,
  getBridgeBaseUrl,
  getBridgeTokenOverride,
} from './bridgeConfig.js'
import { getReplBridgeHandle } from './replBridgeHandle.js'
import { toCompatSessionId } from './sessionIdCompat.js'
import { getTrustedDeviceToken } from './trustedDevice.js'

export type BridgePeerSession = {
  address: string
  sessionId: string
  name?: string
  cwd?: string
  status?: string
  updatedAt?: number
  environmentKind?: string
  connected?: boolean
}

/** List account-visible Remote Control sessions across machines. */
export async function listBridgePeers(): Promise<BridgePeerSession[]> {
  return (await fetchSessionResourcesFromSessionsAPI())
    .filter(
      session =>
        session.session_status !== 'archived' &&
        !isCloudSessionEnvironment(session.environment_kind),
    )
    .map(session => {
      const compatId = toCompatSessionId(session.id)
      return {
        sessionId: compatId,
        address: `bridge:${compatId}`,
        name: session.title ?? 'Remote Control',
        cwd: session.session_context?.cwd,
        status: session.session_status,
        updatedAt: Date.parse(session.updated_at),
        environmentKind: session.environment_kind,
        connected:
          session.connection_status === undefined
            ? undefined
            : session.connection_status === 'connected',
      }
    })
}

/**
 * Send a plain-text message to another Claude session via the bridge API.
 *
 * Called by SendMessageTool when the target address scheme is "bridge:".
 * Uses the current ReplBridgeHandle to derive the sender identity and
 * the session ingress URL for the POST request.
 *
 * @param target - Target session ID (from the "bridge:<sessionId>" address)
 * @param message - Plain text message content (structured messages are rejected upstream)
 * @returns { ok: true } on success, { ok: false, error } on failure. Never throws.
 */
export async function postInterClaudeMessage(
  target: string,
  message: string,
  opts?: {
    msgId?: string
    fileAttachments?: import('../utils/remoteSessionEvents.js').RemoteFileAttachment[]
  },
): Promise<
  | { ok: true; msgId: string; status: number }
  | {
      ok: false
      msgId: string
      error: string
      errorCode: string
      status?: number
    }
> {
  const msgId = opts?.msgId ?? randomUUID()
  try {
    const normalizedTarget = target.trim()
    if (!normalizedTarget) {
      return {
        ok: false,
        msgId,
        error: 'No target session specified',
        errorCode: 'invalid_session',
      }
    }

    const compatTarget = toCompatSessionId(normalizedTarget)
    validateBridgeId(compatTarget, 'target sessionId')
    const handle = getReplBridgeHandle()
    const result = await postRemoteUserEvent(
      {
        baseUrl: handle?.sessionIngressUrl ?? getBridgeBaseUrl(),
        sessionId: compatTarget,
        content: [{ type: 'text', text: message }],
        msgId,
        fileAttachments: opts?.fileAttachments,
      },
      {
        getAuth: async () => {
          const accessToken = getBridgeAccessToken()
          if (!accessToken) throw new Error('No access token available')
          return {
            accessToken,
            organizationId: (await getOrganizationUUID()) ?? undefined,
            trustedDeviceToken: getTrustedDeviceToken(),
          }
        },
        refreshAuth: getBridgeTokenOverride() ? undefined : handleOAuth401Error,
        post: (url, body, config) => axios.post(url, body, config),
      },
    )

    if (result.ok) {
      logForDebugging(
        `[bridge:peer] Message sent to ${compatTarget} (${result.status})`,
      )
    } else {
      logForDebugging(`[bridge:peer] Send failed: ${result.error}`)
    }
    return result
  } catch (err: unknown) {
    const msg = errorMessage(err)
    logForDebugging(`[bridge:peer] postInterClaudeMessage error: ${msg}`)
    return { ok: false, msgId, error: msg, errorCode: 'network_error' }
  }
}
