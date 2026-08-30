import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const PROJECT_ROOT = resolve(import.meta.dir, '..', '..', '..', '..', '..')

async function runIsolated(source: string): Promise<string> {
  const proc = Bun.spawn([process.execPath, '-e', source], {
    cwd: PROJECT_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const output = `${stdout}\n${stderr}`
  expect(code, output).toBe(0)
  return output
}

describe('ChatGPT secure auth storage', () => {
  test('does not copy the external Codex identity into device-code auth', async () => {
    const output = await runIsolated(`
      import { mock } from 'bun:test'
      import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
      import { tmpdir } from 'os'
      import { join } from 'path'

      const store = { blob: { codexOauth: { accessToken: 'codex-sibling' } } }
      mock.module('src/utils/secureStorage/index.js', () => ({
        getSecureStorage: () => ({
          name: 'test',
          read: () => store.blob,
          update: next => {
            store.blob = { ...next }
            return { success: true }
          },
          delete: () => true,
        }),
      }))
      mock.module('src/utils/debug.js', () => ({ logForDebugging: () => {} }))

      const root = mkdtempSync(join(tmpdir(), 'chatgpt-auth-'))
      const configDir = join(root, 'claude')
      const codexDir = join(root, 'codex')
      mkdirSync(configDir)
      mkdirSync(codexDir)
      process.env.CLAUDE_CONFIG_DIR = configDir
      process.env.CODEX_HOME = codexDir
      const authPath = join(codexDir, 'auth.json')
      const auth = access => ({
        auth_mode: 'chatgpt',
        tokens: {
          id_token: 'id-' + access,
          access_token: access,
          refresh_token: 'refresh-' + access,
          account_id: 'acc_1',
        },
      })
      writeFileSync(authPath, JSON.stringify(auth('external-1')))

      try {
        const { getValidChatGPTAuth } = await import(
          'src/services/api/openai/chatgptAuth.js'
        )
        let rejected = false
        try {
          await getValidChatGPTAuth()
        } catch {
          rejected = true
        }
        if (!rejected) throw new Error('external Codex auth was copied')
        if (store.blob.openaiChatgptOauth) {
          throw new Error('device-code storage was populated')
        }
        if (store.blob.codexOauth.accessToken !== 'codex-sibling') {
          throw new Error('Codex sibling auth was changed')
        }
        console.log('ok')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    `)
    expect(output).toContain('ok')
  })

  test('imports and deletes the legacy file after secure persistence', async () => {
    const output = await runIsolated(`
      import { mock } from 'bun:test'
      import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
      import { tmpdir } from 'os'
      import { join } from 'path'

      const store = { blob: {} }
      mock.module('src/utils/secureStorage/index.js', () => ({
        getSecureStorage: () => ({
          name: 'test',
          read: () => store.blob,
          update: next => {
            store.blob = { ...next }
            return { success: true }
          },
          delete: () => true,
        }),
      }))
      mock.module('src/utils/debug.js', () => ({ logForDebugging: () => {} }))

      const root = mkdtempSync(join(tmpdir(), 'chatgpt-legacy-'))
      process.env.CLAUDE_CONFIG_DIR = root
      process.env.CODEX_HOME = join(root, 'missing-codex')
      const legacyPath = join(root, 'openai-chatgpt-auth.json')
      writeFileSync(legacyPath, JSON.stringify({
        tokens: {
          id_token: 'id-legacy',
          access_token: 'access-legacy',
          refresh_token: 'refresh-legacy',
          account_id: 'acc_legacy',
        },
      }))

      try {
        const { getValidChatGPTAuth } = await import(
          'src/services/api/openai/chatgptAuth.js'
        )
        if ((await getValidChatGPTAuth()).accessToken !== 'access-legacy') {
          throw new Error('legacy auth was not imported')
        }
        if (existsSync(legacyPath)) throw new Error('legacy file still exists')
        if (!store.blob.openaiChatgptOauth) throw new Error('secure auth missing')
        console.log('ok')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    `)
    expect(output).toContain('ok')
  })

  test('surfaces persistence failure and keeps the legacy file', async () => {
    const output = await runIsolated(`
      import { mock } from 'bun:test'
      import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
      import { tmpdir } from 'os'
      import { join } from 'path'

      mock.module('src/utils/secureStorage/index.js', () => ({
        getSecureStorage: () => ({
          name: 'test',
          read: () => ({}),
          update: () => ({ success: false }),
          delete: () => true,
        }),
      }))
      mock.module('src/utils/debug.js', () => ({ logForDebugging: () => {} }))

      const root = mkdtempSync(join(tmpdir(), 'chatgpt-auth-fail-'))
      mkdirSync(root, { recursive: true })
      process.env.CLAUDE_CONFIG_DIR = root
      process.env.CODEX_HOME = join(root, 'missing-codex')
      const legacyPath = join(root, 'openai-chatgpt-auth.json')
      writeFileSync(legacyPath, JSON.stringify({
        tokens: {
          id_token: 'id',
          access_token: 'access',
          refresh_token: 'refresh',
        },
      }))

      try {
        const { getValidChatGPTAuth } = await import(
          'src/services/api/openai/chatgptAuth.js'
        )
        let message = ''
        try {
          await getValidChatGPTAuth()
        } catch (error) {
          message = error instanceof Error ? error.message : String(error)
        }
        if (!message.includes('Failed to save ChatGPT credentials')) {
          throw new Error('storage failure was not surfaced: ' + message)
        }
        if (!existsSync(legacyPath)) throw new Error('legacy file was deleted')
        console.log('ok')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    `)
    expect(output).toContain('ok')
  })

  test('user abort stops waiting for proactive request refresh', async () => {
    const output = await runIsolated(`
      import { mock } from 'bun:test'
      import { mkdtempSync, rmSync, writeFileSync } from 'fs'
      import { tmpdir } from 'os'
      import { join } from 'path'

      const root = mkdtempSync(join(tmpdir(), 'chatgpt-proactive-abort-'))
      process.env.CLAUDE_CONFIG_DIR = root
      writeFileSync(join(root, '.openai-chatgpt-auth-migrated'), '')
      const payload = Buffer.from(JSON.stringify({ exp: 0 })).toString('base64url')
      const store = {
        blob: {
          openaiChatgptOauth: {
            idToken: 'id-old', accessToken: 'a.' + payload + '.s',
            refreshToken: 'refresh-old', accountId: 'acc_1', generation: 1,
          },
        },
      }
      mock.module('src/utils/secureStorage/index.js', () => ({
        getSecureStorage: () => ({
          name: 'test', read: () => store.blob, readFresh: () => store.blob,
          update: next => { store.blob = { ...next }; return { success: true } },
          delete: () => true,
        }),
      }))
      mock.module('src/utils/debug.js', () => ({ logForDebugging: () => {} }))
      let releaseRefresh = () => {}
      let refreshStarted = () => {}
      const started = new Promise(resolve => { refreshStarted = resolve })
      globalThis.fetch = () => new Promise(resolve => {
        refreshStarted()
        releaseRefresh = () => resolve(new Response(JSON.stringify({
          id_token: 'id-new', access_token: 'access-new', refresh_token: 'refresh-new',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      })

      const controller = new AbortController()
      try {
        const { createChatGPTResponsesStream } = await import(
          'src/services/api/openai/responsesAdapter.js'
        )
        const pending = createChatGPTResponsesStream({
          request: {
            model: 'gpt-5.5', stream: true, store: false, input: [],
            parallel_tool_calls: true,
          },
          signal: controller.signal,
          originator: 'codex_cli_rs', unauthorizedReplay: { used: false },
        }).then(() => 'resolved', () => 'aborted')
        await started
        controller.abort()
        const result = await Promise.race([
          pending,
          Bun.sleep(200).then(() => 'timeout'),
        ])
        if (result !== 'aborted') throw new Error('proactive refresh result: ' + result)
        releaseRefresh()
        await Bun.sleep(20)
        console.log('ok')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    `)
    expect(output).toContain('ok')
  })

  test('replays one subscription 401 with the refreshed token and Codex originator', async () => {
    const output = await runIsolated(`
      import { mock } from 'bun:test'
      import { mkdtempSync, rmSync } from 'fs'
      import { tmpdir } from 'os'
      import { join } from 'path'

      const root = mkdtempSync(join(tmpdir(), 'chatgpt-401-'))
      process.env.CLAUDE_CONFIG_DIR = root
      const store = {
        blob: {
          openaiChatgptOauth: {
            idToken: 'id-old',
            accessToken: 'access-old',
            refreshToken: 'refresh-old',
            accountId: 'acc_1',
            generation: 1,
          },
        },
      }
      mock.module('src/utils/secureStorage/index.js', () => ({
        getSecureStorage: () => ({
          name: 'test',
          read: () => store.blob,
          update: next => {
            store.blob = { ...next }
            return { success: true }
          },
          delete: () => true,
        }),
      }))
      mock.module('src/utils/debug.js', () => ({ logForDebugging: () => {} }))

      let refreshes = 0
      globalThis.fetch = async () => {
        refreshes += 1
        return new Response(JSON.stringify({
          id_token: 'id-new',
          access_token: 'access-new',
          refresh_token: 'refresh-new',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }

      const authorizations = []
      const originators = []
      const legacyHeaders = []
      let requests = 0
      const fetchOverride = Object.assign(async (_input, init) => {
        requests += 1
        const headers = new Headers(init?.headers)
        authorizations.push(headers.get('authorization'))
        originators.push(headers.get('originator'))
        legacyHeaders.push([
          headers.get('openai-beta'),
          headers.get('origin'),
          headers.get('referer'),
        ])
        if (requests === 1) return new Response('unauthorized', { status: 401 })
        return new Response(
          'data: {"type":"response.completed","response":{"status":"completed"}}\\n\\n',
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        )
      }, { preconnect: () => {} })

      const { createChatGPTResponsesStream } = await import(
        'src/services/api/openai/responsesAdapter.js'
      )
      const attempt = await createChatGPTResponsesStream({
        request: {
          model: 'gpt-5.5',
          stream: true,
          store: false,
          input: [],
          include: ['reasoning.encrypted_content'],
          parallel_tool_calls: true,
        },
        signal: new AbortController().signal,
        sessionId: 'session-1',
        fetchOverride,
        originator: 'codex_cli_rs',
        unauthorizedReplay: { used: false },
      })
      attempt.cleanup()

      if (requests !== 2 || refreshes !== 1) {
        throw new Error('expected one refresh and one request replay')
      }
      if (authorizations.join(',') !== 'Bearer access-old,Bearer access-new') {
        throw new Error('wrong authorization sequence: ' + authorizations.join(','))
      }
      if (originators.some(value => value !== 'codex_cli_rs')) {
        throw new Error('wrong originator: ' + originators.join(','))
      }
      if (legacyHeaders.some(values => values.some(value => value !== null))) {
        throw new Error('legacy browser headers were sent')
      }
      rmSync(root, { recursive: true, force: true })
      console.log('ok')
    `)
    expect(output).toContain('ok')
  })

  test('unauthorized replay state survives ordinary retries and allows one refresh total', async () => {
    const output = await runIsolated(`
      import { mock } from 'bun:test'
      import { mkdtempSync, rmSync, writeFileSync } from 'fs'
      import { tmpdir } from 'os'
      import { join } from 'path'

      const root = mkdtempSync(join(tmpdir(), 'chatgpt-query-401-'))
      process.env.CLAUDE_CONFIG_DIR = root
      writeFileSync(join(root, '.openai-chatgpt-auth-migrated'), '')
      const store = {
        blob: {
          openaiChatgptOauth: {
            idToken: 'id-old', accessToken: 'access-old',
            refreshToken: 'refresh-old', accountId: 'acc_1', generation: 1,
          },
        },
      }
      mock.module('src/utils/secureStorage/index.js', () => ({
        getSecureStorage: () => ({
          name: 'test', read: () => store.blob, readFresh: () => store.blob,
          update: next => { store.blob = { ...next }; return { success: true } },
          delete: () => true,
        }),
      }))
      mock.module('src/utils/debug.js', () => ({ logForDebugging: () => {} }))
      let refreshes = 0
      globalThis.fetch = async () => {
        refreshes++
        return new Response(JSON.stringify({
          id_token: 'id-new', access_token: 'access-new', refresh_token: 'refresh-new',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      const statuses = [401, 500, 401]
      let requests = 0
      const fetchOverride = Object.assign(async () =>
        new Response('failure', { status: statuses[requests++] }),
      { preconnect: () => {} })

      try {
        const { createChatGPTResponsesStream } = await import(
          'src/services/api/openai/responsesAdapter.js'
        )
        const unauthorizedReplay = { used: false }
        const request = {
          model: 'gpt-5.5', stream: true, store: false, input: [],
          include: ['reasoning.encrypted_content'], parallel_tool_calls: true,
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await createChatGPTResponsesStream({
              request, signal: new AbortController().signal,
              sessionId: 'session-1', fetchOverride,
              originator: 'codex_cli_rs', unauthorizedReplay,
            })
          } catch {}
        }
        if (requests !== 3 || refreshes !== 1 || !unauthorizedReplay.used) {
          throw new Error(JSON.stringify({ requests, refreshes, unauthorizedReplay }))
        }
        console.log('ok')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    `)
    expect(output).toContain('ok')
  })

  test('ordinary retry adopts a rotated token for the same account', async () => {
    const output = await runIsolated(`
      import { mock } from 'bun:test'
      import { mkdtempSync, rmSync, writeFileSync } from 'fs'
      import { tmpdir } from 'os'
      import { join } from 'path'

      const root = mkdtempSync(join(tmpdir(), 'chatgpt-token-rotation-'))
      process.env.CLAUDE_CONFIG_DIR = root
      writeFileSync(join(root, '.openai-chatgpt-auth-migrated'), '')
      const store = {
        blob: {
          openaiChatgptOauth: {
            idToken: 'id-old', accessToken: 'access-old',
            refreshToken: 'refresh-old', accountId: 'acc_1', generation: 1,
          },
        },
      }
      mock.module('src/utils/secureStorage/index.js', () => ({
        getSecureStorage: () => ({
          name: 'test', read: () => store.blob, readFresh: () => store.blob,
          update: next => { store.blob = { ...next }; return { success: true } },
          delete: () => true,
        }),
      }))
      mock.module('src/utils/debug.js', () => ({ logForDebugging: () => {} }))

      const authorizations = []
      let requests = 0
      const fetchOverride = Object.assign(async (_input, init) => {
        requests++
        authorizations.push(new Headers(init?.headers).get('authorization'))
        return requests === 1
          ? new Response('temporary', { status: 500 })
          : new Response(
              'data: {"type":"response.completed","response":{"status":"completed"}}\\n\\n',
              { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
            )
      }, { preconnect: () => {} })

      try {
        const { createChatGPTResponsesStream } = await import(
          'src/services/api/openai/responsesAdapter.js'
        )
        const unauthorizedReplay = { used: false }
        const params = {
          request: {
            model: 'gpt-5.5', stream: true, store: false, input: [],
            include: ['reasoning.encrypted_content'], parallel_tool_calls: true,
          },
          signal: new AbortController().signal,
          sessionId: 'session-1', fetchOverride,
          originator: 'codex_cli_rs', unauthorizedReplay,
        }
        try { await createChatGPTResponsesStream(params) } catch {}
        store.blob.openaiChatgptOauth = {
          idToken: 'id-new', accessToken: 'access-new',
          refreshToken: 'refresh-new', accountId: 'acc_1', generation: 2,
        }
        const attempt = await createChatGPTResponsesStream(params)
        attempt.cleanup()
        if (authorizations.join(',') !== 'Bearer access-old,Bearer access-new') {
          throw new Error('wrong authorization sequence: ' + authorizations.join(','))
        }
        console.log('ok')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    `)
    expect(output).toContain('ok')
  })

  test('user abort stops waiting for a shared 401 refresh', async () => {
    const output = await runIsolated(`
      import { mock } from 'bun:test'
      import { mkdtempSync, rmSync, writeFileSync } from 'fs'
      import { tmpdir } from 'os'
      import { join } from 'path'

      const root = mkdtempSync(join(tmpdir(), 'chatgpt-refresh-abort-'))
      process.env.CLAUDE_CONFIG_DIR = root
      writeFileSync(join(root, '.openai-chatgpt-auth-migrated'), '')
      const store = {
        blob: {
          openaiChatgptOauth: {
            idToken: 'id-old', accessToken: 'access-old',
            refreshToken: 'refresh-old', accountId: 'acc_1', generation: 1,
          },
        },
      }
      mock.module('src/utils/secureStorage/index.js', () => ({
        getSecureStorage: () => ({
          name: 'test', read: () => store.blob, readFresh: () => store.blob,
          update: next => { store.blob = { ...next }; return { success: true } },
          delete: () => true,
        }),
      }))
      mock.module('src/utils/debug.js', () => ({ logForDebugging: () => {} }))
      let releaseRefresh = () => {}
      globalThis.fetch = () => new Promise(resolve => {
        releaseRefresh = () => resolve(new Response(JSON.stringify({
          id_token: 'id-new', access_token: 'access-new', refresh_token: 'refresh-new',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      })

      const controller = new AbortController()
      const fetchOverride = Object.assign(async () => {
        queueMicrotask(() => controller.abort())
        return new Response('unauthorized', { status: 401 })
      }, { preconnect: () => {} })

      try {
        const { createChatGPTResponsesStream } = await import(
          'src/services/api/openai/responsesAdapter.js'
        )
        const result = await Promise.race([
          createChatGPTResponsesStream({
            request: {
              model: 'gpt-5.5', stream: true, store: false, input: [],
              include: ['reasoning.encrypted_content'], parallel_tool_calls: true,
            },
            signal: controller.signal,
            sessionId: 'session-1', fetchOverride,
            originator: 'codex_cli_rs', unauthorizedReplay: { used: false },
          }).then(() => 'resolved', () => 'aborted'),
          Bun.sleep(200).then(() => 'timeout'),
        ])
        if (result !== 'aborted') throw new Error('refresh wait result: ' + result)
        releaseRefresh()
        await Bun.sleep(20)
        console.log('ok')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    `)
    expect(output).toContain('ok')
  })

  test('account switch after 401 never replays the old request', async () => {
    const output = await runIsolated(`
      import { mock } from 'bun:test'
      import { mkdtempSync, rmSync, writeFileSync } from 'fs'
      import { tmpdir } from 'os'
      import { join } from 'path'

      const root = mkdtempSync(join(tmpdir(), 'chatgpt-account-switch-'))
      process.env.CLAUDE_CONFIG_DIR = root
      writeFileSync(join(root, '.openai-chatgpt-auth-migrated'), '')
      const store = {
        blob: {
          openaiChatgptOauth: {
            idToken: 'id-a', accessToken: 'access-a',
            refreshToken: 'refresh-a', accountId: 'acc_a', generation: 1,
          },
        },
      }
      mock.module('src/utils/secureStorage/index.js', () => ({
        getSecureStorage: () => ({
          name: 'test', read: () => store.blob, readFresh: () => store.blob,
          update: next => { store.blob = { ...next }; return { success: true } },
          delete: () => true,
        }),
      }))
      mock.module('src/utils/debug.js', () => ({ logForDebugging: () => {} }))
      let refreshes = 0
      globalThis.fetch = async () => { refreshes++; throw new Error('must not refresh B') }
      let requests = 0
      const fetchOverride = Object.assign(async () => {
        requests++
        store.blob.openaiChatgptOauth = {
          idToken: 'id-b', accessToken: 'access-b',
          refreshToken: 'refresh-b', accountId: 'acc_b', generation: 2,
        }
        return new Response('account A unauthorized', { status: 401 })
      }, { preconnect: () => {} })

      try {
        const { createChatGPTResponsesStream } = await import(
          'src/services/api/openai/responsesAdapter.js'
        )
        let message = ''
        try {
          await createChatGPTResponsesStream({
            request: {
              model: 'gpt-5.5', stream: true, store: false, input: [],
              include: ['reasoning.encrypted_content'], parallel_tool_calls: true,
            },
            signal: new AbortController().signal,
            sessionId: 'session-a', fetchOverride,
            originator: 'codex_cli_rs', unauthorizedReplay: { used: false },
          })
        } catch (error) {
          message = error instanceof Error ? error.message : String(error)
        }
        if (!message.includes('401') || requests !== 1 || refreshes !== 0) {
          throw new Error(JSON.stringify({ message, requests, refreshes }))
        }
        if (store.blob.openaiChatgptOauth.accountId !== 'acc_b') {
          throw new Error('new account was overwritten')
        }
        console.log('ok')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    `)
    expect(output).toContain('ok')
  })

  test('forced refresh is keyed single-flight', async () => {
    const output = await runIsolated(`
      import { mock } from 'bun:test'
      import { mkdtempSync, rmSync, writeFileSync } from 'fs'
      import { tmpdir } from 'os'
      import { join } from 'path'

      const root = mkdtempSync(join(tmpdir(), 'chatgpt-force-refresh-'))
      process.env.CLAUDE_CONFIG_DIR = root
      const store = {
        blob: {
          openaiChatgptOauth: {
            idToken: 'id-old',
            accessToken: 'access-old',
            refreshToken: 'refresh-old',
            accountId: 'acc_1',
            generation: 4,
          },
        },
      }
      mock.module('src/utils/secureStorage/index.js', () => ({
        getSecureStorage: () => ({
          name: 'test',
          read: () => store.blob,
          update: next => {
            store.blob = { ...next }
            return { success: true }
          },
          delete: () => true,
        }),
      }))
      mock.module('src/utils/debug.js', () => ({ logForDebugging: () => {} }))
      writeFileSync(join(root, '.openai-chatgpt-auth-migrated'), '')
      let fetches = 0
      globalThis.fetch = async () => {
        fetches += 1
        await Bun.sleep(20)
        return new Response(JSON.stringify({
          id_token: 'id-new',
          access_token: 'access-new',
          refresh_token: 'refresh-new',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }

      try {
        const { forceRefreshChatGPTAuth } = await import(
          'src/services/api/openai/chatgptAuth.js'
        )
        const [first, second] = await Promise.all([
          forceRefreshChatGPTAuth(),
          forceRefreshChatGPTAuth(),
        ])
        if (fetches !== 1) throw new Error('expected one refresh request')
        if (first.accessToken !== 'access-new' || second.accessToken !== 'access-new') {
          throw new Error('wrong refreshed token')
        }
        if (store.blob.openaiChatgptOauth.generation !== 5) {
          throw new Error('generation was not advanced')
        }
        console.log('ok')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    `)
    expect(output).toContain('ok')
  })

  test('logout in a second process wins over an in-flight refresh', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chatgpt-auth-process-race-'))
    const refreshStarted = join(root, 'refresh-started')
    const logoutStarted = join(root, 'logout-started')
    const releaseRefresh = join(root, 'release-refresh')
    writeFileSync(
      join(root, '.credentials.json'),
      JSON.stringify({
        codexOauth: { accessToken: 'codex-sibling' },
        openaiChatgptOauth: {
          idToken: 'id-old',
          accessToken: 'access-old',
          refreshToken: 'refresh-old',
          accountId: 'acc_old',
          generation: 1,
        },
      }),
    )
    writeFileSync(join(root, '.openai-chatgpt-auth-migrated'), '')

    const setup = `
      import { mock } from 'bun:test'
      import { plainTextStorage } from 'src/utils/secureStorage/plainTextStorage.js'
      process.env.CLAUDE_CONFIG_DIR = ${JSON.stringify(root)}
      mock.module('src/utils/secureStorage/index.js', () => ({
        getSecureStorage: () => plainTextStorage,
      }))
      mock.module('src/utils/debug.js', () => ({ logForDebugging: () => {} }))
    `
    const refresher = Bun.spawn(
      [
        process.execPath,
        '-e',
        `${setup}
          import { existsSync, writeFileSync } from 'fs'
          globalThis.fetch = async () => {
            writeFileSync(${JSON.stringify(refreshStarted)}, '')
            while (!existsSync(${JSON.stringify(releaseRefresh)})) await Bun.sleep(5)
            return new Response(JSON.stringify({
              id_token: 'id-refreshed',
              access_token: 'access-refreshed',
              refresh_token: 'refresh-refreshed',
            }), { status: 200, headers: { 'Content-Type': 'application/json' } })
          }
          const { forceRefreshChatGPTAuth } = await import(
            'src/services/api/openai/chatgptAuth.js'
          )
          await forceRefreshChatGPTAuth('acc_old')
        `,
      ],
      { cwd: PROJECT_ROOT, stdout: 'pipe', stderr: 'pipe' },
    )

    const waitFor = async (path: string): Promise<void> => {
      const deadline = Date.now() + 10_000
      while (!existsSync(path)) {
        if (Date.now() >= deadline)
          throw new Error(`Timed out waiting for ${path}`)
        await Bun.sleep(5)
      }
    }

    try {
      await waitFor(refreshStarted)
      const logout = Bun.spawn(
        [
          process.execPath,
          '-e',
          `${setup}
            import { writeFileSync } from 'fs'
            writeFileSync(${JSON.stringify(logoutStarted)}, '')
            const { removeChatGPTAuth } = await import(
              'src/services/api/openai/chatgptAuth.js'
            )
            await removeChatGPTAuth()
          `,
        ],
        { cwd: PROJECT_ROOT, stdout: 'pipe', stderr: 'pipe' },
      )
      await waitFor(logoutStarted)
      writeFileSync(releaseRefresh, '')

      const [refreshCode, logoutCode, refreshError, logoutError] =
        await Promise.all([
          refresher.exited,
          logout.exited,
          new Response(refresher.stderr).text(),
          new Response(logout.stderr).text(),
        ])
      expect(refreshCode, refreshError).toBe(0)
      expect(logoutCode, logoutError).toBe(0)

      const finalBlob = JSON.parse(
        readFileSync(join(root, '.credentials.json'), 'utf8'),
      ) as Record<string, unknown>
      expect(finalBlob.openaiChatgptOauth).toBeUndefined()
      expect(finalBlob.codexOauth).toEqual({ accessToken: 'codex-sibling' })
    } finally {
      writeFileSync(releaseRefresh, '')
      refresher.kill()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
