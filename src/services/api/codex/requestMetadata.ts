export const CODEX_CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'
export const CODEX_INSTALLATION_ID_METADATA_KEY = 'x-codex-installation-id'
export const CODEX_SESSION_ID_HEADER = 'session-id'
export const CODEX_THREAD_ID_HEADER = 'thread-id'
export const CODEX_WINDOW_ID_HEADER = 'x-codex-window-id'

export type CodexRequestIdentity = {
  installationId?: string
  sessionId: string
  threadId: string
  windowId: string
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) {
    throw new Error(`Codex request identity requires ${label}.`)
  }
  return normalized
}

/**
 * Build the stable request identity used by Codex Responses requests.
 *
 * The installation identifier is request-routing metadata, not analytics: no
 * event, metric, trace, or telemetry pipeline is introduced here.
 */
export function createCodexRequestIdentity(params: {
  sessionId: string
  installationId?: string
  threadId?: string
  windowNumber?: number
}): CodexRequestIdentity {
  const sessionId = nonEmpty(params.sessionId, 'sessionId')
  const threadId = nonEmpty(params.threadId ?? sessionId, 'threadId')
  const installationId = params.installationId?.trim() || undefined
  const configuredWindowNumber = params.windowNumber ?? 0
  const windowNumber =
    Number.isFinite(configuredWindowNumber) && configuredWindowNumber >= 0
      ? Math.trunc(configuredWindowNumber)
      : 0

  return {
    ...(installationId ? { installationId } : {}),
    sessionId,
    threadId,
    windowId: `${threadId}:${windowNumber}`,
  }
}

/** Canonical Codex client_metadata projection for a normal turn request. */
export function buildCodexClientMetadata(
  identity: CodexRequestIdentity,
): Record<string, string> {
  return {
    ...(identity.installationId
      ? { [CODEX_INSTALLATION_ID_METADATA_KEY]: identity.installationId }
      : {}),
    session_id: identity.sessionId,
    thread_id: identity.threadId,
    [CODEX_WINDOW_ID_HEADER]: identity.windowId,
  }
}

/**
 * Apply the HTTP compatibility projection without overriding explicit caller
 * values. Codex sends these alongside the canonical client_metadata body.
 */
export function applyCodexIdentityHeaders(
  headers: Headers,
  identity: CodexRequestIdentity,
): void {
  const values: ReadonlyArray<readonly [string, string]> = [
    [CODEX_SESSION_ID_HEADER, identity.sessionId],
    [CODEX_THREAD_ID_HEADER, identity.threadId],
    [CODEX_CLIENT_REQUEST_ID_HEADER, identity.threadId],
    [CODEX_WINDOW_ID_HEADER, identity.windowId],
  ]

  for (const [name, value] of values) {
    if (!headers.has(name)) {
      headers.set(name, value)
    }
  }
}
