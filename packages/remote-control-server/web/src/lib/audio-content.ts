const supportedAudioMimeTypes = new Set([
  'audio/aac',
  'audio/flac',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/x-wav',
])

const strictBase64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export function isPlayableAudio(mimeType: string, data: string): boolean {
  if (
    !supportedAudioMimeTypes.has(mimeType) ||
    data.length === 0 ||
    !strictBase64.test(data)
  ) {
    return false
  }
  const header = decodeBase64Range(data, 0, Math.min(12, base64Size(data)))
  return header ? matchesMimeType(mimeType, data, header) : false
}

function base64Size(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return (data.length / 4) * 3 - padding
}

function decodeBase64Range(
  data: string,
  offset: number,
  length: number,
): Uint8Array | null {
  if (offset < 0 || length < 1 || offset + length > base64Size(data))
    return null
  const alignedOffset = offset - (offset % 3)
  const characterOffset = (alignedOffset / 3) * 4
  const skippedBytes = offset - alignedOffset
  const characterLength = Math.ceil((skippedBytes + length) / 3) * 4
  try {
    const decoded = atob(
      data.slice(characterOffset, characterOffset + characterLength),
    )
    return Uint8Array.from(
      decoded.slice(skippedBytes, skippedBytes + length),
      character => character.charCodeAt(0),
    )
  } catch {
    return null
  }
}

function hasBytes(bytes: Uint8Array, offset: number, expected: number[]) {
  return expected.every((value, index) => bytes[offset + index] === value)
}

function isId3(bytes: Uint8Array): boolean {
  return hasBytes(bytes, 0, [0x49, 0x44, 0x33])
}

function id3FrameOffset(header: Uint8Array): number | null {
  if (header.length < 10 || !isId3(header)) return null
  const sizeBytes = header.slice(6, 10)
  if (sizeBytes.some(byte => (byte & 0x80) !== 0)) return null
  const tagSize = sizeBytes.reduce((size, byte) => (size << 7) | byte, 0)
  const footerSize = header[3] === 4 && (header[5] & 0x10) !== 0 ? 10 : 0
  return 10 + tagSize + footerSize
}

function isMpegFrame(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes[0] !== 0xff || (bytes[1] & 0xe0) !== 0xe0)
    return false
  const version = (bytes[1] >> 3) & 0x03
  const layer = (bytes[1] >> 1) & 0x03
  const bitrate = (bytes[2] >> 4) & 0x0f
  const sampleRate = (bytes[2] >> 2) & 0x03
  return (
    version !== 0x01 &&
    layer !== 0x00 &&
    bitrate !== 0x00 &&
    bitrate !== 0x0f &&
    sampleRate !== 0x03
  )
}

function isAacFrame(bytes: Uint8Array): boolean {
  return (
    hasBytes(bytes, 0, [0x41, 0x44, 0x49, 0x46]) ||
    (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0)
  )
}

function matchesMimeType(
  mimeType: string,
  data: string,
  bytes: Uint8Array,
): boolean {
  if (isId3(bytes)) {
    const offset = id3FrameOffset(bytes)
    const frame = offset === null ? null : decodeBase64Range(data, offset, 4)
    if (!frame) return false
    if (mimeType === 'audio/mpeg') return isMpegFrame(frame)
    if (mimeType === 'audio/aac') return isAacFrame(frame)
    return false
  }
  switch (mimeType) {
    case 'audio/mpeg':
      return isMpegFrame(bytes)
    case 'audio/wav':
    case 'audio/x-wav':
      return (
        hasBytes(bytes, 0, [0x52, 0x49, 0x46, 0x46]) &&
        hasBytes(bytes, 8, [0x57, 0x41, 0x56, 0x45])
      )
    case 'audio/ogg':
      return hasBytes(bytes, 0, [0x4f, 0x67, 0x67, 0x53])
    case 'audio/flac':
      return hasBytes(bytes, 0, [0x66, 0x4c, 0x61, 0x43])
    case 'audio/webm':
      return hasBytes(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3])
    case 'audio/mp4':
      return hasBytes(bytes, 4, [0x66, 0x74, 0x79, 0x70])
    case 'audio/aac':
      return isAacFrame(bytes)
    default:
      return false
  }
}
