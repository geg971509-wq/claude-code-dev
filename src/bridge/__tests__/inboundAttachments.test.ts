import { describe, expect, test } from 'bun:test'
import {
  extractInboundAttachments,
  materializeInboundAttachments,
  readInboundAttachmentBytes,
} from '../inboundAttachments.js'

describe('inbound peer attachments', () => {
  test('caps parsed attachments at 16', () => {
    const attachments = Array.from({ length: 20 }, (_, index) => ({
      file_uuid: `file-${index}`,
      file_name: `${index}.txt`,
    }))
    expect(
      extractInboundAttachments({ file_attachments: attachments }),
    ).toHaveLength(16)
  })

  test('rejects a chunked response as soon as it exceeds 30 MB', async () => {
    let closed = false
    const body = {
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(30 * 1024 * 1024)
        yield Buffer.of(1)
      },
      destroy() {
        closed = true
      },
    }

    expect(await readInboundAttachmentBytes(body)).toBeUndefined()
    expect(closed).toBe(true)
  })

  test('rejects an oversized content length without reading the response', async () => {
    let reads = 0
    const body = {
      async *[Symbol.asyncIterator]() {
        reads++
        yield Buffer.of(1)
      },
    }

    expect(
      await readInboundAttachmentBytes(body, 30 * 1024 * 1024 + 1),
    ).toBeUndefined()
    expect(reads).toBe(0)
  })

  test('downloads at most four attachments concurrently', async () => {
    let active = 0
    let peak = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const attachments = Array.from({ length: 8 }, (_, index) => ({
      file_uuid: `file-${index}`,
      file_name: `${index}.txt`,
    }))
    const operation = materializeInboundAttachments(attachments, {
      download: async () => {
        active++
        peak = Math.max(peak, active)
        await gate
        active--
        return Buffer.from('ok')
      },
      persist: async attachment => `/uploads/${attachment.file_name}`,
    })

    await Promise.resolve()
    expect(active).toBe(4)
    release()
    expect((await operation).paths).toHaveLength(8)
    expect(peak).toBe(4)
  })
})
