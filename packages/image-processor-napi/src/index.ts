import { createRequire } from 'node:module'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharpModule from 'sharp'

// createRequire works in both Bun and Node.js ESM contexts.
// Needed for loading native .node addons under "type": "module".
const nodeRequire = createRequire(import.meta.url)

type ImageProcessorHandle = {
  metadata():
    | Promise<{ width?: number; height?: number; format?: string }>
    | {
        width?: number
        height?: number
        format?: string
      }
  resize(
    width: number,
    height: number,
    options?: { fit?: string; withoutEnlargement?: boolean },
  ): unknown
  jpeg(qualityOrOptions?: number | { quality?: number }): unknown
  png(options?: {
    compressionLevel?: number
    palette?: boolean
    colors?: number
  }): unknown
  webp(qualityOrOptions?: number | { quality?: number }): unknown
  toBuffer(): Promise<Buffer> | Buffer
  dispose?: () => void
}

type ClipboardImage = {
  png: Buffer
  width: number
  height: number
  originalWidth: number
  originalHeight: number
}

/** True native module only — never an osascript polyfill. */
export type NativeModule = {
  processImage(
    buf: Buffer,
  ): Promise<ImageProcessorHandle> | ImageProcessorHandle
  hasClipboardImage(): boolean
  readClipboardImage(
    maxWidth?: number,
    maxHeight?: number,
  ): ClipboardImage | null
}

type SharpLike = {
  metadata(): Promise<{ width?: number; height?: number; format?: string }>
  resize(
    width: number,
    height: number,
    options?: { fit?: string; withoutEnlargement?: boolean },
  ): SharpLike
  jpeg(options?: { quality?: number }): SharpLike
  png(options?: {
    compressionLevel?: number
    palette?: boolean
    colors?: number
  }): SharpLike
  webp(options?: { quality?: number }): SharpLike
  toBuffer(): Promise<Buffer>
}

type SharpFunction = (input: Buffer) => SharpLike

function getVendorRoot(): string {
  const filePath = fileURLToPath(import.meta.url)
  const dir = dirname(filePath)
  const parts = dir.split(sep)
  const distIdx = parts.lastIndexOf('dist')
  if (distIdx !== -1) {
    return parts.slice(0, distIdx + 1).join(sep) + sep + 'vendor'
  }
  // Dev: packages/image-processor-napi/src → project root vendor/
  return resolve(dir, '..', '..', '..', 'vendor')
}

let loadAttempted = false
let cachedTrueNative: NativeModule | null = null

function loadTrueNative(): NativeModule | null {
  if (loadAttempted) {
    return cachedTrueNative
  }
  loadAttempted = true

  const candidates: string[] = []
  if (process.env.IMAGE_PROCESSOR_NODE_PATH) {
    candidates.push(process.env.IMAGE_PROCESSOR_NODE_PATH)
  }
  const platformDir = `${process.arch}-${process.platform}`
  const binaryRel = `image-processor/${platformDir}/image-processor.node`
  const vendorRoot = getVendorRoot()
  candidates.push(
    resolve(vendorRoot, binaryRel),
    resolve(process.cwd(), 'vendor', binaryRel),
    resolve(process.cwd(), binaryRel),
  )

  for (const p of candidates) {
    try {
      const mod = nodeRequire(p) as Record<string, unknown>
      if (typeof mod.processImage !== 'function') {
        continue
      }
      if (
        typeof mod.hasClipboardImage !== 'function' ||
        typeof mod.readClipboardImage !== 'function'
      ) {
        continue
      }
      const processImage = mod.processImage as NativeModule['processImage']
      const hasClipboardImage =
        mod.hasClipboardImage as NativeModule['hasClipboardImage']
      const readClipboardImage =
        mod.readClipboardImage as NativeModule['readClipboardImage']

      // Single path: method-level catch → false/null, never osascript.
      cachedTrueNative = {
        processImage: (buf: Buffer) => processImage(buf),
        hasClipboardImage(): boolean {
          try {
            return hasClipboardImage()
          } catch {
            return false
          }
        },
        readClipboardImage(maxWidth?, maxHeight?) {
          try {
            return readClipboardImage(maxWidth, maxHeight)
          } catch {
            return null
          }
        },
      }
      return cachedTrueNative
    } catch {
      // try next
    }
  }

  cachedTrueNative = null
  return null
}

/**
 * Official-shaped sharp compat shell (tku):
 * queue resize/jpeg/png/webp ops, apply once on toBuffer after processImage.
 * Each metadata/toBuffer creates a fresh handle and disposes it.
 */
function createSharpCompat(native: NativeModule): SharpFunction {
  return (input: Buffer): SharpLike => {
    const ops: Array<(h: ImageProcessorHandle) => void> = []

    async function materialize(
      applyOps: boolean,
    ): Promise<ImageProcessorHandle> {
      const handle = await native.processImage(input)
      if (applyOps) {
        for (const op of ops) {
          op(handle)
        }
      }
      return handle
    }

    const chain: SharpLike = {
      async metadata() {
        const handle = await materialize(false)
        try {
          return await handle.metadata()
        } finally {
          handle.dispose?.()
        }
      },
      resize(width, height, options) {
        ops.push(h => {
          h.resize(width, height, options)
        })
        return chain
      },
      jpeg(options) {
        ops.push(h => {
          // Official native jpeg() takes quality number; sharp takes options object.
          h.jpeg(options?.quality)
        })
        return chain
      },
      png(options) {
        ops.push(h => {
          h.png(options)
        })
        return chain
      },
      webp(options) {
        ops.push(h => {
          h.webp(options?.quality)
        })
        return chain
      },
      async toBuffer() {
        const handle = await materialize(true)
        try {
          return await handle.toBuffer()
        } finally {
          handle.dispose?.()
        }
      },
    }
    return chain
  }
}

/**
 * True native only. null when .node missing — callers (imagePaste) fall back
 * to their own osascript path. Never return a polyfill as NativeModule.
 */
export function getNativeModule(): NativeModule | null {
  return loadTrueNative()
}

function resolveRealSharp(): SharpFunction {
  const mod = sharpModule as unknown as
    | SharpFunction
    | { default: SharpFunction }
  return typeof mod === 'function' ? mod : mod.default
}

// Resolve once: native queue shell if .node loads, else real sharp.
const trueNative = loadTrueNative()
const sharpCompat: SharpFunction = trueNative
  ? createSharpCompat(trueNative)
  : resolveRealSharp()

export const sharp = sharpCompat
export default sharpCompat
