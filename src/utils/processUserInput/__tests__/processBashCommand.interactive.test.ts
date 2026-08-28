import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { relative, resolve } from 'path'

const PROJECT_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const RUNNER =
  './' +
  relative(
    PROJECT_ROOT,
    resolve(import.meta.dir, 'processBashCommand.interactive.runner.tsx'),
  ).replaceAll('\\', '/')

describe('processBashCommand interactive terminal', () => {
  test('does not shadow the compiled JSX runtime helper', () => {
    const source = readFileSync(
      resolve(import.meta.dir, '..', 'processBashCommand.tsx'),
      'utf8',
    )
    expect(source).not.toMatch(/\b(?:let|const|var)\s+jsx\b/)
  })

  test.skipIf(process.platform !== 'darwin')(
    'hands the TTY to the command and restores Ink input afterward',
    async () => {
      const decoder = new TextDecoder()
      let output = ''
      let extendedKeysEnabled = false
      const terminal = new Bun.Terminal({
        cols: 100,
        rows: 30,
        data(_terminal, data) {
          output += decoder.decode(data, { stream: true })
          extendedKeysEnabled =
            output.lastIndexOf('\x1b[>1u') > output.lastIndexOf('\x1b[<u')
        },
      })
      const proc = Bun.spawn(
        ['/usr/bin/script', '-q', '/dev/null', process.execPath, RUNNER],
        {
          cwd: PROJECT_ROOT,
          env: {
            ...process.env,
            NODE_ENV: 'test',
            CLAUDE_CODE_SHELL: '/bin/bash',
            TERM_PROGRAM: 'ghostty',
            TERM_PROGRAM_VERSION: '1.2.0',
          },
          terminal,
        },
      )
      const driveTimer = setInterval(() => {
        if (output.includes('BANG_DONE')) {
          if (!output.includes('SESSION_ALIVE')) terminal.write('x')
        } else if (output.includes('COMMAND_TTY_READY')) {
          if (!output.includes('COMMAND_TTY_ACK')) {
            terminal.write(`tty-ok${extendedKeysEnabled ? '\x1b[13u' : '\r'}`)
          }
        } else if (output.includes('COMMAND_STDIN_READY')) {
          if (!output.includes('COMMAND_STDIN_ACK')) {
            terminal.write(`stdin-ok${extendedKeysEnabled ? '\x1b[13u' : '\r'}`)
          }
        }
      }, 50)
      const killTimer = setTimeout(() => proc.kill(), 20_000)
      const exitCode = await proc.exited
      clearInterval(driveTimer)
      clearTimeout(killTimer)
      terminal.close()

      expect(exitCode, output.slice(-4000)).toBe(0)
      expect(output).toContain('COMMAND_STDIN_READY')
      expect(output).toContain('COMMAND_TTY_READY')
      expect(output).toContain('BANG_DONE')
      expect(output).toContain('SESSION_ALIVE')
      const beforeCommandCompleted = output.slice(
        0,
        output.indexOf('BANG_DONE'),
      )
      expect(
        beforeCommandCompleted.lastIndexOf('\x1b[>1u'),
        JSON.stringify(beforeCommandCompleted.slice(-1000)),
      ).toBeGreaterThan(beforeCommandCompleted.lastIndexOf('\x1b[<u'))
    },
    30_000,
  )
})
