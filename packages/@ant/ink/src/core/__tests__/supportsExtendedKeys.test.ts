import { afterEach, describe, expect, test } from 'bun:test'
import { supportsExtendedKeys } from '../terminal.js'

const KEYS = [
  'TERM_PROGRAM',
  'TERM',
  'KITTY_WINDOW_ID',
  'GHOSTTY_RESOURCES_DIR',
  'WEZTERM_EXECUTABLE',
  'WEZTERM_UNIX_SOCKET',
  'WARP_IS_LOCAL_SHELL_SESSION',
  'ALACRITTY_SOCKET',
  'ALACRITTY_LOG',
  'KONSOLE_VERSION',
  'TMUX',
] as const

const saved: Record<string, string | undefined> = {}

function snapshotEnv(): void {
  for (const key of KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
}

function restoreEnv(): void {
  for (const key of KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = saved[key]
    }
  }
}

afterEach(restoreEnv)

describe('supportsExtendedKeys', () => {
  test('TERM_PROGRAM allowlist includes Warp', () => {
    snapshotEnv()
    process.env.TERM_PROGRAM = 'WarpTerminal'
    expect(supportsExtendedKeys()).toBe(true)
  })

  test('generic xterm-256color does not enable', () => {
    snapshotEnv()
    process.env.TERM = 'xterm-256color'
    expect(supportsExtendedKeys()).toBe(false)
  })

  test('VS Code remote / gnome-terminal stay off', () => {
    snapshotEnv()
    process.env.TERM_PROGRAM = 'vscode'
    process.env.TERM = 'xterm-256color'
    expect(supportsExtendedKeys()).toBe(false)

    snapshotEnv()
    process.env.TERM = 'xterm-256color'
    process.env.GNOME_TERMINAL_SERVICE = '1'
    expect(supportsExtendedKeys()).toBe(false)
    delete process.env.GNOME_TERMINAL_SERVICE
  })

  test('Linux kitty without TERM_PROGRAM still enables', () => {
    snapshotEnv()
    process.env.TERM = 'xterm-kitty'
    expect(supportsExtendedKeys()).toBe(true)

    snapshotEnv()
    process.env.KITTY_WINDOW_ID = '1'
    expect(supportsExtendedKeys()).toBe(true)
  })

  test('tmux nested in vscode stays off', () => {
    snapshotEnv()
    process.env.TERM_PROGRAM = 'vscode'
    process.env.TMUX = '/tmp/tmux-1000/default,1,0'
    process.env.TERM = 'tmux-256color'
    expect(supportsExtendedKeys()).toBe(false)
  })

  test('bare TMUX without TERM_PROGRAM enables', () => {
    snapshotEnv()
    process.env.TMUX = '/tmp/tmux-1000/default,1,0'
    expect(supportsExtendedKeys()).toBe(true)
  })

  test('alacritty / konsole env vars enable', () => {
    snapshotEnv()
    process.env.ALACRITTY_SOCKET = '/tmp/alacritty'
    expect(supportsExtendedKeys()).toBe(true)

    snapshotEnv()
    process.env.KONSOLE_VERSION = '240800'
    expect(supportsExtendedKeys()).toBe(true)
  })
})
