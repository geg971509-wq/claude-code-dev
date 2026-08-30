import { describe, expect, test } from 'bun:test'
import { resolve } from 'path'
import { createFallbackStorage } from '../fallbackStorage.js'

const PROJECT_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

describe('fallback secure storage deletion', () => {
  test('fails an update when stale primary credentials cannot be removed', () => {
    const storage = createFallbackStorage(
      {
        name: 'primary',
        read: () => ({ token: 'old-secret' }),
        readAsync: async () => ({ token: 'old-secret' }),
        update: () => ({ success: false }),
        delete: () => false,
      },
      {
        name: 'secondary',
        read: () => null,
        readAsync: async () => null,
        update: () => ({ success: true }),
        delete: () => true,
      },
    )

    expect(storage.update({ token: 'new-secret' })).toEqual({ success: false })
  })

  test('fails a primary update when stale fallback credentials remain', () => {
    const storage = createFallbackStorage(
      {
        name: 'primary',
        read: () => ({ token: 'primary-secret' }),
        readAsync: async () => ({ token: 'primary-secret' }),
        update: () => ({ success: true }),
        delete: () => true,
      },
      {
        name: 'secondary',
        read: () => ({ token: 'stale-secret' }),
        readAsync: async () => ({ token: 'stale-secret' }),
        update: () => ({ success: true }),
        delete: () => false,
      },
    )

    expect(storage.update({ token: 'new-secret' })).toEqual({ success: false })
  })

  test('deletes a hidden stale primary after fallback write', () => {
    let hiddenPrimary = true
    const storage = createFallbackStorage(
      {
        name: 'primary',
        read: () => null,
        readAsync: async () => null,
        update: () => ({ success: false }),
        delete: () => {
          hiddenPrimary = false
          return true
        },
      },
      {
        name: 'secondary',
        read: () => null,
        readAsync: async () => null,
        update: () => ({ success: true }),
        delete: () => true,
      },
    )

    expect(storage.update({ token: 'new-secret' })).toEqual({ success: true })
    expect(hiddenPrimary).toBe(false)
  })

  test('fails when a populated backend retains credentials', () => {
    const storage = createFallbackStorage(
      {
        name: 'primary',
        read: () => ({ token: 'secret' }),
        readAsync: async () => ({ token: 'secret' }),
        update: () => ({ success: true }),
        delete: () => false,
      },
      {
        name: 'secondary',
        read: () => null,
        readAsync: async () => null,
        update: () => ({ success: true }),
        delete: () => true,
      },
    )

    expect(storage.delete()).toBe(false)
  })

  test('requires both idempotent backends to confirm deletion', () => {
    const storage = createFallbackStorage(
      {
        name: 'primary',
        read: () => null,
        readAsync: async () => null,
        update: () => ({ success: true }),
        delete: () => true,
      },
      {
        name: 'secondary',
        read: () => null,
        readAsync: async () => null,
        update: () => ({ success: true }),
        delete: () => true,
      },
    )

    expect(storage.delete()).toBe(true)
  })
})

describe('macOS keychain fresh reads', () => {
  test('treats a missing keychain item as an idempotent delete', async () => {
    const proc = Bun.spawn(
      [
        process.execPath,
        '-e',
        `
          import { mock } from 'bun:test'
          mock.module('execa', () => ({
            execa: async () => ({ exitCode: 0 }),
            execaSync: () => ({ exitCode: 44 }),
          }))
          mock.module('src/utils/debug.js', () => ({ logForDebugging: () => {} }))
          const { macOsKeychainStorage } = await import(
            'src/utils/secureStorage/macOsKeychainStorage.js'
          )
          if (!macOsKeychainStorage.delete()) throw new Error('missing item was not idempotent')
        `,
      ],
      { cwd: PROJECT_ROOT, stdout: 'pipe', stderr: 'pipe' },
    )
    const [code, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
  })

  test('readFresh bypasses the 30s process cache', async () => {
    const proc = Bun.spawn(
      [
        process.execPath,
        '-e',
        `
          import { mock } from 'bun:test'
          let value = '{"version":1}'
          mock.module('src/utils/execFileNoThrowPortable.js', () => ({
            execSyncWithDefaults_DEPRECATED: () => value,
          }))
          mock.module('execa', () => ({
            execa: async () => ({ exitCode: 0 }),
            execaSync: () => ({ exitCode: 0, get stdout() { return value } }),
          }))
          mock.module('src/utils/debug.js', () => ({ logForDebugging: () => {} }))
          const { macOsKeychainStorage } = await import(
            'src/utils/secureStorage/macOsKeychainStorage.js'
          )
          if (macOsKeychainStorage.read()?.version !== 1) throw new Error('initial read failed')
          value = '{"version":2}'
          if (macOsKeychainStorage.read()?.version !== 1) throw new Error('cache was not used')
          if (macOsKeychainStorage.readFresh()?.version !== 2) throw new Error('fresh read used cache')
        `,
      ],
      { cwd: PROJECT_ROOT, stdout: 'pipe', stderr: 'pipe' },
    )
    const [code, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
  })
})
