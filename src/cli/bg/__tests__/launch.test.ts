import { describe, expect, test } from 'bun:test'
import { buildShellLaunch } from '../launch.js'

describe('buildShellLaunch', () => {
  test('uses the configured POSIX shell with one command argument', () => {
    const launch = buildShellLaunch('printf "%s" "$HOME"', {
      SHELL: '/custom/sh',
    })
    if (process.platform === 'win32') {
      expect(launch.args).toEqual(['/d', '/s', '/c', 'printf "%s" "$HOME"'])
    } else {
      expect(launch.execPath).toBe('/custom/sh')
      expect(launch.args).toEqual(['-c', 'printf "%s" "$HOME"'])
      expect(launch.env.SHELL).toBe('/custom/sh')
    }
  })
})
