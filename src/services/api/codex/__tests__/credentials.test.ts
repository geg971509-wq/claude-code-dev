import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  CHATGPT_ACCOUNT_ID_HEADER,
  CHATGPT_CODEX_BASE_URL,
  DEFAULT_CODEX_API_BASE_URL,
  _resetCodexAuthForTests,
  isCodexSubscriptionAuth,
  readCodexAuth,
  refreshCodexAuthIfNeeded,
  resolveCodexBaseURL,
  resolveCodexRequestContext,
  writeCodexAuth,
} from '../credentials.js'
import { getCodexClient, clearCodexClientCache } from '../client.js'
import { persistCodexLogin } from '../../../oauth/openai-codex.js'
import { resetSettingsCache } from '../../../../utils/settings/settingsCache.js'
import { getSessionId } from '../../../../bootstrap/state.js'

const store: { blob: Record<string, unknown> } = { blob: {} }

mock.module('../../../../utils/secureStorage/index.js', () => ({
  getSecureStorage: () => ({
    read: () => store.blob,
    update: (next: Record<string, unknown>) => {
      store.blob = { ...next }
      return { success: true }
    },
    delete: () => {
      store.blob = {}
      return true
    },
  }),
}))

function withEnv(
  overrides: Record<string, string | undefined>,
  run: () => void | Promise<void>,
): Promise<void> {
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    })
}

describe('resolveCodexBaseURL', () => {
  test('routes ChatGPT subscription to official chatgpt backend', () => {
    expect(resolveCodexBaseURL({ loginMethod: 'chatgpt_subscription' })).toBe(
      CHATGPT_CODEX_BASE_URL,
    )
  })

  test('routes api-key mode to api.openai.com/v1', () => {
    expect(resolveCodexBaseURL({ loginMethod: 'api_key' })).toBe(
      DEFAULT_CODEX_API_BASE_URL,
    )
    expect(resolveCodexBaseURL({ loginMethod: undefined })).toBe(
      DEFAULT_CODEX_API_BASE_URL,
    )
  })

  test('CODEX_BASE_URL override wins over login method', () => {
    expect(
      resolveCodexBaseURL({
        loginMethod: 'chatgpt_subscription',
        override: 'https://example.test/v1',
      }),
    ).toBe('https://example.test/v1')
  })

  test('reads login method from env when not passed', async () => {
    await withEnv({ CODEX_LOGIN_METHOD: 'chatgpt_subscription' }, () => {
      expect(isCodexSubscriptionAuth()).toBe(true)
      expect(resolveCodexBaseURL()).toBe(CHATGPT_CODEX_BASE_URL)
    })
    await withEnv({ CODEX_LOGIN_METHOD: undefined }, () => {
      expect(isCodexSubscriptionAuth()).toBe(false)
      expect(resolveCodexBaseURL()).toBe(DEFAULT_CODEX_API_BASE_URL)
    })
  })
})

describe('codex credentials store', () => {
  beforeEach(() => {
    store.blob = {}
    _resetCodexAuthForTests()
    clearCodexClientCache()
  })

  afterEach(() => {
    _resetCodexAuthForTests()
    clearCodexClientCache()
  })

  test('write/read round-trips tokens without touching process.env', () => {
    writeCodexAuth({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      accountId: 'acc_1',
      expiresAt: Date.now() + 60_000,
    })
    expect(readCodexAuth()).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      apiKey: null,
      accountId: 'acc_1',
      expiresAt: expect.any(Number),
    })
    expect(process.env.CODEX_ACCESS_TOKEN).toBeUndefined()
    expect(process.env.CODEX_REFRESH_TOKEN).toBeUndefined()
  })

  test('subscription context uses access token + chatgpt backend + account id', async () => {
    await withEnv(
      {
        CODEX_LOGIN_METHOD: 'chatgpt_subscription',
        CODEX_BASE_URL: undefined,
      },
      async () => {
        writeCodexAuth({
          accessToken: 'sub-access',
          refreshToken: 'sub-refresh',
          accountId: 'acc_sub',
          expiresAt: Date.now() + 60 * 60 * 1000,
        })
        const ctx = await resolveCodexRequestContext()
        expect(ctx).toEqual({
          apiKey: 'sub-access',
          baseURL: CHATGPT_CODEX_BASE_URL,
          accountId: 'acc_sub',
        })
        const seen: string[] = []
        const client = getCodexClient({
          ...ctx,
          maxRetries: 0,
          fetchOverride: (async (input, init) => {
            const headers = new Headers(
              init?.headers as HeadersInit | undefined,
            )
            seen.push(
              [
                headers.get('originator') ?? '',
                headers.get(CHATGPT_ACCOUNT_ID_HEADER) ?? '',
                headers.get('session-id') ?? '',
                headers.get('thread-id') ?? '',
              ].join('|'),
            )
            return new Response('{}', { status: 200 })
          }) as typeof fetch,
        })
        expect(client.baseURL.replace(/\/$/, '')).toBe(CHATGPT_CODEX_BASE_URL)
        await client.responses
          .create({ model: 'gpt-5.4', input: [] })
          .catch(() => {})
        const sessionId = getSessionId()
        expect(
          seen.some(
            value => value === `codex_cli_rs|acc_sub|${sessionId}|${sessionId}`,
          ),
        ).toBe(true)
      },
    )
  })

  test('refresh posts JSON body without scope', async () => {
    const captured: { contentType: string | null; body: unknown } = {
      contentType: null,
      body: undefined,
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (_url, init) => {
      captured.contentType = new Headers(
        init?.headers as HeadersInit | undefined,
      ).get('Content-Type')
      captured.body = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({
          access_token: 'rotated-access',
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    try {
      writeCodexAuth({
        accessToken: 'stale-access',
        refreshToken: 'stale-refresh',
        accountId: 'acc_1',
        expiresAt: Date.now() - 1000,
      })
      await refreshCodexAuthIfNeeded()
      expect(captured.contentType).toBe('application/json')
      expect(captured.body).toEqual({
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
        grant_type: 'refresh_token',
        refresh_token: 'stale-refresh',
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('refresh is single-flight and reuses one token response', async () => {
    let fetches = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => {
      fetches += 1
      await Bun.sleep(20)
      return new Response(
        JSON.stringify({
          access_token: 'rotated-access',
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    try {
      writeCodexAuth({
        accessToken: 'stale-access',
        refreshToken: 'stale-refresh',
        accountId: 'acc_1',
        expiresAt: Date.now() - 1000,
      })
      const [first, second] = await Promise.all([
        refreshCodexAuthIfNeeded(),
        refreshCodexAuthIfNeeded(),
      ])
      expect(fetches).toBe(1)
      expect(first?.accessToken).toBe('rotated-access')
      expect(second?.accessToken).toBe('rotated-access')
      expect(readCodexAuth()?.refreshToken).toBe('rotated-refresh')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('persistCodexLogin leftover stripping', () => {
  let isolatedDir = ''
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    isolatedDir = mkdtempSync(join(tmpdir(), 'codex-leftover-'))
    for (const key of [
      'HOME',
      'CLAUDE_CONFIG_DIR',
      'CODEX_ACCESS_TOKEN',
      'CODEX_REFRESH_TOKEN',
      'CODEX_API_KEY',
      'CODEX_LOGIN_METHOD',
    ]) {
      saved[key] = process.env[key]
    }
    process.env.HOME = isolatedDir
    process.env.CLAUDE_CONFIG_DIR = isolatedDir
    process.env.CODEX_ACCESS_TOKEN = 'old-access-secret'
    process.env.CODEX_REFRESH_TOKEN = 'old-refresh-secret'
    process.env.CODEX_API_KEY = 'old-api-secret'
    process.env.CODEX_LOGIN_METHOD = 'chatgpt_subscription'
    writeFileSync(
      join(isolatedDir, 'settings.json'),
      JSON.stringify({
        env: {
          CODEX_ACCESS_TOKEN: 'old-access-secret',
          CODEX_REFRESH_TOKEN: 'old-refresh-secret',
          CODEX_API_KEY: 'old-api-secret',
          CODEX_LOGIN_METHOD: 'chatgpt_subscription',
        },
      }),
    )
    store.blob = {}
    _resetCodexAuthForTests()
    resetSettingsCache()
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetSettingsCache()
    _resetCodexAuthForTests()
    if (isolatedDir) rmSync(isolatedDir, { recursive: true, force: true })
  })

  test('moves leftover tokens into secureStorage and strips settings.env', async () => {
    persistCodexLogin({
      apiKey: 'new-api-key',
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      accountId: 'acc_new',
      expiresAt: Date.now() + 60_000,
    })

    expect(store.blob.codexOauth).toEqual({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      apiKey: 'new-api-key',
      accountId: 'acc_new',
      expiresAt: expect.any(Number),
    })
    expect(process.env.CODEX_ACCESS_TOKEN).toBeUndefined()
    expect(process.env.CODEX_REFRESH_TOKEN).toBeUndefined()
    expect(process.env.CODEX_API_KEY).toBeUndefined()
    expect(process.env.CODEX_LOGIN_METHOD).toBe('chatgpt_subscription')

    await Bun.sleep(80)
    resetSettingsCache()
    const settings = JSON.parse(
      readFileSync(join(isolatedDir, 'settings.json'), 'utf8'),
    ) as {
      env?: Record<string, string>
      modelType?: string
    }
    expect(settings.modelType).toBe('codex')
    expect(settings.env).toEqual({
      CODEX_LOGIN_METHOD: 'chatgpt_subscription',
    })
  })

  test('resolveCodexRequestContext strips leftover env even when storage already has tokens', async () => {
    writeCodexAuth({
      accessToken: 'stored-access',
      refreshToken: 'stored-refresh',
      accountId: 'acc_stored',
      expiresAt: Date.now() + 60 * 60 * 1000,
    })

    const ctx = await resolveCodexRequestContext()
    expect(ctx.apiKey).toBe('stored-access')
    expect(process.env.CODEX_ACCESS_TOKEN).toBeUndefined()
    expect(process.env.CODEX_REFRESH_TOKEN).toBeUndefined()
    expect(process.env.CODEX_API_KEY).toBeUndefined()

    await Bun.sleep(80)
    resetSettingsCache()
    const settings = JSON.parse(
      readFileSync(join(isolatedDir, 'settings.json'), 'utf8'),
    ) as { env?: Record<string, string> }
    expect(settings.env).toEqual({
      CODEX_LOGIN_METHOD: 'chatgpt_subscription',
    })
  })
})
