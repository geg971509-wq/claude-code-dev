import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import * as swiftPackage from '../index.js'

const nativePath = resolve(
  import.meta.dir,
  '../../../../../vendor/computer-use/computer-use-swift.node',
)

describe('@ant/computer-use-swift native parity', () => {
  test('connects the complete official computerUse surface on macOS', () => {
    if (process.platform !== 'darwin') return
    if (!existsSync(nativePath)) {
      expect(existsSync(nativePath)).toBe(true)
      return
    }

    const native = createRequire(import.meta.url)(nativePath) as {
      computerUse: Record<string, unknown>
    }
    expect('computerUse' in swiftPackage).toBe(true)
    if (!('computerUse' in swiftPackage)) return

    const computerUse = swiftPackage.computerUse as unknown as Record<
      string,
      unknown
    >
    expect(computerUse).toBe(native.computerUse)
    for (const name of [
      'apps',
      'display',
      'screenshot',
      'resolvePrepareCapture',
      'hotkey',
      'tcc',
      '_drainMainRunLoop',
    ] as const) {
      expect(computerUse[name]).toBe(native.computerUse[name])
    }
  })
})
