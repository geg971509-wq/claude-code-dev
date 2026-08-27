export interface Base64ImageContent {
  mimeType: string
  data: string
}

const supportedImageMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])

const strictBase64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function hasBytes(bytes: Uint8Array, offset: number, expected: number[]) {
  return expected.every((value, index) => bytes[offset + index] === value)
}

function matchesMimeType(mimeType: string, bytes: Uint8Array): boolean {
  switch (mimeType) {
    case 'image/jpeg':
      return hasBytes(bytes, 0, [0xff, 0xd8, 0xff])
    case 'image/png':
      return hasBytes(
        bytes,
        0,
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      )
    case 'image/gif':
      return (
        hasBytes(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
        hasBytes(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
      )
    case 'image/webp':
      return (
        hasBytes(bytes, 0, [0x52, 0x49, 0x46, 0x46]) &&
        hasBytes(bytes, 8, [0x57, 0x45, 0x42, 0x50])
      )
    default:
      return false
  }
}

export function assertSupportedImage(image: Base64ImageContent): void {
  if (!supportedImageMimeTypes.has(image.mimeType)) {
    throw new Error(
      `Unsupported image type "${image.mimeType}". Use JPEG, PNG, GIF, or WebP.`,
    )
  }
  if (!image.data || !strictBase64.test(image.data)) {
    throw new Error('Image data must be valid base64.')
  }
  const decoded = atob(image.data)
  const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0))
  if (!matchesMimeType(image.mimeType, bytes)) {
    throw new Error(
      `Image data does not match declared MIME type "${image.mimeType}".`,
    )
  }
}
