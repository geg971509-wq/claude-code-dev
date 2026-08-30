import type { SDKAssistantMessageError } from '../../../entrypoints/agentSdkTypes.js'
import { isCodexSubscriptionAuth, readCodexAuth } from './credentials.js'

type CodexErrorLike = {
  status?: unknown
  message?: unknown
  error?: {
    message?: unknown
  }
}

export type NormalizedCodexError = {
  content: string
  error: SDKAssistantMessageError
}

export function getCodexErrorStatus(error: unknown): number | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as CodexErrorLike).status === 'number'
  ) {
    return (error as CodexErrorLike).status as number
  }

  return null
}

export function isCodexUnauthorizedError(error: unknown): boolean {
  return getCodexErrorStatus(error) === 401
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message
  }

  if (typeof error === 'object' && error !== null) {
    const value = error as CodexErrorLike
    if (typeof value.message === 'string' && value.message.length > 0) {
      return value.message
    }
    if (
      typeof value.error?.message === 'string' &&
      value.error.message.length > 0
    ) {
      return value.error.message
    }
  }

  return String(error)
}

export function getCodexConfigurationError(): NormalizedCodexError | null {
  const auth = readCodexAuth()
  if (isCodexSubscriptionAuth()) {
    if (auth?.accessToken || auth?.refreshToken) return null
    return {
      content:
        'Missing Codex subscription credentials. Use /login (ChatGPT Subscription).',
      error: 'authentication_failed',
    }
  }
  if (auth?.apiKey || auth?.accessToken || process.env.CODEX_API_KEY) {
    return null
  }
  return {
    content:
      'Missing Codex credentials. Use /login (ChatGPT Subscription) or set CODEX_API_KEY.',
    error: 'authentication_failed',
  }
}

export function normalizeCodexError(error: unknown): NormalizedCodexError {
  const status = getCodexErrorStatus(error)
  const message = readErrorMessage(error)

  if (/^Codex preflight:/i.test(message)) {
    return {
      content: message,
      error: 'invalid_request',
    }
  }

  if (status === 401 || status === 403) {
    return {
      content: `Codex authentication failed (${status}). ${message}`,
      error: 'authentication_failed',
    }
  }

  if (status === 404) {
    return {
      content:
        'Codex endpoint not found (404). Verify CODEX_BASE_URL points to a Responses API root.',
      error: 'invalid_request',
    }
  }

  if (status === 429) {
    return {
      content:
        'Codex rate limit reached (429). Retry shortly or reduce request volume.',
      error: 'rate_limit',
    }
  }

  if (status === 502 && /upstream request failed/i.test(message)) {
    return {
      content:
        'Codex gateway returned 502 Upstream request failed. This usually means a transient gateway issue or incomplete Responses API compatibility during tool replay.',
      error: 'server_error',
    }
  }

  if (status !== null && status >= 500) {
    return {
      content: `Codex server error (${status}): ${message}`,
      error: 'server_error',
    }
  }

  return {
    content: `API Error: ${message}`,
    error: 'unknown',
  }
}
