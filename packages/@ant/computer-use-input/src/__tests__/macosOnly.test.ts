import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'

const packageRoot = resolve(import.meta.dir, '..')
const packageIndex = readFileSync(resolve(packageRoot, 'index.ts'), 'utf8')

describe('@ant/computer-use-input platform boundary', () => {
  test('keeps the private native input package macOS-only', () => {
    expect(packageIndex).toContain("require('./backends/darwin.js')")
    expect(packageIndex).not.toContain("require('./backends/win32.js')")
    expect(packageIndex).not.toContain("require('./backends/linux.js')")
    expect(existsSync(resolve(packageRoot, 'backends/win32.ts'))).toBe(false)
    expect(existsSync(resolve(packageRoot, 'backends/linux.ts'))).toBe(false)
  })
})
