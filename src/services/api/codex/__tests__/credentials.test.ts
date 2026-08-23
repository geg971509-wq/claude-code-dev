import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { resolve } from 'path'
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
import { getSessionId } from '../../../../bootstrap/state.js'

const PROJECT_ROOT = resolve(import.meta.dir, '..', '..', '..', '..', '..')

async function runIsolated(
  source: string,
): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn([process.execPath, '-e', source], {
    cwd: PROJECT_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const code = await proc.exited
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, output: `${stdout}\n${stderr}` }
}

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
  test('moves leftover tokens into secureStorage and strips settings.env', async () => {
    const { code, output } = await runIsolated(`
      import { mock } from 'bun:test'
      import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
      import { tmpdir } from 'os'
      import { join } from 'path'

      const store = { blob: {} }
      mock.module('src/utils/secureStorage/index.js', () => ({
        getSecureStorage: () => ({
          read: () => store.blob,
          update: (next) => {
            store.blob = { ...next }
            return { success: true }
          },
          delete: () => {
            store.blob = {}
            return true
          },
        }),
      }))

      const isolatedDir = mkdtempSync(join(tmpdir(), 'codex-leftover-'))
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

      try {
        const { persistCodexLogin } = await import('src/services/api/codex/credentials.js')
        const { resetSettingsCache } = await import('src/utils/settings/settingsCache.js')
        resetSettingsCache()
        await persistCodexLogin({
          apiKey: 'new-api-key',
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          accountId: 'acc_new',
          expiresAt: Date.now() + 60_000,
        })
        if (!store.blob.codexOauth) throw new Error('expected stored auth')
        if (process.env.CODEX_ACCESS_TOKEN) throw new Error('ACCESS leftover')
        if (process.env.CODEX_REFRESH_TOKEN) throw new Error('REFRESH leftover')
        if (process.env.CODEX_API_KEY) throw new Error('API_KEY leftover')
        if (process.env.CODEX_LOGIN_METHOD !== 'chatgpt_subscription') {
          throw new Error('login method not persisted')
        }
        resetSettingsCache()
        const settings = JSON.parse(
          readFileSync(join(isolatedDir, 'settings.json'), 'utf8'),
        )
        if (settings.modelType !== 'codex') throw new Error('modelType not set')
        if (JSON.stringify(settings.env) !== JSON.stringify({
          CODEX_LOGIN_METHOD: 'chatgpt_subscription',
        })) {
          throw new Error('settings.env not stripped: ' + JSON.stringify(settings.env))
        }
        console.log('ok')
      } finally {
        rmSync(isolatedDir, { recursive: true, force: true })
      }
    `)
    expect(code).toBe(0)
    expect(output).toContain('ok')
  })

  test('resolveCodexRequestContext strips leftover env even when storage already has tokens', async () => {
    const { code, output } = await runIsolated(`
      import { mock } from 'bun:test'
      import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
      import { tmpdir } from 'os'
      import { join } from 'path'

      const store = { blob: {} }
      mock.module('src/utils/secureStorage/index.js', () => ({
        getSecureStorage: () => ({
          read: () => store.blob,
          update: (next) => {
            store.blob = { ...next }
            return { success: true }
          },
          delete: () => {
            store.blob = {}
            return true
          },
        }),
      }))

      const isolatedDir = mkdtempSync(join(tmpdir(), 'codex-leftover-'))
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

      try {
        const {
          writeCodexAuth,
          resolveCodexRequestContext,
        } = await import('src/services/api/codex/credentials.js')
        const { resetSettingsCache } = await import('src/utils/settings/settingsCache.js')
        resetSettingsCache()
        writeCodexAuth({
          accessToken: 'stored-access',
          refreshToken: 'stored-refresh',
          accountId: 'acc_stored',
          expiresAt: Date.now() + 60 * 60 * 1000,
        })
        const ctx = await resolveCodexRequestContext()
        if (ctx.apiKey !== 'stored-access') throw new Error('wrong apiKey')
        if (process.env.CODEX_ACCESS_TOKEN) throw new Error('ACCESS leftover')
        if (process.env.CODEX_REFRESH_TOKEN) throw new Error('REFRESH leftover')
        if (process.env.CODEX_API_KEY) throw new Error('API_KEY leftover')
        resetSettingsCache()
        const settings = JSON.parse(
          readFileSync(join(isolatedDir, 'settings.json'), 'utf8'),
        )
        if (JSON.stringify(settings.env) !== JSON.stringify({
          CODEX_LOGIN_METHOD: 'chatgpt_subscription',
        })) {
          throw new Error('settings.env not stripped: ' + JSON.stringify(settings.env))
        }
        console.log('ok')
      } finally {
        rmSync(isolatedDir, { recursive: true, force: true })
      }
    `)
    expect(code).toBe(0)
    expect(output).toContain('ok')
  })

  test('persistCodexLogin keeps process.env leftover when settings write fails', async () => {
    const { code, output } = await runIsolated(`
      import { mock } from 'bun:test'
      import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
      import { tmpdir } from 'os'
      import { join } from 'path'

      const store = { blob: {} }
      mock.module('src/utils/secureStorage/index.js', () => ({
        getSecureStorage: () => ({
          read: () => store.blob,
          update: (next) => {
            store.blob = { ...next }
            return { success: true }
          },
          delete: () => {
            store.blob = {}
            return true
          },
        }),
      }))
      mock.module('src/utils/settings/settings.js', () => ({
        updateSettingsForSource: () => ({ error: new Error('disk full') }),
      }))

      const isolatedDir = mkdtempSync(join(tmpdir(), 'codex-leftover-fail-'))
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

      try {
        const { persistCodexLogin } = await import('src/services/api/codex/credentials.js')
        let threw = false
        try {
          await persistCodexLogin({
            apiKey: 'new-api-key',
            accessToken: 'new-access',
            refreshToken: 'new-refresh',
            accountId: 'acc_new',
            expiresAt: Date.now() + 60_000,
          })
        } catch (err) {
          threw = err instanceof Error && err.message === 'disk full'
        }
        if (!threw) throw new Error('expected persist to throw')
        if (!store.blob.codexOauth) throw new Error('expected stored auth')
        if (process.env.CODEX_ACCESS_TOKEN !== 'old-access-secret') {
          throw new Error('ACCESS should remain for retry')
        }
        if (process.env.CODEX_REFRESH_TOKEN !== 'old-refresh-secret') {
          throw new Error('REFRESH should remain for retry')
        }
        const settings = JSON.parse(
          readFileSync(join(isolatedDir, 'settings.json'), 'utf8'),
        )
        if (settings.env?.CODEX_ACCESS_TOKEN !== 'old-access-secret') {
          throw new Error('settings.env leftover should remain')
        }
        console.log('ok')
      } finally {
        rmSync(isolatedDir, { recursive: true, force: true })
      }
    `)
    expect(code).toBe(0)
    expect(output).toContain('ok')
  })

  test('resolveCodexRequestContext does not block when leftover strip fails', async () => {
    const { code, output } = await runIsolated(`
      import { mock } from 'bun:test'
      import { mkdtempSync, rmSync, writeFileSync } from 'fs'
      import { tmpdir } from 'os'
      import { join } from 'path'

      const store = { blob: {} }
      mock.module('src/utils/secureStorage/index.js', () => ({
        getSecureStorage: () => ({
          read: () => store.blob,
          update: (next) => {
            store.blob = { ...next }
            return { success: true }
          },
          delete: () => {
            store.blob = {}
            return true
          },
        }),
      }))
      mock.module('src/utils/settings/settings.js', () => ({
        updateSettingsForSource: () => ({ error: new Error('settings write denied') }),
      }))

      const isolatedDir = mkdtempSync(join(tmpdir(), 'codex-leftover-open-'))
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

      try {
        const {
          writeCodexAuth,
          resolveCodexRequestContext,
        } = await import('src/services/api/codex/credentials.js')
        writeCodexAuth({
          accessToken: 'stored-access',
          refreshToken: 'stored-refresh',
          accountId: 'acc_stored',
          expiresAt: Date.now() + 60 * 60 * 1000,
        })
        const ctx = await resolveCodexRequestContext()
        if (ctx.apiKey !== 'stored-access') throw new Error('wrong apiKey')
        if (process.env.CODEX_ACCESS_TOKEN !== 'old-access-secret') {
          throw new Error('ACCESS should remain for retry')
        }
        console.log('ok')
      } finally {
        rmSync(isolatedDir, { recursive: true, force: true })
      }
    `)
    expect(code).toBe(0)
    expect(output).toContain('ok')
  })
})
