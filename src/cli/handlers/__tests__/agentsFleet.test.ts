import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgentsCommand } from './agentsFleet.runner.js'

function expectPromptExit(
  result: Awaited<ReturnType<typeof runAgentsCommand>>,
) {
  expect(result.timedOut).toBe(false)
  expect(result.durationMs).toBeLessThan(8_000)
}

describe('agents Fleet CLI contract', () => {
  test('agents --json --all prints one JSON document and exits zero', async () => {
    const result = await runAgentsCommand(['--json', '--all'])

    expectPromptExit(result)
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      partial: expect.any(Boolean),
      records: expect.any(Array),
      unavailableSources: expect.any(Array),
    })
  })

  test('agents without --json fails in a non-TTY shell', async () => {
    const result = await runAgentsCommand([])

    expectPromptExit(result)
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('agents --json')
  })

  test('agents definitions preserves the configured definitions command', async () => {
    const result = await runAgentsCommand(['definitions'])

    expectPromptExit(result)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout.length).toBeGreaterThan(0)
  })

  test.each([
    ['--state', 'sleeping'],
    ['--source', 'remote'],
  ])('rejects invalid %s values', async (flag, value) => {
    const result = await runAgentsCommand([flag, value, '--json'])

    expectPromptExit(result)
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(`option '${flag} <`)
  })

  test('launch parameters reach the selected background engine without being dropped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-launch-'))
    const calls = join(dir, 'tmux-calls.txt')
    const tmux = join(dir, 'tmux')
    await Bun.write(
      tmux,
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FLEET_TMUX_CALLS"\n',
    )
    await chmod(tmux, 0o755)

    try {
      const result = await runAgentsCommand(
        [
          '--json',
          '--cwd',
          '/tmp',
          '--add-dir',
          '/tmp/fleet-extra',
          '--agent',
          'reviewer',
          '--model',
          'sonnet',
          '--effort',
          'high',
          '--permission-mode',
          'acceptEdits',
          '--dangerously-skip-permissions',
          '--plugin-dir',
          '/tmp/fleet-plugin',
          '--mcp-config',
          '{}',
          '--strict-mcp-config',
          '--settings',
          '{}',
          '--setting-sources',
          'user,project',
        ],
        8_000,
        {
          FLEET_TMUX_CALLS: calls,
          PATH: `${dir}:${process.env.PATH ?? ''}`,
        },
      )

      expect(result.timedOut).toBe(false)
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        cwd: await realpath('/tmp'),
        engine: 'tmux',
        pid: 0,
        sessionName: expect.stringMatching(/^claude-agent-/),
      })
      const invocation = await Bun.file(calls).text()
      const normalizedInvocation = invocation.replaceAll('\\', '')
      expect(invocation).toContain('-V')
      expect(invocation).toContain('new-session -d -s claude-agent-')
      for (const flag of [
        '--add-dir /tmp/fleet-extra',
        '--agent reviewer',
        '--model sonnet',
        '--effort high',
        '--permission-mode acceptEdits',
        '--dangerously-skip-permissions',
        '--plugin-dir /tmp/fleet-plugin',
        '--mcp-config {}',
        '--strict-mcp-config',
        '--settings {}',
        '--setting-sources user,project',
      ]) {
        expect(normalizedInvocation).toContain(flag)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
