/**
 * @ant/computer-use-swift — macOS display, apps, and screenshot (Swift native)
 *
 * This package wraps the macOS-only Swift .node native module.
 * For Windows/Linux, use src/utils/computerUse/platforms/ instead.
 */

export type {
  DisplayGeometry,
  PrepareDisplayResult,
  AppInfo,
  InstalledApp,
  RunningApp,
  ScreenshotResult,
  ResolvePrepareCaptureResult,
  WindowDisplayInfo,
} from './types.js'

import { createRequire } from 'node:module'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResolvePrepareCaptureResult, SwiftBackend } from './types.js'

const nodeRequire = createRequire(import.meta.url)

function vendorRoot(): string {
  const dir = dirname(fileURLToPath(import.meta.url))
  const parts = dir.split(sep)
  const distIndex = parts.lastIndexOf('dist')
  return distIndex === -1
    ? resolve(dir, '..', '..', '..', '..', 'vendor')
    : `${parts.slice(0, distIndex + 1).join(sep)}${sep}vendor`
}

function loadNativeBackend(): SwiftBackend | null {
  const binary = 'computer-use-swift.node'
  const candidates = new Set([
    process.env.COMPUTER_USE_SWIFT_NODE_PATH,
    resolve(vendorRoot(), 'computer-use', binary),
    resolve(dirname(process.execPath), 'vendor', 'computer-use', binary),
    resolve(process.cwd(), 'vendor', 'computer-use', binary),
  ])
  for (const path of candidates) {
    if (!path) continue
    try {
      const candidate = nodeRequire(path) as { computerUse?: SwiftBackend }
      if (
        candidate.computerUse?.apps &&
        candidate.computerUse.display &&
        candidate.computerUse.screenshot &&
        typeof candidate.computerUse.resolvePrepareCapture === 'function'
      ) {
        return candidate.computerUse
      }
    } catch {
      // Try the next packaged/runtime location before using the script fallback.
    }
  }
  return null
}

function loadBackend(): SwiftBackend | null {
  if (process.platform !== 'darwin') return null
  const native = loadNativeBackend()
  if (native) return native
  try {
    const fallback = require('./backends/darwin.js') as Omit<
      SwiftBackend,
      'resolvePrepareCapture'
    >
    return {
      ...fallback,
      resolvePrepareCapture(
        allowedBundleIds,
        _surrogateHost,
        quality,
        targetW,
        targetH,
        displayId,
      ) {
        return fallback.screenshot.captureExcluding(
          allowedBundleIds,
          quality,
          targetW,
          targetH,
          displayId,
        )
      },
    }
  } catch {
    return null
  }
}

const backend = loadBackend()

class UnsupportedComputerUseAPI implements SwiftBackend {
  apps = backend?.apps ?? {
    async prepareDisplay() {
      return { activated: '', hidden: [] }
    },
    async previewHideSet() {
      return []
    },
    async findWindowDisplays(ids: string[]) {
      return ids.map((b: string) => ({
        bundleId: b,
        displayIds: [] as number[],
      }))
    },
    async appUnderPoint() {
      return null
    },
    async listInstalled() {
      return []
    },
    iconDataUrl() {
      return null
    },
    listRunning() {
      return []
    },
    async open() {
      throw new Error('@ant/computer-use-swift: macOS only')
    },
    async unhide() {},
  }

  display = backend?.display ?? {
    getSize() {
      throw new Error('@ant/computer-use-swift: macOS only')
    },
    listAll() {
      throw new Error('@ant/computer-use-swift: macOS only')
    },
  }

  screenshot = backend?.screenshot ?? {
    async captureExcluding() {
      throw new Error('@ant/computer-use-swift: macOS only')
    },
    async captureRegion() {
      throw new Error('@ant/computer-use-swift: macOS only')
    },
  }

  resolvePrepareCapture: SwiftBackend['resolvePrepareCapture'] =
    backend?.resolvePrepareCapture ??
    (async () => {
      throw new Error('@ant/computer-use-swift: macOS only')
    })

  hotkey = backend?.hotkey
  tcc = backend?.tcc
  _drainMainRunLoop = backend?._drainMainRunLoop
}

export type ComputerUseAPI = SwiftBackend
export const computerUse: ComputerUseAPI =
  backend ?? new UnsupportedComputerUseAPI()
