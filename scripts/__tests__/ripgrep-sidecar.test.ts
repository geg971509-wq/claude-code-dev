import { describe, expect, test } from 'bun:test'
import {
  allRipgrepSidecars,
  ripgrepSidecarForTarget,
} from '../ripgrep-sidecar.ts'

describe('ripgrepSidecarForTarget', () => {
  test('maps compile targets to vendor subdirs', () => {
    expect(ripgrepSidecarForTarget('linux-x64')?.subdir).toBe('x64-linux')
    expect(ripgrepSidecarForTarget('linux-x64')?.bin).toBe('rg')
    expect(ripgrepSidecarForTarget('windows-x64')?.subdir).toBe('x64-win32')
    expect(ripgrepSidecarForTarget('windows-x64')?.bin).toBe('rg.exe')
    expect(ripgrepSidecarForTarget('darwin-arm64')?.subdir).toBe('arm64-darwin')
    expect(ripgrepSidecarForTarget('darwin-x64')?.subdir).toBe('x64-darwin')
  })

  test('host win32-x64 matches windows compile layout', () => {
    expect(
      ripgrepSidecarForTarget(undefined, { platform: 'win32', arch: 'x64' }),
    ).toEqual(ripgrepSidecarForTarget('windows-x64'))
  })

  test('unknown compile target returns null', () => {
    expect(ripgrepSidecarForTarget('freebsd-x64')).toBeNull()
  })

  test('unmapped host still uses arch-platform layout', () => {
    expect(
      ripgrepSidecarForTarget(undefined, { platform: 'freebsd', arch: 'x64' }),
    ).toEqual({ subdir: 'x64-freebsd', bin: 'rg', asset: '' })
  })
})

describe('allRipgrepSidecars', () => {
  test('collapses win32-x64 onto windows-x64 and keeps one of each layout', () => {
    const sidecars = allRipgrepSidecars()
    expect(sidecars.map(s => s.subdir).sort()).toEqual([
      'arm64-darwin',
      'x64-darwin',
      'x64-linux',
      'x64-win32',
    ])
  })
})
