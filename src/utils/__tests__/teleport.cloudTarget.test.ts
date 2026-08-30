import { describe, expect, test } from 'bun:test'
import { extractCloudSessionId } from '../teleport'

describe('extractCloudSessionId', () => {
  test('accepts session ids and claude.ai/code URLs but not descriptions', () => {
    expect(extractCloudSessionId('session_abc_123')).toBe('session_abc_123')
    expect(extractCloudSessionId('cse_abc_123')).toBe('cse_abc_123')
    expect(
      extractCloudSessionId('https://claude.ai/code/session_abc_123?foo=bar'),
    ).toBe('session_abc_123')
    expect(extractCloudSessionId('fix the failing test')).toBeNull()
  })
})

async function runCli(
  args: string[],
  stdin?: string,
): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawnSync(
    [Bun.which('bun') ?? process.execPath, 'src/entrypoints/cli.tsx', ...args],
    {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'development' },
      stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
    },
  )
  const decoder = new TextDecoder()
  return {
    exitCode: child.exitCode,
    output: decoder.decode(child.stdout) + decoder.decode(child.stderr),
  }
}

describe('--environment cloud conflicts', () => {
  test('rejects attaching an existing cloud session', async () => {
    const result = await runCli([
      '--environment',
      'ccpool_test',
      '--cloud',
      'session_abc',
    ])
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain(
      'Error: --environment creates a new session; it cannot be combined with --cloud <session_id|url>',
    )
  })

  test('rejects piped input when --cloud already supplies the description', async () => {
    const result = await runCli(
      ['--environment', 'ccpool_test', '--cloud', 'description', '-p'],
      'task from stdin',
    )
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain(
      'Error: --environment with --cloud <description> cannot also take a positional prompt or piped stdin.',
    )
  })
})
