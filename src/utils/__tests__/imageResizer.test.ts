/**
 * Tests for image magic-byte detection + header dimension parse.
 * Unknown format returns null (official uSe); no silent image/png default.
 */
import { describe, expect, test } from 'bun:test'
import {
  detectImageFormatFromBase64,
  detectImageFormatFromBuffer,
  readImageDimensionsFromHeader,
} from '../imageResizer.js'

// ── Magic byte helpers ────────────────────────────────────────────────────────

/** PNG magic bytes: 0x89 0x50 0x4E 0x47 ... */
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** JPEG magic bytes: 0xFF 0xD8 0xFF */
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
/** GIF magic bytes: GIF89a */
const GIF_HEADER = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
/** WebP: RIFF....WEBP */
const WEBP_HEADER = Buffer.from([
  0x52,
  0x49,
  0x46,
  0x46, // RIFF
  0x00,
  0x00,
  0x00,
  0x00, // file size (placeholder)
  0x57,
  0x45,
  0x42,
  0x50, // WEBP
])

function toBase64(buf: Buffer): string {
  return buf.toString('base64')
}

/** Minimal 1×1 PNG (real file, has IHDR dims). */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

// ── detectImageFormatFromBuffer ───────────────────────────────────────────────

describe('detectImageFormatFromBuffer', () => {
  test('detects PNG from magic bytes', () => {
    expect(detectImageFormatFromBuffer(PNG_HEADER)).toBe('image/png')
  })

  test('detects JPEG from magic bytes', () => {
    expect(detectImageFormatFromBuffer(JPEG_HEADER)).toBe('image/jpeg')
  })

  test('detects GIF from magic bytes', () => {
    expect(detectImageFormatFromBuffer(GIF_HEADER)).toBe('image/gif')
  })

  test('detects WebP from RIFF+WEBP magic bytes', () => {
    expect(detectImageFormatFromBuffer(WEBP_HEADER)).toBe('image/webp')
  })

  test('returns null for unknown format', () => {
    const unknown = Buffer.from([0x00, 0x01, 0x02, 0x03])
    expect(detectImageFormatFromBuffer(unknown)).toBeNull()
  })

  test('returns null for buffer shorter than 4 bytes', () => {
    expect(detectImageFormatFromBuffer(Buffer.from([0x89]))).toBeNull()
    expect(detectImageFormatFromBuffer(Buffer.alloc(0))).toBeNull()
  })
})

// ── detectImageFormatFromBase64 ───────────────────────────────────────────────

describe('detectImageFormatFromBase64', () => {
  test('detects PNG from base64-encoded PNG header', () => {
    expect(detectImageFormatFromBase64(toBase64(PNG_HEADER))).toBe('image/png')
  })

  test('detects JPEG from base64-encoded JPEG header', () => {
    expect(detectImageFormatFromBase64(toBase64(JPEG_HEADER))).toBe(
      'image/jpeg',
    )
  })

  test('detects GIF from base64-encoded GIF header', () => {
    expect(detectImageFormatFromBase64(toBase64(GIF_HEADER))).toBe('image/gif')
  })

  test('detects WebP from base64-encoded WebP header', () => {
    expect(detectImageFormatFromBase64(toBase64(WEBP_HEADER))).toBe(
      'image/webp',
    )
  })

  test('returns null for empty string', () => {
    expect(detectImageFormatFromBase64('')).toBeNull()
  })

  test('returns null for invalid base64 / non-image', () => {
    // Should not throw — null instead of silent image/png
    expect(detectImageFormatFromBase64('!!!not-base64!!!')).toBeNull()
  })

  test('macOS screencapture PNG is not misidentified as JPEG', () => {
    const result = detectImageFormatFromBase64(toBase64(PNG_HEADER))
    expect(result).not.toBe('image/jpeg')
    expect(result).toBe('image/png')
  })
})

// ── readImageDimensionsFromHeader ─────────────────────────────────────────────

describe('readImageDimensionsFromHeader', () => {
  test('reads 1x1 from real tiny PNG', () => {
    expect(readImageDimensionsFromHeader(TINY_PNG)).toEqual({
      width: 1,
      height: 1,
    })
  })

  test('reads GIF logical screen descriptor', () => {
    // GIF89a + width=10 height=20 little-endian
    const gif = Buffer.alloc(10)
    Buffer.from('GIF89a').copy(gif)
    gif.writeUInt16LE(10, 6)
    gif.writeUInt16LE(20, 8)
    expect(readImageDimensionsFromHeader(gif)).toEqual({
      width: 10,
      height: 20,
    })
  })

  test('reads JPEG SOF0 dimensions', () => {
    // FFD8 + SOF0 (FFC0) with height=100 width=200
    const jpeg = Buffer.from([
      0xff,
      0xd8, // SOI
      0xff,
      0xc0, // SOF0
      0x00,
      0x0b, // length
      0x08, // precision
      0x00,
      0x64, // height 100
      0x00,
      0xc8, // width 200
      0x03, // components
    ])
    expect(readImageDimensionsFromHeader(jpeg)).toEqual({
      width: 200,
      height: 100,
    })
  })

  test('reads WebP VP8X canvas size', () => {
    // RIFF....WEBP VP8X + 24-bit width-1 / height-1
    const webp = Buffer.alloc(30)
    Buffer.from('RIFF').copy(webp, 0)
    webp.writeUInt32LE(22, 4)
    Buffer.from('WEBP').copy(webp, 8)
    Buffer.from('VP8X').copy(webp, 12)
    webp.writeUInt32LE(10, 16) // chunk size
    // flags + reserved (4 bytes) then 3-byte width-1, 3-byte height-1
    webp[20] = 0
    webp[21] = 0
    webp[22] = 0
    webp[23] = 0
    // width-1 = 99 → width 100
    webp[24] = 99
    webp[25] = 0
    webp[26] = 0
    // height-1 = 49 → height 50
    webp[27] = 49
    webp[28] = 0
    webp[29] = 0
    expect(readImageDimensionsFromHeader(webp)).toEqual({
      width: 100,
      height: 50,
    })
  })

  test('returns undefined for unknown bytes', () => {
    expect(
      readImageDimensionsFromHeader(Buffer.from([0x00, 0x01, 0x02, 0x03])),
    ).toBeUndefined()
  })
})
