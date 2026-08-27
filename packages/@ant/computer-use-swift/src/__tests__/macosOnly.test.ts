import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'

const packageRoot = resolve(import.meta.dir, '..')
const repoRoot = resolve(import.meta.dir, '../../../../..')
const packageIndex = readFileSync(resolve(packageRoot, 'index.ts'), 'utf8')
const hostExecutor = readFileSync(
  resolve(repoRoot, 'src/utils/computerUse/executor.ts'),
  'utf8',
)

describe('@ant/computer-use-swift platform boundary', () => {
  test('keeps the private Swift package macOS-only', () => {
    expect(packageIndex).toContain("require('./backends/darwin.js')")
    expect(packageIndex).not.toContain("require('./backends/win32.js')")
    expect(packageIndex).not.toContain("require('./backends/linux.js')")
    expect(existsSync(resolve(packageRoot, 'backends/win32.ts'))).toBe(false)
    expect(existsSync(resolve(packageRoot, 'backends/linux.ts'))).toBe(false)
  })

  test('retains the host cross-platform executor for non-macOS', () => {
    expect(hostExecutor).toContain("process.platform !== 'darwin'")
    expect(hostExecutor).toContain("require('./executorCrossPlatform.js')")
  })
})
