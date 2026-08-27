/**
 * @ant/computer-use-input — macOS keyboard & mouse simulation (enigo)
 *
 * This package wraps the macOS-only native enigo .node module.
 * For Windows/Linux, use src/utils/computerUse/platforms/ instead.
 */

import { createRequire } from 'node:module'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { InputBackend } from './types.js'

export type { FrontmostAppInfo, InputBackend } from './types.js'

const nodeRequire = createRequire(import.meta.url)
const nativeFunctions = [
  'moveMouse',
  'key',
  'keys',
  'mouseLocation',
  'mouseButton',
  'mouseScroll',
  'typeText',
  'getFrontmostAppInfo',
] as const

function vendorRoot(): string {
  const dir = dirname(fileURLToPath(import.meta.url))
  const parts = dir.split(sep)
  const distIndex = parts.lastIndexOf('dist')
  return distIndex === -1
    ? resolve(dir, '..', '..', '..', '..', 'vendor')
    : `${parts.slice(0, distIndex + 1).join(sep)}${sep}vendor`
}

function loadNativeBackend(): InputBackend | null {
  const binary = 'computer-use-input.node'
  const candidates = new Set([
    process.env.COMPUTER_USE_INPUT_NODE_PATH,
    resolve(vendorRoot(), 'computer-use', binary),
    resolve(dirname(process.execPath), 'vendor', 'computer-use', binary),
    resolve(process.cwd(), 'vendor', 'computer-use', binary),
  ])
  for (const path of candidates) {
    if (!path) continue
    try {
      const candidate = nodeRequire(path) as Record<string, unknown>
      if (
        nativeFunctions.every(name => typeof candidate[name] === 'function')
      ) {
        return candidate as unknown as InputBackend
      }
    } catch {
      // Try the next packaged/runtime location before using the script fallback.
    }
  }
  return null
}

function loadBackend(): InputBackend | null {
  if (process.platform !== 'darwin') return null
  const native = loadNativeBackend()
  if (native) return native
  try {
    return require('./backends/darwin.js') as InputBackend
  } catch {
    return null
  }
}

const backend = loadBackend()

export const isSupported = backend !== null
export const moveMouse = backend?.moveMouse
export const key = backend?.key
export const keys = backend?.keys
export const mouseLocation = backend?.mouseLocation
export const mouseButton = backend?.mouseButton
export const mouseScroll = backend?.mouseScroll
export const typeText = backend?.typeText
export const getFrontmostAppInfo = backend?.getFrontmostAppInfo ?? (() => null)

export interface ComputerUseInputAPI extends InputBackend {
  isSupported: true
}

interface ComputerUseInputUnsupported {
  isSupported: false
}
export type ComputerUseInput = ComputerUseInputAPI | ComputerUseInputUnsupported
