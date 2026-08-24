import { describe, expect, test } from 'bun:test'
import { NATIVE_CSIU_TERMINALS, nativeCsiuDisplayName } from '../nativeCsiu.js'

describe('nativeCsiuDisplayName', () => {
  test('covers official native Shift+Enter terminals', () => {
    expect(nativeCsiuDisplayName('ghostty')).toBe('Ghostty')
    expect(nativeCsiuDisplayName('kitty')).toBe('Kitty')
    expect(nativeCsiuDisplayName('iTerm.app')).toBe('iTerm2')
    expect(nativeCsiuDisplayName('WezTerm')).toBe('WezTerm')
    expect(nativeCsiuDisplayName('WarpTerminal')).toBe('Warp')
    expect(nativeCsiuDisplayName('windows-terminal')).toBe('Windows Terminal')
  })

  test('vscode / Apple Terminal are not native CSI-u', () => {
    expect(nativeCsiuDisplayName('vscode')).toBeNull()
    expect(nativeCsiuDisplayName('Apple_Terminal')).toBeNull()
    expect(nativeCsiuDisplayName(null)).toBeNull()
  })

  test('list keys match display-name lookup', () => {
    for (const [key, name] of Object.entries(NATIVE_CSIU_TERMINALS)) {
      expect(nativeCsiuDisplayName(key)).toBe(name)
    }
  })
})
