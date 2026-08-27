import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import * as input from '../index.js'

const nativePath = resolve(
  import.meta.dir,
  '../../../../../vendor/computer-use/computer-use-input.node',
)

describe('@ant/computer-use-input native parity', () => {
  test('loads every official native input export on macOS', () => {
    if (process.platform !== 'darwin') return
    if (!existsSync(nativePath)) {
      expect(existsSync(nativePath)).toBe(true)
      return
    }

    const native = createRequire(import.meta.url)(nativePath) as Record<
      string,
      unknown
    >
    for (const name of [
      'moveMouse',
      'key',
      'keys',
      'mouseLocation',
      'mouseButton',
      'mouseScroll',
      'typeText',
      'getFrontmostAppInfo',
    ] as const) {
      expect((input as Record<string, unknown>)[name]).toBe(native[name])
    }
    expect(input.isSupported).toBe(true)
  })
})
