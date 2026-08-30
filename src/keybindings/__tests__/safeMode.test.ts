import { afterEach, expect, test } from 'bun:test'
import { isKeybindingCustomizationEnabled } from '../loadUserBindings.js'

const previousSafeMode = process.env.CLAUDE_CODE_SAFE_MODE

afterEach(() => {
  if (previousSafeMode === undefined) {
    delete process.env.CLAUDE_CODE_SAFE_MODE
  } else {
    process.env.CLAUDE_CODE_SAFE_MODE = previousSafeMode
  }
})

test('safe mode disables custom keybindings', () => {
  process.env.CLAUDE_CODE_SAFE_MODE = '1'
  expect(isKeybindingCustomizationEnabled()).toBe(false)
})
