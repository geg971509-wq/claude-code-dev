import { describe, expect, test } from 'bun:test'
import { isPlayableAudio } from '../lib/audio-content'

describe('isPlayableAudio', () => {
  const valid = [
    ['audio/mpeg', 'SUQzBAAAAAAAAP/7kGQ='],
    ['audio/mpeg', 'SUQzBAAAAAAAAVj/+5Bk'],
    ['audio/mpeg', '//uQZA=='],
    ['audio/wav', 'UklGRgAAAABXQVZF'],
    ['audio/x-wav', 'UklGRgAAAABXQVZF'],
    ['audio/ogg', 'T2dnUw=='],
    ['audio/flac', 'ZkxhQw=='],
    ['audio/webm', 'GkXfow=='],
    ['audio/mp4', 'AAAACGZ0eXA='],
    ['audio/aac', '//E='],
    ['audio/aac', 'QURJRg=='],
    ['audio/aac', 'SUQzBAAAAAAAAP/xUIA='],
  ] as const

  for (const [mimeType, data] of valid) {
    test(`accepts ${mimeType} with its declared container signature`, () => {
      expect(isPlayableAudio(mimeType, data)).toBe(true)
    })
  }

  test('rejects valid base64 whose signature mismatches its declared MIME type', () => {
    expect(isPlayableAudio('audio/mpeg', 'UklGRgAAAABXQVZF')).toBe(false)
    expect(isPlayableAudio('audio/wav', 'SUQzBAAAAAAAAP/7kGQ=')).toBe(false)
    expect(isPlayableAudio('audio/mpeg', '//FQgA==')).toBe(false)
    expect(isPlayableAudio('audio/aac', '//uQZA==')).toBe(false)
    expect(isPlayableAudio('audio/mpeg', 'SUQzBAAAAAAAAP/xUIA=')).toBe(false)
    expect(isPlayableAudio('audio/aac', 'SUQzBAAAAAAAAP/7kGQ=')).toBe(false)
  })

  test('rejects random, HTML, malformed, empty, and unsupported content', () => {
    expect(isPlayableAudio('audio/mpeg', 'AAECAw==')).toBe(false)
    expect(isPlayableAudio('audio/mpeg', 'SUQz')).toBe(false)
    expect(isPlayableAudio('audio/aac', 'SUQz')).toBe(false)
    expect(isPlayableAudio('audio/mpeg', 'PGh0bWw+')).toBe(false)
    expect(isPlayableAudio('audio/mpeg', 'bad base64!')).toBe(false)
    expect(isPlayableAudio('audio/mpeg', '')).toBe(false)
    expect(isPlayableAudio('audio/svg+xml', 'SUQz')).toBe(false)
  })
})
