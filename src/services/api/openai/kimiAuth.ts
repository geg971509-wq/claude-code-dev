import { chmod, mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { logForDebugging } from 'src/utils/debug.js'

/**
 * Kimi Code (Moonshot) subscription OAuth — RFC 8628 Device Authorization Grant.
 *
 * Endpoints (shared with the official Kimi Code CLI):
 *   POST {issuer}/api/oauth/device_authorization  (form: client_id)
 *   POST {issuer}/api/oauth/token                 (device_code / refresh_token grants)
 * Tokens are used as the bearer credential for the OpenAI-compatible
 * subscription endpoint https://api.kimi.com/coding/v1. The access token is
 * mirrored into process.env.OPENAI_API_KEY right before each chat-completions
 * attempt (see streamAttempt.ts), so the rest of the OpenAI-compatible path
 * needs no changes.
 *
 * NOTE: Kimi auth mode is incompatible with OPENAI_USE_RESPONSES=1 — that env
 * forces the official-Responses branch, which bypasses the token hook.
 */

const DEFAULT_ISSUER = 'https://auth.kimi.com'
const DEFAULT_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098'
const AUTH_FILE = 'kimi-auth.json'
const REFRESH_SKEW_MS = 5 * 60 * 1000
const POLL_TIMEOUT_MS = 15 * 60 * 1000
const SLOW_DOWN_EXTRA_SECONDS = 5

function issuer(): string {
  return (process.env.KIMI_CODE_OAUTH_HOST ?? DEFAULT_ISSUER).replace(
    /\/+$/,
    '',
  )
}

function clientId(): string {
  return process.env.KIMI_CODE_CLIENT_ID ?? DEFAULT_CLIENT_ID
}

export type KimiDeviceCode = {
  deviceCode: string
  userCode: string
  verificationUrl: string
  intervalSeconds: number
  expiresInSeconds: number
}

export type KimiAuthTokens = {
  accessToken: string
  refreshToken: string
  /** Epoch ms when the access token expires (from the token response's expires_in). */
  expiresAt: number
  lastRefresh?: string
}

type StoredAuthFile = {
  access_token?: string
  refresh_token?: string
  expires_at?: number
  last_refresh?: string
}

function authFilePath(): string {
  return join(getClaudeConfigHomeDirLocal(), AUTH_FILE)
}

function getClaudeConfigHomeDirLocal(): string {
  return (
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  ).normalize('NFC')
}

async function readStoredAuth(): Promise<KimiAuthTokens | null> {
  try {
    const raw = await readFile(authFilePath(), 'utf8')
    const parsed = JSON.parse(raw) as StoredAuthFile
    if (
      !parsed.access_token ||
      !parsed.refresh_token ||
      typeof parsed.expires_at !== 'number'
    ) {
      return null
    }
    return {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      expiresAt: parsed.expires_at,
      lastRefresh: parsed.last_refresh,
    }
  } catch {
    return null
  }
}

async function saveStoredAuth(tokens: KimiAuthTokens): Promise<void> {
  const path = authFilePath()
  await mkdir(getClaudeConfigHomeDirLocal(), { recursive: true })
  const body: StoredAuthFile = {
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expires_at: tokens.expiresAt,
    last_refresh: new Date().toISOString(),
  }
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, {
    mode: 0o600,
  })
  await chmod(path, 0o600).catch(() => undefined)
}

async function postOAuthForm<T>(
  path: string,
  body: URLSearchParams,
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${issuer()}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // Matches the official Kimi Code CLI identity header.
      'X-Msh-Platform': 'kimi_code_cli',
    },
    body,
  })
  const data = (await res.json().catch(() => ({}))) as T
  return { status: res.status, data }
}

function toTokens(
  data: {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  },
  fallbackRefreshToken?: string,
): KimiAuthTokens {
  const refreshToken = data.refresh_token ?? fallbackRefreshToken
  if (!data.access_token || !refreshToken) {
    throw new Error('Kimi token response did not include access/refresh token')
  }
  const expiresIn =
    typeof data.expires_in === 'number' && data.expires_in > 0
      ? data.expires_in
      : 3600
  return {
    accessToken: data.access_token,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
  }
}

export async function requestKimiDeviceCode(): Promise<KimiDeviceCode> {
  type DeviceCodeResponse = {
    device_code?: string
    user_code?: string
    verification_uri?: string
    verification_url?: string
    interval?: number
    expires_in?: number
    error?: string
    error_description?: string
  }
  const { status, data } = await postOAuthForm<DeviceCodeResponse>(
    '/api/oauth/device_authorization',
    new URLSearchParams({ client_id: clientId() }),
  )
  if (status !== 200 || !data.device_code || !data.user_code) {
    throw new Error(
      `Kimi device authorization failed (${status})` +
        (data.error_description || data.error
          ? `: ${data.error_description ?? data.error}`
          : ''),
    )
  }
  const verificationUrl = data.verification_uri ?? data.verification_url
  if (!verificationUrl) {
    throw new Error(
      'Kimi device authorization response missing verification URL',
    )
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUrl,
    intervalSeconds:
      typeof data.interval === 'number' && data.interval >= 0
        ? data.interval
        : 5,
    expiresInSeconds:
      typeof data.expires_in === 'number' && data.expires_in > 0
        ? data.expires_in
        : 900,
  }
}

type TokenErrorResponse = {
  error?: string
  error_description?: string
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Kimi login cancelled'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('Kimi login cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function pollForTokens(
  deviceCode: KimiDeviceCode,
  signal?: AbortSignal,
): Promise<KimiAuthTokens> {
  const started = Date.now()
  const deadline = Math.min(
    started + POLL_TIMEOUT_MS,
    started + deviceCode.expiresInSeconds * 1000,
  )
  let intervalSeconds = deviceCode.intervalSeconds
  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error('Kimi device authorization timed out')
    }
    if (signal?.aborted) throw new Error('Kimi login cancelled')

    const { status, data } = await postOAuthForm<
      {
        access_token?: string
        refresh_token?: string
        expires_in?: number
      } & TokenErrorResponse
    >(
      '/api/oauth/token',
      new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode.deviceCode,
        client_id: clientId(),
      }),
    )

    if (status === 200) {
      return toTokens(data)
    }
    // RFC 8628 §3.5 error handling
    if (data.error === 'authorization_pending') {
      await sleep(intervalSeconds * 1000, signal)
      continue
    }
    if (data.error === 'slow_down') {
      intervalSeconds += SLOW_DOWN_EXTRA_SECONDS
      await sleep(intervalSeconds * 1000, signal)
      continue
    }
    throw new Error(
      `Kimi device authorization failed (${status})` +
        (data.error_description || data.error
          ? `: ${data.error_description ?? data.error}`
          : ''),
    )
  }
}

export async function completeKimiDeviceLogin(
  deviceCode: KimiDeviceCode,
  signal?: AbortSignal,
): Promise<KimiAuthTokens> {
  const tokens = await pollForTokens(deviceCode, signal)
  await saveStoredAuth(tokens)
  return tokens
}

async function refreshKimiTokens(
  tokens: KimiAuthTokens,
): Promise<KimiAuthTokens> {
  const { status, data } = await postOAuthForm<
    {
      access_token?: string
      refresh_token?: string
      expires_in?: number
    } & TokenErrorResponse
  >(
    '/api/oauth/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: clientId(),
    }),
  )
  if (status !== 200) {
    throw new Error(
      `Kimi token refresh failed (${status})` +
        (data.error_description || data.error
          ? `: ${data.error_description ?? data.error}`
          : ''),
    )
  }
  // Moonshot rotates refresh tokens; keep the old one when no new one is sent.
  return toTokens(data, tokens.refreshToken)
}

// Kimi rotates refresh tokens, so overlapping refreshes would invalidate each
// other. Serialize the whole check-and-refresh behind a mutex that re-reads
// the token file inside the lock: a caller arriving just after a completed
// refresh sees the fresh tokens on disk instead of firing a second refresh
// with the old (now-rotated) refresh token.
let refreshMutex: Promise<KimiAuthTokens> | null = null

async function refreshIfNeeded(): Promise<KimiAuthTokens> {
  const current = await readStoredAuth()
  if (!current) {
    throw new Error(
      'Kimi account is not logged in. Run /login and select China LLM Providers → Moonshot Kimi → Coding Plan.',
    )
  }
  if (current.expiresAt > Date.now() + REFRESH_SKEW_MS) {
    return current
  }
  const next = await refreshKimiTokens(current)
  await saveStoredAuth(next)
  return next
}

export async function getValidKimiAuth(): Promise<{ accessToken: string }> {
  const tokens = await readStoredAuth()
  if (!tokens) {
    throw new Error(
      'Kimi account is not logged in. Run /login and select China LLM Providers → Moonshot Kimi → Coding Plan.',
    )
  }
  if (tokens.expiresAt > Date.now() + REFRESH_SKEW_MS) {
    return { accessToken: tokens.accessToken }
  }
  if (!refreshMutex) {
    refreshMutex = refreshIfNeeded().finally(() => {
      refreshMutex = null
    })
  }
  const fresh = await refreshMutex
  return { accessToken: fresh.accessToken }
}

/**
 * Mirror the current Kimi access token into OPENAI_API_KEY so the plain
 * OpenAI-compatible chat-completions path picks it up. Clears the cached
 * client only when the token actually changed.
 */
export async function applyKimiAuthToEnv(): Promise<void> {
  const { accessToken } = await getValidKimiAuth()
  if (process.env.OPENAI_API_KEY === accessToken) return
  process.env.OPENAI_API_KEY = accessToken
  // Dynamic import keeps this module free of the OpenAI SDK dependency chain.
  const { clearOpenAIClientCache } = await import('./client.js')
  clearOpenAIClientCache()
}

export function isKimiAuthEnabled(): boolean {
  return process.env.OPENAI_AUTH_MODE === 'kimi'
}

export async function removeKimiAuth(): Promise<void> {
  await unlink(authFilePath()).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  })
  logForDebugging('[Kimi] Removed kimi-auth.json')
}
