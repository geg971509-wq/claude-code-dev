import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const originalEnv = process.env.IMAGE_PROCESSOR_NODE_PATH

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.IMAGE_PROCESSOR_NODE_PATH
  } else {
    process.env.IMAGE_PROCESSOR_NODE_PATH = originalEnv
  }
  // Module caches loadAttempted — re-import via dynamic path is hard.
  // Tests below only assert public behavior after first load in this process.
})

describe('image-processor-napi', () => {
  test('sharpCompat can resize+jpeg+toBuffer without native (or with)', async () => {
    // Force bad path first only if not already loaded; still must not throw.
    process.env.IMAGE_PROCESSOR_NODE_PATH =
      '/tmp/definitely-missing-image-processor.node'
    const mod = await import('../index.js')
    const out = await mod.sharp(TINY_PNG).jpeg({ quality: 80 }).toBuffer()
    expect(out.length).toBeGreaterThan(0)
    // JPEG SOI
    expect(out[0]).toBe(0xff)
    expect(out[1]).toBe(0xd8)
  })

  test('getNativeModule is stable reference across calls', async () => {
    const mod = await import('../index.js')
    const a = mod.getNativeModule()
    const b = mod.getNativeModule()
    // Both null or same object identity for clipboard surface
    if (a === null) {
      expect(b).toBeNull()
    } else {
      expect(b).toBe(a)
      expect(typeof a.hasClipboardImage).toBe('function')
      expect(typeof a.readClipboardImage).toBe('function')
    }
  })

  test('native processImage smoke when vendor or env blob exists', async () => {
    const vendorPath = resolve(
      process.cwd(),
      'vendor/image-processor/arm64-darwin/image-processor.node',
    )
    const envPath = process.env.IMAGE_PROCESSOR_NODE_PATH
    const hasBlob =
      (envPath && existsSync(envPath)) ||
      (process.platform === 'darwin' &&
        process.arch === 'arm64' &&
        existsSync(vendorPath))

    if (!hasBlob) {
      // V1: no blob → skip, do not fail CI
      return
    }

    // Prefer explicit env if set; else vendor path
    if (!envPath && existsSync(vendorPath)) {
      process.env.IMAGE_PROCESSOR_NODE_PATH = vendorPath
    }

    // Fresh process would re-load; in-process we may already be cached as null.
    // Probe via createRequire directly for smoke when blob exists.
    const { createRequire } = await import('node:module')
    const req = createRequire(import.meta.url)
    const path = process.env.IMAGE_PROCESSOR_NODE_PATH || vendorPath
    const native = req(path) as {
      processImage: (b: Buffer) => Promise<{
        metadata: () => Promise<{
          width: number
          height: number
          format: string
        }>
        dispose?: () => void
      }>
    }
    const handle = await native.processImage(TINY_PNG)
    try {
      const meta = await handle.metadata()
      expect(meta.width).toBe(1)
      expect(meta.height).toBe(1)
      expect(meta.format).toBe('png')
    } finally {
      handle.dispose?.()
    }
  })
})
