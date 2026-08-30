import { getSecureStorage } from '../../../utils/secureStorage/index.js'
import { logForDebugging } from '../../../utils/debug.js'

export const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'
export const DEFAULT_CODEX_API_BASE_URL = 'https://api.openai.com/v1'
export const CHATGPT_ACCOUNT_ID_HEADER = 'ChatGPT-Account-Id'
export const CODEX_ORIGINATOR = 'codex_cli_rs'
export const CODEX_LOGIN_METHOD_SUBSCRIPTION = 'chatgpt_subscription'
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
export const CODEX_OAUTH_SCOPE =
  'openid profile email offline_access api.connectors.read api.connectors.invoke'
const REFRESH_SKEW_MS = 5 * 60 * 1000
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

export type CodexStoredAuth = {
  accessToken?: string
  refreshToken?: string
  apiKey?: string | null
  accountId?: string
  expiresAt?: number
}

export type CodexRequestContext = {
  apiKey: string
  baseURL: string
  accountId?: string
}

function asNonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function isCodexSubscriptionAuth(
  loginMethod: string | null | undefined = process.env.CODEX_LOGIN_METHOD,
): boolean {
  return loginMethod === CODEX_LOGIN_METHOD_SUBSCRIPTION
}

export function resolveCodexBaseURL(options?: {
  loginMethod?: string | null
  override?: string | null
}): string {
  const override = options?.override ?? process.env.CODEX_BASE_URL
  if (typeof override === 'string' && override.trim() !== '') {
    return override.trim()
  }
  return isCodexSubscriptionAuth(options?.loginMethod)
    ? CHATGPT_CODEX_BASE_URL
    : DEFAULT_CODEX_API_BASE_URL
}

function parseStored(raw: unknown): CodexStoredAuth | null {
  if (raw == null || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  const accessToken = asNonEmpty(rec.accessToken)
  const refreshToken = asNonEmpty(rec.refreshToken)
  const apiKey = asNonEmpty(rec.apiKey) ?? null
  if (!accessToken && !refreshToken && !apiKey) return null
  return {
    accessToken,
    refreshToken,
    apiKey,
    accountId: asNonEmpty(rec.accountId),
    expiresAt: typeof rec.expiresAt === 'number' ? rec.expiresAt : undefined,
  }
}

function liftFromEnv(): CodexStoredAuth | null {
  const accessToken = asNonEmpty(process.env.CODEX_ACCESS_TOKEN)
  const refreshToken = asNonEmpty(process.env.CODEX_REFRESH_TOKEN)
  const apiKey = asNonEmpty(process.env.CODEX_API_KEY)
  if (!accessToken && !refreshToken && !apiKey) return null
  return {
    accessToken,
    refreshToken,
    apiKey,
    accountId: asNonEmpty(process.env.CODEX_ACCOUNT_ID),
  }
}

export function readCodexAuth(): CodexStoredAuth | null {
  const storage = getSecureStorage()
  const blob = (storage.read() ?? {}) as Record<string, unknown>
  return parseStored(blob.codexOauth) ?? liftFromEnv()
}

export function writeCodexAuth(auth: CodexStoredAuth): void {
  const storage = getSecureStorage()
  const current = (storage.read() ?? {}) as Record<string, unknown>
  storage.update({
    ...current,
    codexOauth: {
      ...(auth.accessToken ? { accessToken: auth.accessToken } : {}),
      ...(auth.refreshToken ? { refreshToken: auth.refreshToken } : {}),
      ...(auth.accountId ? { accountId: auth.accountId } : {}),
      ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
      ...(auth.expiresAt != null ? { expiresAt: auth.expiresAt } : {}),
    },
  })
}

export function clearCodexAuth(): void {
  const storage = getSecureStorage()
  const current = (storage.read() ?? {}) as Record<string, unknown>
  if (!('codexOauth' in current)) return
  const { codexOauth: _removed, ...rest } = current
  storage.update(rest)
}

async function writeCodexUserSettings(settings: {
  modelType?: 'codex'
  env: Record<string, string | undefined>
}): Promise<void> {
  const { updateSettingsForSource } = await import(
    '../../../utils/settings/settings.js'
  )
  const { error } = updateSettingsForSource('userSettings', {
    ...(settings.modelType ? { modelType: settings.modelType } : {}),
    env: settings.env as unknown as Record<string, string>,
  })
  if (error) throw error
}

export async function persistCodexLogin(result: {
  apiKey: string | null
  accessToken: string
  refreshToken: string
  accountId: string
  expiresAt?: number
}): Promise<void> {
  writeCodexAuth({
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    apiKey: result.apiKey,
    accountId: result.accountId,
    expiresAt: result.expiresAt,
  })
  await writeCodexUserSettings({
    modelType: 'codex',
    env: {
      CODEX_LOGIN_METHOD: 'chatgpt_subscription',
      CODEX_ACCESS_TOKEN: undefined,
      CODEX_REFRESH_TOKEN: undefined,
      CODEX_API_KEY: undefined,
    },
  })
  delete process.env.CODEX_ACCESS_TOKEN
  delete process.env.CODEX_REFRESH_TOKEN
  delete process.env.CODEX_API_KEY
  process.env.CODEX_LOGIN_METHOD = 'chatgpt_subscription'
}

async function consumeEnvTokens(auth: CodexStoredAuth): Promise<void> {
  writeCodexAuth(auth)
  try {
    await writeCodexUserSettings({
      env: {
        CODEX_ACCESS_TOKEN: undefined,
        CODEX_REFRESH_TOKEN: undefined,
        ...(isCodexSubscriptionAuth() ? { CODEX_API_KEY: undefined } : {}),
      },
    })
  } catch (err) {
    logForDebugging(
      `[Codex] Failed to strip leftover tokens from settings.env: ${err}`,
    )
    return
  }
  delete process.env.CODEX_ACCESS_TOKEN
  delete process.env.CODEX_REFRESH_TOKEN
  if (isCodexSubscriptionAuth()) {
    delete process.env.CODEX_API_KEY
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = parts[1] ?? ''
    return JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as Record<string, unknown>
  } catch {
    return null
  }
}

function decodeJwtExpMs(token: string): number | undefined {
  const payload = decodeJwtPayload(token)
  return typeof payload?.exp === 'number' ? payload.exp * 1000 : undefined
}

function accountIdFromToken(token: string | undefined): string | undefined {
  if (!token) return undefined
  const payload = decodeJwtPayload(token)
  const nested = payload?.[JWT_CLAIM_PATH]
  if (nested && typeof nested === 'object') {
    const id = (nested as Record<string, unknown>).chatgpt_account_id
    if (typeof id === 'string' && id.length > 0) return id
  }
  return undefined
}

function tokenExpiryMs(auth: CodexStoredAuth): number | undefined {
  if (typeof auth.expiresAt === 'number') return auth.expiresAt
  if (auth.accessToken) return decodeJwtExpMs(auth.accessToken)
  return undefined
}

function needsRefresh(auth: CodexStoredAuth): boolean {
  if (!auth.refreshToken) return false
  const exp = tokenExpiryMs(auth)
  if (exp == null) return false
  return exp <= Date.now() + REFRESH_SKEW_MS
}

function isStillFresh(auth: CodexStoredAuth): boolean {
  const exp = tokenExpiryMs(auth)
  return exp != null && exp > Date.now() + REFRESH_SKEW_MS
}

let refreshInFlight: Promise<CodexStoredAuth> | null = null

export function _resetCodexAuthForTests(): void {
  refreshInFlight = null
}

async function doRefresh(stored: CodexStoredAuth): Promise<CodexStoredAuth> {
  if (!stored.refreshToken) return stored

  const latestBefore = readCodexAuth()
  if (
    latestBefore?.accessToken &&
    latestBefore.accessToken !== stored.accessToken &&
    isStillFresh(latestBefore)
  ) {
    return latestBefore
  }

  const response = await fetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      originator: CODEX_ORIGINATOR,
    },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken,
    }),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Codex token refresh failed (${response.status}): ${text}`)
  }

  const json = (await response.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    id_token?: string
  }
  if (!json.access_token) {
    throw new Error('Codex token refresh missing access_token')
  }

  const next: CodexStoredAuth = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? stored.refreshToken,
    apiKey: stored.apiKey,
    accountId:
      stored.accountId ??
      accountIdFromToken(json.id_token) ??
      accountIdFromToken(json.access_token),
    expiresAt:
      typeof json.expires_in === 'number'
        ? Date.now() + json.expires_in * 1000
        : decodeJwtExpMs(json.access_token),
  }

  const latestAfter = readCodexAuth()
  if (
    latestAfter?.accessToken &&
    latestAfter.accessToken !== stored.accessToken &&
    latestAfter.accessToken !== next.accessToken &&
    isStillFresh(latestAfter)
  ) {
    return latestAfter
  }

  writeCodexAuth(next)
  const { clearCodexClientCache } = await import('./client.js')
  clearCodexClientCache()
  logForDebugging('[Codex] Rotated access token')
  return next
}

function startRefresh(stored: CodexStoredAuth): Promise<CodexStoredAuth> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = doRefresh(stored).finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}

export async function refreshCodexAuthIfNeeded(): Promise<CodexStoredAuth | null> {
  const stored = readCodexAuth()
  if (!stored) return null
  if (!needsRefresh(stored)) return stored
  return startRefresh(stored)
}

/**
 * Recover once after the Codex backend rejects a subscription bearer.
 *
 * Expiry claims are advisory: a token may be revoked server-side while still
 * looking fresh locally. Match Codex by reloading shared credentials first,
 * then forcing one refresh only when the rejected token is still current.
 */
export async function refreshCodexAuthAfterUnauthorized(
  rejectedAccessToken?: string,
): Promise<CodexStoredAuth | null> {
  if (!isCodexSubscriptionAuth()) {
    return readCodexAuth()
  }

  const stored = readCodexAuth()
  if (!stored) return null

  if (
    rejectedAccessToken &&
    stored.accessToken &&
    stored.accessToken !== rejectedAccessToken
  ) {
    logForDebugging(
      '[Codex] Reusing credentials rotated by another request after 401',
    )
    return stored
  }

  if (!stored.refreshToken) {
    return stored
  }

  logForDebugging('[Codex] Refreshing subscription credentials after 401')
  return startRefresh(stored)
}

export async function resolveCodexRequestContext(): Promise<CodexRequestContext> {
  const fromStorage = parseStored(
    ((getSecureStorage().read() ?? {}) as Record<string, unknown>).codexOauth,
  )
  const fromEnv = liftFromEnv()
  if (fromEnv) {
    await consumeEnvTokens(fromStorage ?? fromEnv)
  }

  const auth = (await refreshCodexAuthIfNeeded()) ?? readCodexAuth()
  const loginMethod = process.env.CODEX_LOGIN_METHOD
  const baseURL = resolveCodexBaseURL({ loginMethod })

  if (isCodexSubscriptionAuth(loginMethod)) {
    const access = auth?.accessToken
    if (!access) {
      throw new Error(
        'Missing Codex subscription access token. Use /login (ChatGPT Subscription).',
      )
    }
    return {
      apiKey: access,
      baseURL,
      accountId: auth?.accountId ?? accountIdFromToken(access),
    }
  }

  const apiKey =
    auth?.apiKey ||
    asNonEmpty(process.env.CODEX_API_KEY) ||
    auth?.accessToken ||
    ''
  return {
    apiKey,
    baseURL,
    accountId: auth?.accountId,
  }
}
