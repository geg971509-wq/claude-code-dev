import { describe, expect, test } from 'bun:test'
import {
  ITERM2_CLIPBOARD_INSTRUCTION,
  isLocalITerm2,
  remoteITerm2ClipboardHint,
} from '../terminalSetup.js'

describe('isLocalITerm2', () => {
  test('true only on darwin iTerm with the iTerm bundle id', () => {
    expect(
      isLocalITerm2({
        osPlatform: 'darwin',
        bundleId: 'com.googlecode.iterm2',
        terminal: 'iTerm.app',
      }),
    ).toBe(true)
    expect(
      isLocalITerm2({
        osPlatform: 'darwin',
        bundleId: 'com.googlecode.iterm2',
        terminal: 'tmux',
      }),
    ).toBe(true)
    expect(
      isLocalITerm2({
        osPlatform: 'darwin',
        bundleId: 'com.googlecode.iterm2',
        terminal: 'screen',
      }),
    ).toBe(true)
    expect(
      isLocalITerm2({
        osPlatform: 'darwin',
        bundleId: 'com.googlecode.iterm2',
        terminal: null,
      }),
    ).toBe(true)
  })

  test('false when not a local iTerm session', () => {
    expect(
      isLocalITerm2({
        osPlatform: 'linux',
        bundleId: 'com.googlecode.iterm2',
        terminal: 'iTerm.app',
      }),
    ).toBe(false)
    expect(
      isLocalITerm2({
        osPlatform: 'darwin',
        bundleId: 'com.apple.Terminal',
        terminal: 'iTerm.app',
      }),
    ).toBe(false)
    expect(
      isLocalITerm2({
        osPlatform: 'darwin',
        bundleId: 'com.googlecode.iterm2',
        terminal: 'vscode',
      }),
    ).toBe(false)
    expect(
      isLocalITerm2({
        osPlatform: 'darwin',
        bundleId: undefined,
        terminal: 'iTerm.app',
      }),
    ).toBe(false)
  })
})

describe('remoteITerm2ClipboardHint', () => {
  test('empty unless LC_TERMINAL is iTerm2', () => {
    expect(remoteITerm2ClipboardHint(undefined)).toBe('')
    expect(remoteITerm2ClipboardHint('xterm')).toBe('')
  })

  test('tells SSH users where to enable AllowClipboardAccess on the local iTerm', () => {
    const hint = remoteITerm2ClipboardHint('iTerm2')
    expect(hint).toContain('/copy')
    expect(hint).toContain(ITERM2_CLIPBOARD_INSTRUCTION)
    expect(ITERM2_CLIPBOARD_INSTRUCTION).toBe(
      'iTerm2 → Settings → General → Selection → check "Applications in terminal may access clipboard"',
    )
  })
})
