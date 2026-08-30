import { getProviderErrorStatus } from '@ant/model-provider'
import type { SDKAssistantMessageError } from '../../../entrypoints/agentSdkTypes.js'
import { isCodexSubscriptionAuth, readCodexAuth } from './credentials.js'

type CodexErrorLike = {
  status?: unknown
  statusCode?: unknown
  code?: unknown
  type?: unknown
  message?: unknown
  error?: {
    message?: unknown
    code?: unknown
    type?: unknown
  }
}

export type NormalizedCodexError = {
  content: string
  error: SDKAssistantMessageError
}

export function getCodexErrorStatus(error: unknown): number | null {
  return getProviderErrorStatus(error) ?? null
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

function readErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) {
    return null
  }

  const value = error as CodexErrorLike
  const code = value.code ?? value.error?.code
  return typeof code === 'string' && code.trim().length > 0
    ? code.trim().toLowerCase()
    : null
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
  if (process.env.CODEX_API_KEY) {
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
  const code = readErrorCode(error)

  if (/^Codex preflight:/i.test(message)) {
    return {
      content: message,
      error: 'invalid_request',
    }
  }

  if (code === 'context_length_exceeded') {
    return {
      content: `Codex context window exceeded: ${message}`,
      error: 'invalid_request',
    }
  }

  if (code === 'insufficient_quota') {
    return {
      content: `Codex quota exhausted: ${message}`,
      error: 'rate_limit',
    }
  }

  if (code === 'rate_limit_exceeded') {
    return {
      content: `Codex rate limit reached: ${message}`,
      error: 'rate_limit',
    }
  }

  if (code === 'usage_not_included') {
    return {
      content: `Codex usage is not included for this account: ${message}`,
      error: 'invalid_request',
    }
  }

  if (
    code === 'cyber_policy' ||
    code === 'misalignment_policy_violation' ||
    code === 'invalid_prompt' ||
    code === 'bio_policy'
  ) {
    return {
      content: `Codex rejected the request (${code}): ${message}`,
      error: 'invalid_request',
    }
  }

  if (code === 'server_is_overloaded' || code === 'slow_down') {
    return {
      content: `Codex service is temporarily overloaded: ${message}`,
      error: 'server_error',
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
      content: `Codex rate limit reached (429): ${message}`,
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
