/**
 * Tests for kimiAuth.ts — Kimi Code (Moonshot) subscription OAuth device flow.
 *
 * Mocks only the network layer (global fetch). The token file is isolated by
 * pointing CLAUDE_CONFIG_DIR at a temp dir. debug.ts uses the shared mock to
 * cut the bootstrap/state.ts module-level side-effect chain.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { debugMock } from '../../../../../tests/mocks/debug'

mock.module('src/utils/debug.ts', debugMock)

import {
  applyKimiAuthToEnv,
  completeKimiDeviceLogin,
  getValidKimiAuth,
  isKimiAuthEnabled,
  type KimiDeviceCode,
  removeKimiAuth,
  requestKimiDeviceCode,
} from '../kimiAuth.js'

type FetchCall = { url: string; body: string; headers: Record<string, string> }

const realFetch = globalThis.fetch
let fetchCalls: FetchCall[] = []
let fetchHandler: (call: FetchCall) => { status: number; json: unknown }

const ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'OPENAI_API_KEY',
  'OPENAI_AUTH_MODE',
  'KIMI_CODE_OAUTH_HOST',
  'KIMI_CODE_CLIENT_ID',
] as const

let savedEnv: Record<string, string | undefined> = {}
let configDir = ''

const deviceCode: KimiDeviceCode = {
  deviceCode: 'dc-123',
  userCode: 'ABCD-EFGH',
  verificationUrl: 'https://www.kimi.com/code/authorize_device',
  intervalSeconds: 0,
  expiresInSeconds: 900,
}

function tokenResponse(overrides: Record<string, unknown> = {}) {
  return {
    status: 200,
    json: {
      access_token: 'kimi-access-1',
      refresh_token: 'kimi-refresh-1',
      expires_in: 3600,
      ...overrides,
    },
  }
}

async function writeAuthFile(body: Record<string, unknown>) {
  await writeFile(
    join(configDir, 'kimi-auth.json'),
    JSON.stringify(body),
    'utf8',
  )
}

beforeEach(async () => {
  savedEnv = {}
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  configDir = await mkdtemp(join(tmpdir(), 'kimi-auth-test-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  delete process.env.KIMI_CODE_OAUTH_HOST
  delete process.env.KIMI_CODE_CLIENT_ID

  fetchCalls = []
  fetchHandler = () => tokenResponse()
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const call: FetchCall = {
      url: String(input),
      body: String(init?.body ?? ''),
      headers: (init?.headers ?? {}) as Record<string, string>,
    }
    fetchCalls.push(call)
    const { status, json } = fetchHandler(call)
    return new Response(JSON.stringify(json), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
})

afterEach(async () => {
  globalThis.fetch = realFetch
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  await rm(configDir, { recursive: true, force: true })
})

describe('requestKimiDeviceCode', () => {
  test('posts client_id form with CLI identity header and parses RFC 8628 response', async () => {
    fetchHandler = () => ({
      status: 200,
      json: {
        device_code: 'dc-123',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://www.kimi.com/code/authorize_device',
        interval: 5,
        expires_in: 900,
      },
    })

    const code = await requestKimiDeviceCode()

    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe(
      'https://auth.kimi.com/api/oauth/device_authorization',
    )
    expect(fetchCalls[0].body).toContain(
      'client_id=17e5f671-d194-4dfb-9706-5516cb48c098',
    )
    expect(fetchCalls[0].headers['X-Msh-Platform']).toBe('kimi_code_cli')
    expect(code).toEqual({
      deviceCode: 'dc-123',
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://www.kimi.com/code/authorize_device',
      intervalSeconds: 5,
      expiresInSeconds: 900,
    })
  })

  test('honors KIMI_CODE_OAUTH_HOST / KIMI_CODE_CLIENT_ID overrides', async () => {
    process.env.KIMI_CODE_OAUTH_HOST = 'https://auth.example.com/'
    process.env.KIMI_CODE_CLIENT_ID = 'custom-client'
    fetchHandler = () => ({
      status: 200,
      json: {
        device_code: 'dc',
        user_code: 'uc',
        verification_uri: 'https://example.com/activate',
      },
    })

    const code = await requestKimiDeviceCode()

    expect(fetchCalls[0].url).toBe(
      'https://auth.example.com/api/oauth/device_authorization',
    )
    expect(fetchCalls[0].body).toContain('client_id=custom-client')
    expect(code.intervalSeconds).toBe(5) // default when server omits interval
  })

  test('throws with server error description on failure', async () => {
    fetchHandler = () => ({
      status: 400,
      json: { error: 'invalid_client', error_description: 'bad client' },
    })
    await expect(requestKimiDeviceCode()).rejects.toThrow('bad client')
  })
})

describe('completeKimiDeviceLogin', () => {
  test('polls through authorization_pending and persists tokens', async () => {
    let tokenCalls = 0
    fetchHandler = () => {
      tokenCalls++
      if (tokenCalls === 1) {
        return { status: 400, json: { error: 'authorization_pending' } }
      }
      return tokenResponse()
    }

    const tokens = await completeKimiDeviceLogin(deviceCode)

    expect(tokens.accessToken).toBe('kimi-access-1')
    expect(tokenCalls).toBe(2)
    expect(fetchCalls[0].body).toContain(
      'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code',
    )
    expect(fetchCalls[0].body).toContain('device_code=dc-123')

    const saved = JSON.parse(
      await readFile(join(configDir, 'kimi-auth.json'), 'utf8'),
    )
    expect(saved.access_token).toBe('kimi-access-1')
    expect(saved.refresh_token).toBe('kimi-refresh-1')
    expect(typeof saved.expires_at).toBe('number')
  })

  // RFC 8628 §3.5 mandates +5s on slow_down, so this test really sleeps ~5s.
  test('slow_down backs off and keeps polling', async () => {
    let tokenCalls = 0
    fetchHandler = () => {
      tokenCalls++
      if (tokenCalls === 1) return { status: 400, json: { error: 'slow_down' } }
      if (tokenCalls === 2) {
        return { status: 400, json: { error: 'authorization_pending' } }
      }
      return tokenResponse()
    }

    const tokens = await completeKimiDeviceLogin(deviceCode)
    expect(tokens.accessToken).toBe('kimi-access-1')
    expect(tokenCalls).toBe(3)
  }, 15000)

  test('access_denied aborts with the server description', async () => {
    fetchHandler = () => ({
      status: 400,
      json: { error: 'access_denied', error_description: 'User denied access' },
    })
    await expect(completeKimiDeviceLogin(deviceCode)).rejects.toThrow(
      'User denied access',
    )
  })

  test('respects AbortSignal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      completeKimiDeviceLogin(deviceCode, controller.signal),
    ).rejects.toThrow('cancelled')
    expect(fetchCalls).toHaveLength(0)
  })
})

describe('getValidKimiAuth', () => {
  test('throws login guidance when no token file exists', async () => {
    await expect(getValidKimiAuth()).rejects.toThrow('/login')
  })

  test('returns the stored token without network calls when fresh', async () => {
    await writeAuthFile({
      access_token: 'fresh-token',
      refresh_token: 'rt',
      expires_at: Date.now() + 3600_000,
    })

    const auth = await getValidKimiAuth()
    expect(auth.accessToken).toBe('fresh-token')
    expect(fetchCalls).toHaveLength(0)
  })

  test('refreshes an expiring token and persists the rotated refresh token', async () => {
    await writeAuthFile({
      access_token: 'old-token',
      refresh_token: 'old-refresh',
      expires_at: Date.now() + 60_000, // inside the 5-minute skew
    })
    fetchHandler = () =>
      tokenResponse({ access_token: 'new-token', refresh_token: 'new-refresh' })

    const auth = await getValidKimiAuth()

    expect(auth.accessToken).toBe('new-token')
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].body).toContain('grant_type=refresh_token')
    expect(fetchCalls[0].body).toContain('refresh_token=old-refresh')

    const saved = JSON.parse(
      await readFile(join(configDir, 'kimi-auth.json'), 'utf8'),
    )
    expect(saved.refresh_token).toBe('new-refresh')
  })

  test('keeps the old refresh token when the server does not rotate it', async () => {
    await writeAuthFile({
      access_token: 'old-token',
      refresh_token: 'old-refresh',
      expires_at: Date.now() + 60_000,
    })
    fetchHandler = () => ({
      status: 200,
      json: { access_token: 'new-token', expires_in: 3600 },
    })

    const auth = await getValidKimiAuth()
    expect(auth.accessToken).toBe('new-token')

    const saved = JSON.parse(
      await readFile(join(configDir, 'kimi-auth.json'), 'utf8'),
    )
    expect(saved.refresh_token).toBe('old-refresh')
  })

  test('dedupes concurrent refreshes into a single token request', async () => {
    await writeAuthFile({
      access_token: 'old-token',
      refresh_token: 'old-refresh',
      expires_at: Date.now() + 60_000,
    })

    const [a, b] = await Promise.all([getValidKimiAuth(), getValidKimiAuth()])
    expect(a.accessToken).toBe('kimi-access-1')
    expect(b.accessToken).toBe('kimi-access-1')
    expect(fetchCalls).toHaveLength(1)
  })
})

describe('applyKimiAuthToEnv', () => {
  test('mirrors the access token into OPENAI_API_KEY', async () => {
    await writeAuthFile({
      access_token: 'env-token',
      refresh_token: 'rt',
      expires_at: Date.now() + 3600_000,
    })
    process.env.OPENAI_API_KEY = 'stale'

    await applyKimiAuthToEnv()
    expect(process.env.OPENAI_API_KEY).toBe('env-token')

    // Idempotent when the token is unchanged.
    await applyKimiAuthToEnv()
    expect(process.env.OPENAI_API_KEY).toBe('env-token')
  })
})

describe('isKimiAuthEnabled / removeKimiAuth', () => {
  test('isKimiAuthEnabled follows OPENAI_AUTH_MODE', () => {
    delete process.env.OPENAI_AUTH_MODE
    expect(isKimiAuthEnabled()).toBe(false)
    process.env.OPENAI_AUTH_MODE = 'kimi'
    expect(isKimiAuthEnabled()).toBe(true)
    process.env.OPENAI_AUTH_MODE = 'chatgpt'
    expect(isKimiAuthEnabled()).toBe(false)
  })

  test('removeKimiAuth deletes the token file and tolerates a missing one', async () => {
    await writeAuthFile({
      access_token: 't',
      refresh_token: 'r',
      expires_at: Date.now() + 3600_000,
    })
    await removeKimiAuth()
    await expect(getValidKimiAuth()).rejects.toThrow('/login')
    await removeKimiAuth() // no throw on ENOENT
  })
})
